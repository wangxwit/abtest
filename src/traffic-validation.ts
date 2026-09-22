import { layerScope, nodePath } from './traffic.ts';
import { getBucketRanges, formatBucketRanges } from './bucket-ranges.ts';
import type { AllocationSimulation, Topology } from './traffic';

export type TrafficFocus = { kind: 'domain' | 'layer'; id: string };
export type TrafficFocusExplanation = {
  status: 'reached' | 'not-reached' | 'missing' | 'error';
  title: string;
  reason: string;
  nodeName: string;
  blocker?: TrafficFocus;
};

export function trafficValidationHref(focus?: TrafficFocus | null): string {
  return focus ? `#traffic/validation/${focus.kind}/${encodeURIComponent(focus.id)}` : '#traffic/validation';
}

/** Validation has its own path; ordinary node and legacy reference routes remain untouched. */
export function parseTrafficValidationRoute(hash: string): { isValidation: boolean; focus: TrafficFocus | null; error: string | null } {
  const route = hash.replace(/^#/, ''), queryAt = route.indexOf('?');
  const path = queryAt < 0 ? route : route.slice(0, queryAt), parts = path.split('/');
  if (parts[0] !== 'traffic' || parts[1] !== 'validation') return { isValidation: false, focus: null, error: null };
  const invalid = () => ({ isValidation: true, focus: null, error: '分流验证地址无效，请重新选择关注的域或层。' });
  if (queryAt >= 0 && route.slice(queryAt + 1)) return invalid();
  if (parts.length === 2) return { isValidation: true, focus: null, error: null };
  if (parts.length !== 4 || (parts[2] !== 'domain' && parts[2] !== 'layer')) return invalid();
  try {
    const id = decodeURIComponent(parts[3]);
    if (!id || id !== id.trim()) return invalid();
    return { isValidation: true, focus: { kind: parts[2], id }, error: null };
  } catch { return invalid(); }
}

/** Explain an existing full-root result against its simulation-time topology; never allocate again. */
export function explainTrafficFocus(focus: TrafficFocus, result: AllocationSimulation, topology: Topology): TrafficFocusExplanation {
  const target = focus.kind === 'domain' ? topology.domains.find(node => node.id === focus.id) : topology.layers.find(node => node.id === focus.id);
  const nodeName = target?.name ?? focus.id;
  if (result.error) return { status: 'error', title: '本次分流未完成', reason: `${result.error} 已记录的局部轨迹不代表完整分流结果。`, nodeName };
  if (!target) return { status: 'missing', title: '关注节点不存在', reason: `用于本次模拟的拓扑中未找到${focus.kind === 'domain' ? '域' : '层'}「${focus.id}」，没有改为关注其他节点。`, nodeName };

  const path = nodePath(focus.kind, focus.id, topology);
  if (!path.length || path[0].kind !== 'domain' || path[0].id !== 'root') {
    return { status: 'missing', title: '关注节点的父路径不完整', reason: '当前拓扑缺少连接到默认域的完整父路径，无法根据本次结果解释该节点。', nodeName };
  }
  // IDs alone are insufficient: a layer visit does not mean an experiment was selected.
  const visit = (node: TrafficFocus) => result.trace.find(step => step.kind === node.kind && step.id === node.id);
  const firstMissing = path.find(node => !visit(node));
  if (!firstMissing) {
    const trace = visit(focus)!;
    return { status: 'reached', title: '已到达关注节点', nodeName,
      reason: `本次从默认域开始的完整分流已到达「${nodeName}」。到达${focus.kind === 'domain' ? '域' : '参数层'}不代表命中实验或产生曝光；关注节点不改变分流起点。轨迹记录：${trace.reason}` };
  }

  const blocker: TrafficFocus = { kind: firstMissing.kind, id: firstMissing.id };
  const prefix = firstMissing.kind === focus.kind && firstMissing.id === focus.id ? '' : `关注路径中，首个未到达的节点是「${firstMissing.name}」，因此没有继续到达「${nodeName}」。`;
  const notReached = (reason: string): TrafficFocusExplanation => ({ status: 'not-reached', title: '未到达关注节点', nodeName, blocker, reason: `${prefix}${reason}` });

  if (firstMissing.kind === 'layer') {
    const layer = topology.layers.find(node => node.id === firstMissing.id)!;
    if (layer.role !== 'routing' && !layerScope(layer.id, topology).length) {
      return notReached(`「${layer.name}」是待配置的空参数层，没有已归层参数作用域，模拟器会跳过该层，不参与分流。`);
    }
    return notReached(`当前结果没有「${layer.name}」的层访问轨迹，无法从现有记录确认更具体的原因；不能将缺少轨迹当成受众不匹配。`);
  }

  const domain = topology.domains.find(node => node.id === firstMissing.id)!;
  if (domain.parentLayerId === null) {
    const rejection = result.trace.find(step => step.kind === 'default' && step.id === 'audience-root' && step.domainId === domain.id);
    if (rejection) {
      const status = rejection.audienceStatus === 'unknown' ? '根域资格未知' : rejection.audienceStatus === 'not-match' ? '根域受众未匹配' : '根域准入未通过';
      return notReached(`${status}，因此没有进入默认域。引擎记录：${rejection.reason}`);
    }
    return notReached('当前结果没有默认域的到达轨迹，也没有根域准入判定记录，无法确认更具体原因。');
  }

  const parent = topology.layers.find(layer => layer.id === domain.parentLayerId);
  const decision = parent && result.decisions.find(item => item.layerId === parent.id && item.domainId === parent.domainId);
  if (!parent || !decision || !Number.isFinite(decision.bucket)) {
    return notReached(`当前结果缺少「${domain.name}」父层的有效分流判定记录，无法确认是桶区间还是受众条件阻止进入。`);
  }
  const ranges = getBucketRanges(domain);
  const bucket = Math.round(decision.bucket * 100);
  const rangeLabel = formatBucketRanges(ranges);
  if (!ranges.some(range => bucket >= range.start && bucket < range.end)) {
    return notReached(`父层「${parent.name}」的固定桶 #${bucket}（${decision.bucket}%）落在域「${domain.name}」的实际桶段 ${rangeLabel} 外，因此没有进入该域；不会为此换桶补量。`);
  }
  if (decision.childDomainId === domain.id) {
    return notReached(`父层记录选择了「${domain.name}」，但缺少该域的访问轨迹，无法确认实际到达。分流记录：${decision.reason}`);
  }
  // The decision's aggregate audienceStatus can be "match" for a different candidate.
  // Its reason may also be replaced after selection, so preserve the full parent trace.
  const parentTrace = visit({ kind: 'layer', id: parent.id });
  const recorded = parentTrace?.reason || decision.reason;
  const selected = parentTrace?.reason && !parentTrace.reason.includes(decision.reason) ? ` 分流记录：${decision.reason}` : '';
  return notReached(`父层「${parent.name}」的固定桶 #${bucket}（${decision.bucket}%）位于该域的实际桶段 ${rangeLabel} 内，但同桶候选判定没有选择「${domain.name}」。父层轨迹：${recorded}${selected} 未进入本域不会改投其他桶。`);
}
