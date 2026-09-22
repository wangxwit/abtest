import type { Experiment } from './data';
import { trafficToBucketCount, type BucketRange } from './bucket-ranges.ts';
import {
  audienceCondition, audienceIsEmpty, audienceSummary, combineAudiences, compareAudienceConditions,
  domainEffectiveAudience, experimentEffectiveAudience, getAudienceExpression, getAudiences,
  validateAudienceExpression, type AudienceComparison, type AudienceDefinition, type EffectiveAudience,
} from './audiences.ts';
import {
  explainAllocationConflicts, findAvailableBucketRanges, layerAudienceCapacity, layerScope, validateTopology,
  type AllocationConflict, type Topology,
} from './traffic.ts';

export type AudienceAllocationContext = { layerId: string; traffic: number };
type DraftDefinition = Pick<AudienceDefinition, 'rules' | 'expression'> & Partial<Pick<AudienceDefinition, 'name' | 'version'>>;
export type AudiencePreflightInput = {
  definition: DraftDefinition;
  topology: Topology;
  experiments: Experiment[];
  allowUniversal?: boolean;
  inheritedCondition?: EffectiveAudience;
  allocation?: AudienceAllocationContext;
};
export type AudiencePreflightError = { code: 'own-expression' | 'inheritance-empty' | 'allocation-context' | 'allocation-traffic' | 'allocation-capacity'; message: string; path?: string };
export type AudienceCatalogComparison = {
  definition: AudienceDefinition;
  condition: EffectiveAudience;
  relation: 'disjoint' | 'potential-overlap' | 'unproven';
  comparison: AudienceComparison;
};
export type AudienceAllocationCheck = {
  layerId: string; layerName: string; domainName: string; traffic: number;
  availableStart: number | null;
  bucketRanges: BucketRange[] | null;
  capacity: ReturnType<typeof layerAudienceCapacity>;
  conflicts: (AllocationConflict & { condition: EffectiveAudience; conditionSummary: string })[];
};
export type AudiencePreflight = {
  valid: boolean;
  validation: ReturnType<typeof validateAudienceExpression>;
  errors: AudiencePreflightError[];
  inheritedCondition: EffectiveAudience | null;
  ownCondition: EffectiveAudience | null;
  effectiveCondition: EffectiveAudience | null;
  catalogComparisons: AudienceCatalogComparison[];
  allocation: AudienceAllocationCheck | null;
};

/** Read-only creation check. Allocation context is resolved against the supplied current topology. */
export function audiencePreflight(input: AudiencePreflightInput): AudiencePreflight {
  const { definition, topology, experiments, allocation } = input;
  const layer = allocation ? topology.layers.find(layer => layer.id === allocation.layerId) : undefined;
  const domain = layer ? topology.domains.find(domain => domain.id === layer.domainId) : undefined;
  const inherited = allocation && domain ? domainEffectiveAudience(domain.id, topology) : allocation ? null : input.inheritedCondition ?? null;
  const validation = validateAudienceExpression(getAudienceExpression(definition), topology, { allowUniversal: input.allowUniversal });
  const errors: AudiencePreflightError[] = validation.issues.filter(issue => issue.severity === 'error').map(issue => ({ code: 'own-expression', message: issue.message, path: issue.path }));
  const result: AudiencePreflight = { valid: false, validation, errors, inheritedCondition: inherited, ownCondition: null, effectiveCondition: null, catalogComparisons: [], allocation: null };
  // Incomplete trees have no comparison conclusion, even when one entered branch happens to match.
  if (!validation.valid) return result;

  if (allocation && (!layer || !domain || !layerScope(layer.id, topology).length)) errors.push({ code: 'allocation-context', message: '当前参数层不存在或仍待配置，请返回父表单选择已配置的层。' });
  // A caller-provided ancestor snapshot must not override the live parent of an allocation layer.
  const own = audienceCondition(definition, topology);
  const effective = inherited ? combineAudiences(inherited, own) : own;
  result.ownCondition = own;
  result.effectiveCondition = effective;
  if (audienceIsEmpty(effective)) errors.push({ code: 'inheritance-empty', message: '本受众与祖先域条件的交集为空，无法用于当前配置。请修改条件或取消后调整父表单。' });

  result.catalogComparisons = getAudiences(topology).map(registered => {
    const condition = audienceCondition(registered, topology);
    const comparison = compareAudienceConditions(effective, condition);
    return { definition: registered, condition, comparison, relation: comparison.unknown ? 'unproven' : comparison.relation };
  });

  if (allocation && layer && domain && layerScope(layer.id, topology).length) {
    const requestedBuckets = trafficToBucketCount(allocation.traffic);
    const trafficValid = requestedBuckets !== null;
    if (!trafficValid) errors.push({ code: 'allocation-traffic', message: '父表单的流量须为 0.01–100%，最多保留两位小数，请取消后调整。' });
    // Existing traffic helpers accept immutable audience references. Add this draft only to a
    // temporary read model so the exact same allocator can evaluate its unsaved expression.
    const catalog = getAudiences(topology);
    let draftId = 'audience-preflight-draft';
    while (catalog.some(audience => audience.id === draftId)) draftId += '-next';
    const draft: AudienceDefinition = {
      id: draftId, familyId: draftId, name: definition.name || '待创建受众', description: '', owner: '创建预检',
      version: definition.version ?? 1, createdAt: '2000-01-01T00:00:00.000Z', rules: structuredClone(definition.rules),
      ...(definition.expression ? { expression: structuredClone(definition.expression) } : {}),
    };
    const previewTopology: Topology = { ...topology, audiences: [...catalog, draft] };
    const selection = { audienceId: draftId, audience: draft.name };
    const topologyError = validateTopology(previewTopology, experiments);
    if (topologyError) errors.push({code:'allocation-context',message:`当前层域配置无法用于分配：${topologyError}`});
    const capacity = layerAudienceCapacity(layer.id, experiments, previewTopology, selection);
    const bucketRanges = trafficValid ? findAvailableBucketRanges(layer.id, allocation.traffic, experiments, undefined, previewTopology, selection) : null;
    const availableStart = bucketRanges?.length ? bucketRanges[0].start / 100 : null;
    const conflicts = explainAllocationConflicts({ id: '', domainId: domain.id, layerId: layer.id, bucketStart: 0, traffic: 100, ...selection }, experiments, previewTopology).map(conflict => {
      const experiment = conflict.kind === 'experiment' ? experiments.find(experiment => experiment.id === conflict.id) : undefined;
      const condition = conflict.kind === 'domain' ? domainEffectiveAudience(conflict.id, topology) : experiment ? experimentEffectiveAudience(experiment, topology) : { rules: [], unknown: true, labels: ['引用不可用'] };
      return { ...conflict, condition, conditionSummary: audienceSummary(condition) };
    });
    result.allocation = { layerId: layer.id, layerName: layer.name, domainName: domain.name, traffic: allocation.traffic, availableStart, bucketRanges, capacity, conflicts };
    if (trafficValid && availableStart === null && !errors.some(error => error.code === 'inheritance-empty' || error.code === 'allocation-context')) errors.push({ code: 'allocation-capacity', message: `当前申请 ${requestedBuckets} 个桶（${allocation.traffic}%），此受众下仅可用 ${Math.round(capacity.available * 100)} 个桶。请取消后调整父表单流量或修改受众条件。` });
  }
  result.valid = errors.length === 0;
  return result;
}
