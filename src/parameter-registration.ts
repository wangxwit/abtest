import type { Experiment } from './data';
import { getTopology, parameterKeys, reserveStatuses, validateAllocation, validateTopology, type Topology } from './traffic.ts';
import { validateParameterDefinition, type NewParameterInput as ParameterDefinitionInput } from './parameter-definitions.ts';
import { getCatalog } from './service-catalog.ts';
export type NewParameterInput = ParameterDefinitionInput & { serviceId: string; tagIds: string[] };
export { registrationAssignments, planParameterLayerAssignment, type RegistrationAssignment } from './parameter-assignment.ts';

/** Registration writes only the definition and service metadata; assignment is a separate action. */
export function planParameterRegistration(input: NewParameterInput, existing: Experiment[], t?: Topology): { topology: Topology | null; error: string | null };
/** Compatibility bridge: legacy layer selections are intentionally not applied. */
export function planParameterRegistration(input: NewParameterInput, selections: Record<string, string>, existing: Experiment[], t?: Topology): { topology: Topology | null; error: string | null };
export function planParameterRegistration(input: NewParameterInput, existingOrSelections: Experiment[] | Record<string, string>, topologyOrExisting?: Topology | Experiment[], legacyTopology?: Topology): { topology: Topology | null; error: string | null } {
  const existing = Array.isArray(existingOrSelections) ? existingOrSelections : topologyOrExisting as Experiment[];
  const t = (Array.isArray(existingOrSelections) ? topologyOrExisting as Topology | undefined : legacyTopology) ?? getTopology();
  const reject = (error: string) => ({ topology: null, error });
  const definitionError = validateParameterDefinition(input);
  if (definitionError) return reject(definitionError);
  const invalid = validateTopology(t, existing);
  if (invalid) return reject(invalid);
  const catalog = getCatalog(t);
  if (typeof input.serviceId !== 'string' || !catalog.services.some(service => service.id === input.serviceId)) return reject('注册参数必须选择已登记的所属服务。');
  if (!Array.isArray(input.tagIds) || new Set(input.tagIds).size !== input.tagIds.length || input.tagIds.some(id => !catalog.tags.some(tag => tag.id === id && tag.serviceId === input.serviceId))) return reject('参数标签重复、未登记或不属于当前应用。');
  if (parameterKeys(t).includes(input.key)) return reject(`参数 ${input.key} 已注册，请使用唯一 Key。`);
  const next = structuredClone(t);
  const { serviceId, tagIds, ...definition } = input;
  next.parameters = [...(next.parameters ?? []), { ...structuredClone(definition), name: input.name.trim(), owner: input.owner.trim(), description: input.description.trim(), createdAt: new Date().toISOString() }];
  next.catalog = structuredClone(catalog);
  next.catalog.bindings.push({ key: input.key, serviceId, tagIds: [...tagIds] });
  next.pendingParameterKeys = [...(next.pendingParameterKeys ?? []), input.key];
  const topologyError = validateTopology(next, existing);
  if (topologyError) return reject(topologyError);
  for (const experiment of existing.filter(e => reserveStatuses.includes(e.status))) {
    const error = validateAllocation(experiment, existing, next);
    if (error) return reject(`${experiment.name}：${error}`);
  }
  return { topology: next, error: null };
}
