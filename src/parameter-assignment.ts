import type { Experiment } from './data';
import { childDomains, domainLayers, getTopology, isParameterPending, layerScope, nodePath, parameterKeys, reserveStatuses, validateAllocation, validateTopology, type Topology, type TrafficLayer } from './traffic.ts';

export type RegistrationAssignment = {
  domainId: string; domainName: string; path: string;
  layerId: string | null; layerName: string | null; automatic: boolean; options: TrafficLayer[]; forced?: boolean;
};
export type AssignmentPlan = { topology: Topology | null; error: string | null };

/** Each child domain of the selected layer inherits the activated key and needs a partition. */
export function registrationAssignments(selections: Record<string, string>, t: Topology = getTopology()): RegistrationAssignment[] {
  const rows: RegistrationAssignment[] = [], visited = new Set<string>();
  function visit(domainId: string) {
    if (visited.has(domainId)) return;
    visited.add(domainId);
    const domain = t.domains.find(d => d.id === domainId);
    if (!domain) return;
    const options = domainLayers(domainId, t), automatic = options.length === 1;
    const selected = automatic ? options[0] : options.find(layer => layer.id === selections[domainId]);
    rows.push({ domainId, domainName: domain.name, path: nodePath('domain', domainId, t).map(n => n.name).join(' → '),
      layerId: selected?.id ?? null, layerName: selected?.name ?? null, automatic, options });
    if (selected) childDomains(selected.id, t).forEach(child => visit(child.id));
  }
  visit('root');
  return rows;
}

/** Activate only after every inherited partition can be committed in one snapshot. */
export function planParameterLayerAssignment(key: string, selections: Record<string, string>, existing: Experiment[], t: Topology = getTopology()): AssignmentPlan {
  const reject = (error: string): AssignmentPlan => ({ topology: null, error });
  const invalid = validateTopology(t, existing); if (invalid) return reject(invalid);
  if (!parameterKeys(t).includes(key)) return reject('请先登记参数，再分配参数层。');
  if (!isParameterPending(key, t)) return reject('此参数已完成归层，不能通过首次归层入口迁移。');
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return reject('参数归层选择格式无效。');
  for (const [domainId, layerId] of Object.entries(selections)) {
    if (typeof layerId !== 'string' || (layerId && !t.layers.some(layer => layer.id === layerId && layer.domainId === domainId))) return reject('所选参数层必须属于对应域。');
  }
  const assignments = registrationAssignments(selections, t), missing = assignments.find(row => !row.layerId);
  if (missing) return reject(`请选择参数在「${missing.domainName}」中的归属层。`);
  const next = structuredClone(t);
  for (const row of assignments) {
    for (const sibling of next.layers.filter(layer => layer.domainId === row.domainId && layer.id !== row.layerId)) {
      if (sibling.parameterKeys.includes('*')) sibling.parameterKeys = layerScope(sibling.id, t);
    }
    const selected = next.layers.find(layer => layer.id === row.layerId)!;
    if (!selected.parameterKeys.includes('*')) selected.parameterKeys.push(key);
  }
  next.pendingParameterKeys = (next.pendingParameterKeys ?? []).filter(item => item !== key);
  const topologyError = validateTopology(next, existing); if (topologyError) return reject(topologyError);
  for (const experiment of existing.filter(e => reserveStatuses.includes(e.status))) {
    const error = validateAllocation(experiment, existing, next);
    if (error) return reject(`${experiment.name}：${error}`);
  }
  return { topology: next, error: null };
}
