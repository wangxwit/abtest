import type { Experiment } from './data';
import { audienceIsEmpty, getAudience } from './audiences.ts';
import { trafficToBucketCount } from './bucket-ranges.ts';
import { candidateLayerAudience, findAvailableBucketRanges, getTopology, layerAudienceCapacity, layerScope, nodePath, reserveStatuses, validateAllocation, validateTopology } from './traffic.ts';
import type { Topology, TrafficDomain, TrafficLayer } from './traffic';
import { validateResourceManagement, type ResourceManagement } from './resource-management.ts';

export type ChildDomainCreationInput = {
  id: string;
  parentLayerId: string;
  name: string;
  mode: TrafficDomain['mode'];
  traffic: number;
  audienceId?: string;
  management?: ResourceManagement;
};
export type ChildDomainCreationPlan = { ok: true; topology: Topology; domainId: string } | { ok: false; error: string };

/** Plan against one snapshot; the caller commits the complete candidate with saveTopology. */
export function planChildDomainCreation(input: ChildDomainCreationInput, experiments: Experiment[], topology: Topology = getTopology()): ChildDomainCreationPlan {
  const reject = (error: string): ChildDomainCreationPlan => ({ ok: false, error });
  const originalError = validateTopology(topology, experiments);
  if (originalError) return reject(originalError);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject('子域配置格式无效。');
  const managementError = validateResourceManagement(input.management);
  if (managementError) return reject(managementError);
  if (typeof input.name !== 'string' || !input.name.trim()) return reject('请填写子域名称。');
  const name = input.name.trim();
  if (name.length > 40) return reject('子域名称不能超过 40 个字符。');
  if (typeof input.id !== 'string' || !input.id || input.id !== input.id.trim()) return reject('子域标识不能为空，也不能包含首尾空格。');
  const initialLayerId = `${input.id}-initial`;
  const usedIds = new Set([...topology.domains, ...topology.layers, ...experiments].map(node => node.id));
  if (usedIds.has(input.id) || usedIds.has(initialLayerId)) return reject('子域或初始参数层的标识与已有域、层或实验重复。');
  if (input.mode !== 'overlapping' && input.mode !== 'non-overlapping') return reject('请选择有效的重叠或非重叠子域模式。');
  const parent = topology.layers.find(layer => layer.id === input.parentLayerId);
  if (!parent) return reject('所选父层不存在，请重新选择。');
  if (!layerScope(parent.id, topology).length) return reject('父层待配置，请先分配参数，空参数层不能创建子域。');
  const owner = topology.domains.find(domain => domain.id === parent.domainId)!;
  const isolatedAncestor = nodePath('layer', parent.id, topology).some(node => node.kind === 'domain' && topology.domains.find(domain => domain.id === node.id)?.mode === 'non-overlapping');
  if (input.mode === 'overlapping' && isolatedAncestor) return reject('祖先域为非重叠模式，后代子域必须继续使用非重叠模式。');
  const requestedBuckets = trafficToBucketCount(input.traffic);
  if (requestedBuckets === null) return reject('子域占父层流量须为 0.01–100%，最多保留两位小数。');
  if (input.audienceId !== undefined && (typeof input.audienceId !== 'string' || !getAudience(input.audienceId, topology))) return reject('所选受众版本不存在，请重新选择。');
  const selection = input.audienceId === undefined ? {} : { audienceId: input.audienceId };
  if (audienceIsEmpty(candidateLayerAudience(parent.id, selection, topology))) return reject('当前受众与祖先条件的交集为空，请更换受众版本。');
  for (const experiment of experiments.filter(item => reserveStatuses.includes(item.status))) {
    const invalid = validateAllocation(experiment, experiments, topology);
    if (invalid) return reject(`${experiment.name}：${invalid}`);
  }
  const bucketRanges = findAvailableBucketRanges(parent.id, input.traffic, experiments, undefined, topology, selection);
  if (bucketRanges === null) {
    const available = Math.round(layerAudienceCapacity(parent.id, experiments, topology, selection).available * 100);
    return reject(`申请 ${requestedBuckets} 桶，当前有效受众下可用 ${available} 桶，容量不足。仅条件可证明互斥时，才允许共享桶坐标。`);
  }
  const start = bucketRanges[0].start / 100;
  const domain: TrafficDomain = {
    id: input.id, name, parentLayerId: parent.id, mode: input.mode, traffic: input.traffic, start, bucketRanges, unit: owner.unit, ...selection,
    description: input.mode === 'overlapping' ? '完整继承父层参数，后续可在本域新增参数层。' : '完整继承父层参数，当前分支中的实验保持互斥。',
    ...(input.management === undefined ? {} : { management: { ...structuredClone(input.management), owner: input.management.owner.trim() } }),
  };
  const initialLayer: TrafficLayer = {
    id: initialLayerId, domainId: domain.id, name: '初始参数层', role: 'normal', parameterKeys: ['*'], description: '创建子域时自动生成的参数承接层。',
    ...(domain.management === undefined ? {} : { management: structuredClone(domain.management) }),
  };
  const next = structuredClone(topology);
  next.domains.push(domain);
  next.layers.push(initialLayer);
  const invalid = validateTopology(next, experiments);
  return invalid ? reject(invalid) : { ok: true, topology: next, domainId: domain.id };
}
