import type { Experiment } from './data';
import type { Topology } from './traffic';

export type ServiceEnvironment = { name: 'development' | 'staging' | 'production'; mode: 'direct' | 'delegated'; decisionServiceId?: string };
export type ServiceDefinition = { id: string; name: string; owner: string; type: 'frontend' | 'backend' | 'strategy' | 'gateway'; description: string; createdAt: string; environments: ServiceEnvironment[] };
export type LegacyParameterTag = { id: string; name: string; color: string };
export type ParameterTag = LegacyParameterTag & { serviceId: string };
export type ParameterBinding = { key: string; serviceId: string | null; tagIds: string[]; pendingTagIds?: string[] };
export type ServiceCatalog = { schemaVersion: 2; services: ServiceDefinition[]; tags: ParameterTag[]; bindings: ParameterBinding[]; legacyTags?: LegacyParameterTag[] };
type LegacyServiceCatalog = { services: ServiceDefinition[]; tags: LegacyParameterTag[]; bindings: ParameterBinding[] };
export type CatalogPlan = { topology: Topology | null; error: string | null };
export const serviceEnvironmentNames = ['development', 'staging', 'production'] as const;
const serviceTypes = ['frontend', 'backend', 'strategy', 'gateway'];
const seedDate = '2026-09-12T00:00:00.000Z';
const defaultEnvironments = (): ServiceEnvironment[] => serviceEnvironmentNames.map(name => ({ name, mode: 'direct' }));
const builtInOwners: Record<string, string> = {
  'ui.layout': 'ui-web', 'ui.onboarding': 'ui-web', 'ui.cart': 'ui-web', 'ui.membership': 'ui-web', 'ui.content_card': 'ui-web',
  'ranking.model': 'ranking-service', 'ranking.search': 'ranking-service', 'ranking.recall': 'ranking-service', 'ranking.longtail': 'ranking-service',
  'checkout.cache_ttl': 'checkout-service', 'checkout.parallel': 'checkout-service', 'checkout.inventory': 'checkout-service', 'pricing.coupon': 'pricing-service',
};
const seedServices: ServiceDefinition[] = [
  { id: 'ui-web', name: '用户界面服务', type: 'frontend', owner: '前端体验组', description: '页面布局、卡片和交互参数。', createdAt: seedDate, environments: defaultEnvironments() },
  { id: 'ranking-service', name: '推荐排序服务', type: 'strategy', owner: '推荐算法组', description: '推荐、检索和召回参数。', createdAt: seedDate, environments: defaultEnvironments() },
  { id: 'checkout-service', name: '交易服务', type: 'backend', owner: '交易研发组', description: '交易计算、库存和缓存参数。', createdAt: seedDate, environments: defaultEnvironments() },
  { id: 'pricing-service', name: '优惠策略服务', type: 'strategy', owner: '商业策略组', description: '优惠与定价策略参数。', createdAt: seedDate, environments: defaultEnvironments() },
];
const seedTags: LegacyParameterTag[] = [
  { id: 'homepage-recommendation', name: '首页推荐', color: 'purple' },
  { id: 'transaction-experience', name: '交易体验', color: 'blue' },
  { id: 'performance', name: '性能优化', color: 'green' },
];
const seedTagKeys: Record<string, string[]> = {
  'homepage-recommendation': ['ui.layout', 'ui.content_card', 'ranking.model', 'ranking.recall'],
  'transaction-experience': ['ui.cart', 'checkout.parallel', 'checkout.inventory', 'pricing.coupon'],
  performance: ['checkout.cache_ttl', 'checkout.parallel', 'ranking.search'],
};
const registeredKeys = (t: Topology) => [...Object.keys(builtInOwners), ...(t.parameters ?? []).map(p => p.key)];

/** Legacy snapshots receive explicit built-in examples. Unknown custom keys remain unassigned. */
export function getCatalog(t: Topology): ServiceCatalog {
  if (t.catalog !== undefined) return t.catalog;
  return privateCatalog({ services: structuredClone(seedServices), tags: structuredClone(seedTags), bindings: registeredKeys(t).map(key => ({
    key, serviceId: builtInOwners[key] ?? null, tagIds: seedTags.filter(tag => seedTagKeys[tag.id].includes(key)).map(tag => tag.id),
  })) });
}
export const getParameterBinding = (key: string, t: Topology): ParameterBinding | undefined => getCatalog(t).bindings.find(binding => binding.key === key);
export const getParameterService = (key: string, t: Topology): ServiceDefinition | undefined => {
  const catalog = getCatalog(t), serviceId = catalog.bindings.find(binding => binding.key === key)?.serviceId;
  return catalog.services.find(service => service.id === serviceId);
};
export const getParameterTags = (key: string, t: Topology): ParameterTag[] => {
  const catalog = getCatalog(t), binding = catalog.bindings.find(binding => binding.key === key);
  return binding?.serviceId ? catalog.tags.filter(tag => tag.serviceId === binding.serviceId && binding.tagIds.includes(tag.id)) : [];
};
export const getServiceTags = (serviceId: string, t: Topology): ParameterTag[] => getCatalog(t).tags.filter(tag => tag.serviceId === serviceId);
export const experimentServices = (experiment: Pick<Experiment, 'parameterKeys'>, t: Topology): ServiceDefinition[] => {
  const catalog = getCatalog(t), ids = new Set(catalog.bindings.filter(binding => experiment.parameterKeys.includes(binding.key)).map(binding => binding.serviceId));
  return catalog.services.filter(service => ids.has(service.id));
};
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value: object, fields: string[]) => Object.keys(value).every(key => fields.includes(key));
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value);
const validText = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && value === value.trim();
const unique = (values: unknown[]) => new Set(values).size === values.length;
const normalizedName = (name: string) => name.trim().toLowerCase();
const tagColorValid = (color: unknown) => typeof color === 'string' && (['green', 'blue', 'purple', 'orange', 'gray'].includes(color) || /^#[0-9a-fA-F]{6}$/.test(color));
function tagIdFor(serviceId: string, name: string, existing: ParameterTag[]): string {
  let hash = 2166136261;
  for (const character of `${serviceId}\u0000${normalizedName(name)}`) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  const prefix = `tag-${(hash >>> 0).toString(36)}`;
  let id = prefix, suffix = 0;
  while (existing.some(tag => tag.id === id)) id = `${prefix}-${++suffix}`;
  return id;
}
function ensurePrivateTag(catalog: ServiceCatalog, serviceId: string, source: LegacyParameterTag): ParameterTag {
  const existing = catalog.tags.find(tag => tag.serviceId === serviceId && normalizedName(tag.name) === normalizedName(source.name));
  if (existing) return existing;
  const created = { id: tagIdFor(serviceId, source.name, catalog.tags), serviceId, name: source.name, color: source.color };
  catalog.tags.push(created);
  return created;
}
function privateCatalog(legacy: LegacyServiceCatalog): ServiceCatalog {
  const result: ServiceCatalog = { schemaVersion: 2, services: structuredClone(legacy.services), tags: [], bindings: [], legacyTags: structuredClone(legacy.tags) };
  const copies = new Map<string, string>();
  // Sorting makes collision resolution stable even if an old snapshot's arrays were reordered.
  for (const service of [...legacy.services].sort((a, b) => a.id.localeCompare(b.id))) {
    const used = new Set(legacy.bindings.filter(binding => binding.serviceId === service.id).flatMap(binding => binding.tagIds));
    for (const tag of [...legacy.tags].sort((a, b) => a.id.localeCompare(b.id)).filter(tag => used.has(tag.id))) copies.set(`${service.id}\u0000${tag.id}`, ensurePrivateTag(result, service.id, tag).id);
  }
  result.bindings = legacy.bindings.map(binding => binding.serviceId === null
    ? { key: binding.key, serviceId: null, tagIds: [], ...(binding.tagIds.length ? { pendingTagIds: [...binding.tagIds] } : {}) }
    : { key: binding.key, serviceId: binding.serviceId, tagIds: binding.tagIds.map(id => copies.get(`${binding.serviceId}\u0000${id}`)!) });
  return result;
}

/** No runtime readiness or heartbeat fields exist in this local configuration catalog. */
export function validateServiceCatalog(t: Topology): string | null {
  return validateCatalog(t, false);
}
function validateCatalog(t: Topology, legacy: boolean): string | null {
  if (t.catalog === undefined) return null;
  const catalog = t.catalog;
  if (!plainObject(catalog) || !exactFields(catalog, legacy ? ['services', 'tags', 'bindings'] : ['schemaVersion', 'services', 'tags', 'bindings', 'legacyTags']) || (!legacy && catalog.schemaVersion !== 2) || !Array.isArray(catalog.services) || !Array.isArray(catalog.tags) || !Array.isArray(catalog.bindings)) return '服务与标签目录格式或版本无效。';
  for (const service of catalog.services) {
    if (!plainObject(service) || !exactFields(service, ['id', 'name', 'owner', 'type', 'description', 'createdAt', 'environments']) || !validId(service.id) || !validText(service.name, 60) || !validText(service.owner, 60) || !serviceTypes.includes(service.type) || typeof service.description !== 'string' || service.description.length > 300 || typeof service.createdAt !== 'string' || !Number.isFinite(Date.parse(service.createdAt))) return '服务标识、名称、负责人或类型无效；不能保存未经验证的运行状态。';
    if (!Array.isArray(service.environments) || service.environments.length !== serviceEnvironmentNames.length || !unique(service.environments.map(environment => environment?.name))) return `${service.name} 需要开发、测试、生产三个独立且不重复的环境。`;
    for (const environment of service.environments) {
      if (!plainObject(environment) || !exactFields(environment, ['name', 'mode', 'decisionServiceId']) || !serviceEnvironmentNames.includes(environment.name) || !['direct', 'delegated'].includes(environment.mode)) return `${service.name} 的环境接入配置无效；运行状态必须由真实接入验证。`;
      if (environment.mode === 'direct' && environment.decisionServiceId !== undefined) return '直接接入环境不能同时指定决策网关。';
      if (environment.mode === 'delegated' && (typeof environment.decisionServiceId !== 'string' || environment.decisionServiceId === service.id)) return '委托接入必须选择其他决策网关，不能指向自身。';
    }
  }
  if (!unique(catalog.services.map(service => service.id)) || !unique(catalog.services.map(service => service.name.toLocaleLowerCase()))) return '服务标识和名称不能重复。';
  for (const service of catalog.services) for (const environment of service.environments) {
    const visited = new Set([service.id]);
    let cursor = environment;
    while (cursor.mode === 'delegated') {
      const gateway = catalog.services.find(item => item.id === cursor.decisionServiceId);
      if (!gateway || gateway.type !== 'gateway') return '委托接入必须引用已登记的网关 / BFF 服务。';
      if (visited.has(gateway.id)) return '同一环境的决策委托关系不能形成环。';
      visited.add(gateway.id);
      const target = gateway.environments.find(item => item.name === environment.name);
      if (!target) return '决策网关缺少对应环境，不能跨环境委托。';
      cursor = target;
    }
  }
  for (const tag of catalog.tags) {
    if (!plainObject(tag) || !exactFields(tag, legacy ? ['id', 'name', 'color'] : ['id', 'name', 'color', 'serviceId']) || !validId(tag.id) || !validText(tag.name, 30) || !tagColorValid(tag.color)) return '标签需要有效标识、1–30 字名称和有效颜色。';
    if (!legacy && !catalog.services.some(service => service.id === tag.serviceId)) return '每个标签必须属于已登记的应用。';
  }
  if (!unique(catalog.tags.map(tag => tag.id)) || !unique(catalog.tags.map(tag => `${legacy ? '' : tag.serviceId}\u0000${normalizedName(tag.name)}`))) return '标签标识必须唯一，同一应用内的标签名称不能重复。';
  if (!legacy && catalog.legacyTags !== undefined) {
    if (!Array.isArray(catalog.legacyTags) || catalog.legacyTags.some(tag => !plainObject(tag) || !exactFields(tag, ['id', 'name', 'color']) || !validId(tag.id) || !validText(tag.name, 30) || !tagColorValid(tag.color)) || !unique(catalog.legacyTags.map(tag => tag.id))) return '历史共享标签归档格式无效。';
  }
  const keys = registeredKeys(t);
  for (const binding of catalog.bindings) {
    if (!plainObject(binding) || !exactFields(binding, legacy ? ['key', 'serviceId', 'tagIds'] : ['key', 'serviceId', 'tagIds', 'pendingTagIds']) || !keys.includes(binding.key)) return '参数绑定必须引用已注册的参数。';
    if (binding.serviceId !== null && !catalog.services.some(service => service.id === binding.serviceId)) return `参数 ${binding.key} 引用了不存在的服务。`;
    if (!Array.isArray(binding.tagIds) || !unique(binding.tagIds) || binding.tagIds.some(id => !catalog.tags.some(tag => tag.id === id))) return `参数 ${binding.key} 的标签重复或不存在。`;
    if (!legacy && binding.tagIds.some(id => catalog.tags.find(tag => tag.id === id)?.serviceId !== binding.serviceId)) return `参数 ${binding.key} 不能引用其他应用的标签。`;
    if (!legacy && binding.pendingTagIds !== undefined && (!Array.isArray(binding.pendingTagIds) || !unique(binding.pendingTagIds) || binding.serviceId !== null || binding.pendingTagIds.some(id => !catalog.legacyTags?.some(tag => tag.id === id)))) return `参数 ${binding.key} 的历史待认领标签无效。`;
  }
  if (!unique(catalog.bindings.map(binding => binding.key))) return '一个参数只能有一条服务归属绑定。';
  if (keys.some(key => !catalog.bindings.some(binding => binding.key === key))) return '所有已注册参数都需要服务绑定；历史未分配参数请明确保留待归属。';
  return null;
}

/** Only this explicit load boundary recognizes the exact pre-versioned shared-tag schema. */
export function migrateServiceCatalog(t: Topology): CatalogPlan & { migrated: boolean } {
  if (!t || typeof t !== 'object') return { topology: null, error: '保存的层域配置格式无效。', migrated: false };
  if (!Array.isArray(t.domains) || !Array.isArray(t.layers) || (t.parameters !== undefined && (!Array.isArray(t.parameters) || t.parameters.some(parameter => !plainObject(parameter) || typeof parameter.key !== 'string')))) return { topology: null, error: '保存的层域或参数目录格式无效。', migrated: false };
  if (t.catalog === undefined) return { topology: structuredClone(t), error: null, migrated: false };
  if (t.catalog?.schemaVersion === 2) {
    const error = validateServiceCatalog(t);
    return { topology: error ? null : structuredClone(t), error, migrated: false };
  }
  const invalid = validateCatalog(t, true);
  if (invalid) return { topology: null, error: invalid, migrated: false };
  const topology = structuredClone(t);
  topology.catalog = privateCatalog(t.catalog as unknown as LegacyServiceCatalog);
  const error = validateServiceCatalog(topology);
  return { topology: error ? null : topology, error, migrated: !error };
}

export function validateCatalogTransition(previous: Topology, next: Topology): string | null {
  const before = getCatalog(previous), after = getCatalog(next);
  for (const tag of before.tags) {
    const current = after.tags.find(item => item.id === tag.id);
    if (!current || current.serviceId !== tag.serviceId) return '已有标签不能删除或迁移到其他应用，请保留标签的应用归属。';
  }
  for (const tag of before.legacyTags ?? []) if (JSON.stringify(after.legacyTags?.find(item => item.id === tag.id)) !== JSON.stringify(tag)) return '历史共享标签归档必须完整保留，不能删除或修改。';
  for (const binding of before.bindings.filter(item => item.pendingTagIds?.length)) {
    const current = after.bindings.find(item => item.key === binding.key);
    if (!current) return '历史待认领标签必须保留。';
    if (current.serviceId === null) {
      if (JSON.stringify(current.pendingTagIds) !== JSON.stringify(binding.pendingTagIds)) return '未归属参数的历史标签不能在认领前删除。';
    } else for (const id of binding.pendingTagIds!) {
      const source = before.legacyTags!.find(tag => tag.id === id)!;
      if (!after.tags.some(tag => tag.serviceId === current.serviceId && normalizedName(tag.name) === normalizedName(source.name) && current.tagIds.includes(tag.id))) return '参数认领必须完整转换其历史标签。';
    }
  }
  return null;
}

const reject = (error: string): CatalogPlan => ({ topology: null, error });
function editable(t: Topology): { topology: Topology; catalog: ServiceCatalog } {
  const topology = structuredClone(t);
  topology.catalog = structuredClone(getCatalog(t));
  return { topology, catalog: topology.catalog };
}
const finish = (topology: Topology): CatalogPlan => {
  const error = validateServiceCatalog(topology);
  return error ? reject(error) : { topology, error: null };
};
export function planServiceRegistration(input: Pick<ServiceDefinition, 'id' | 'name' | 'owner' | 'type' | 'description'>, t: Topology): CatalogPlan {
  const invalid = validateServiceCatalog(t); if (invalid) return reject(invalid);
  if (!input || typeof input.id !== 'string' || typeof input.name !== 'string' || typeof input.owner !== 'string' || typeof input.description !== 'string') return reject('请填写服务标识、名称、负责人和说明。');
  const { topology, catalog } = editable(t);
  catalog.services.push({ id: input.id.trim(), name: input.name.trim(), owner: input.owner.trim(), type: input.type, description: input.description.trim(), createdAt: new Date().toISOString(), environments: defaultEnvironments() });
  return finish(topology);
}
export function planServiceEnvironment(serviceId: string, environment: ServiceEnvironment, t: Topology): CatalogPlan {
  const invalid = validateServiceCatalog(t); if (invalid) return reject(invalid);
  if (!environment || !serviceEnvironmentNames.includes(environment.name)) return reject('请选择有效的接入环境。');
  const { topology, catalog } = editable(t), service = catalog.services.find(item => item.id === serviceId);
  if (!service) return reject('所选服务不存在。');
  service.environments = service.environments.map(item => item.name === environment.name ? structuredClone(environment) : item);
  return finish(topology);
}
export function planTagCreate(serviceId: string, name: string, color: string, t: Topology): CatalogPlan & { tagId?: string } {
  const invalid = validateServiceCatalog(t); if (invalid) return reject(invalid);
  if (typeof name !== 'string' || typeof color !== 'string') return reject('请填写标签名称和颜色。');
  const { topology, catalog } = editable(t), trimmed = name.trim();
  if (!catalog.services.some(service => service.id === serviceId)) return reject('请在已登记的应用中创建标签。');
  const tagId = tagIdFor(serviceId, trimmed, catalog.tags);
  catalog.tags.push({ id: tagId, serviceId, name: trimmed, color });
  const result = finish(topology);
  return result.error ? result : { ...result, tagId };
}
export function planParameterTags(keys: string[], tagIds: string[], mode: 'add' | 'remove' | 'replace', t: Topology): CatalogPlan {
  const invalid = validateServiceCatalog(t); if (invalid) return reject(invalid);
  if (!Array.isArray(keys) || !keys.length || !unique(keys) || !Array.isArray(tagIds) || !unique(tagIds) || !['add', 'remove', 'replace'].includes(mode)) return reject('请选择不重复的参数与标签，并指定有效的标签操作。');
  const { topology, catalog } = editable(t);
  if (keys.some(key => !catalog.bindings.some(binding => binding.key === key))) return reject('批量标签操作包含未注册参数。');
  const owners = new Set(catalog.bindings.filter(binding => keys.includes(binding.key)).map(binding => binding.serviceId));
  if (owners.size !== 1 || owners.has(null)) return reject('标签批量操作只能包含同一已归属应用的参数。');
  const serviceId = [...owners][0];
  if (tagIds.some(id => !catalog.tags.some(tag => tag.id === id && tag.serviceId === serviceId))) return reject('所选标签不存在或不属于当前应用。');
  for (const binding of catalog.bindings.filter(item => keys.includes(item.key))) binding.tagIds = mode === 'replace' ? [...tagIds] : mode === 'add' ? [...new Set([...binding.tagIds, ...tagIds])] : binding.tagIds.filter(id => !tagIds.includes(id));
  return finish(topology);
}
export function planParameterService(key: string, serviceId: string, t: Topology): CatalogPlan {
  const invalid = validateServiceCatalog(t); if (invalid) return reject(invalid);
  const { topology, catalog } = editable(t), binding = catalog.bindings.find(item => item.key === key);
  if (!binding) return reject('所选参数尚未注册。');
  if (!catalog.services.some(service => service.id === serviceId)) return reject('请选择已登记的所属服务。');
  if (binding.serviceId !== null && binding.serviceId !== serviceId) return reject('已明确的参数所属服务不能直接迁移；此入口仅用于补齐历史待归属参数。');
  for (const id of binding.pendingTagIds ?? []) {
    const source = catalog.legacyTags!.find(tag => tag.id === id)!;
    const tag = ensurePrivateTag(catalog, serviceId, source);
    if (!binding.tagIds.includes(tag.id)) binding.tagIds.push(tag.id);
  }
  delete binding.pendingTagIds;
  binding.serviceId = serviceId;
  return finish(topology);
}
