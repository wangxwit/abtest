import type { Experiment } from './data';
import type { Topology } from './traffic';
import { defaultProfileAttributes, getProfileAttributes, isSafeProfileKey, profileValueIsValid, validateProfileAttributeCatalog, type ProfileAttribute } from './profile-attributes.ts';

export type AudienceField = string;
export type AudienceRule = { field: AudienceField; op: 'eq' | 'in' | 'lte' | 'gte'; value: string | string[] | number | boolean };
export type AudienceExpression = { kind: 'rule'; rule: AudienceRule } | { kind: 'group'; operator: 'and' | 'or'; children: AudienceExpression[] };
export type AudienceDefinition = { id: string; familyId: string; name: string; description: string; owner: string; version: number; rules: AudienceRule[]; expression?: AudienceExpression; createdAt: string };
/** Values are a fixed admission snapshot for this user_id, not live request attributes. */
export type AudienceProfile = Record<string, string | number | boolean | undefined>;
export type AudienceSelection = { audienceId?: string; audience?: string };
export type EffectiveAudience = { rules: AudienceRule[]; unknown: boolean; labels: string[]; expression?: AudienceExpression; attributes?: ProfileAttribute[] };
export type AudienceIssue = { path: string; code: string; message: string; severity: 'error' | 'warning' };
export type AudienceConflictEvidence = { field: string; label: string; reason: string };
export type AudienceComparison = { relation: 'disjoint' | 'potential-overlap'; reason: string; witness?: AudienceProfile; conflicts: AudienceConflictEvidence[]; unknown: boolean };
export type AudienceEvaluation = { status: 'match' | 'not-match' | 'unknown'; reason: string };
export const audienceFields: { key: AudienceField; label: string; type: 'enum' | 'boolean' | 'number'; values?: string[] }[] = [
  { key: 'country', label: '国家 / 地区代码', type: 'enum', values: ['CN', 'US', 'JP', 'SG', 'GB'] },
  { key: 'platform', label: '入组平台', type: 'enum', values: ['iOS', 'Android', 'Web'] },
  { key: 'is_member', label: '入组时是否会员', type: 'boolean' },
  { key: 'registration_days', label: '入组时注册天数', type: 'number' },
  { key: 'spend_30d', label: '入组前 30 天消费', type: 'number' },
  { key: 'last_active_days', label: '入组时距上次活跃天数', type: 'number' },
];
const createdAt = '2026-09-12T00:00:00.000Z';
const seed = (id: string, name: string, rules: AudienceRule[], description: string): AudienceDefinition => ({ id, familyId: id.replace(/-v1$/, ''), name, rules, description, owner: '平台示例', version: 1, createdAt });
export const defaultAudiences: AudienceDefinition[] = [
  seed('all-users-v1', '全部活跃用户', [], '继承工作空间基础资格；保留原型既有全部活跃用户示例行为。'),
  seed('new-users-v1', '新注册用户', [{ field: 'registration_days', op: 'lte', value: 7 }], '固定入组画像中注册不超过 7 天。'),
  seed('returning-users-v1', '老用户', [{ field: 'registration_days', op: 'gte', value: 8 }], '固定入组画像中注册至少 8 天。'),
  seed('high-value-members-v1', '高价值会员', [{ field: 'is_member', op: 'eq', value: true }, { field: 'spend_30d', op: 'gte', value: 500 }], '入组时为会员且入组前 30 天消费至少 500。'),
  seed('mobile-users-v1', '移动端用户', [{ field: 'platform', op: 'in', value: ['iOS', 'Android'] }], '固定入组平台为 iOS 或 Android。'),
];
export const getAudienceCatalog = (t: Topology): AudienceDefinition[] => t.audiences ?? structuredClone(defaultAudiences);
export const getAudiences = getAudienceCatalog;
export const getAudienceById = (id: string, t: Topology) => getAudienceCatalog(t).find(item => item.id === id);
export const getAudience = getAudienceById;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const attributesFor = (t?: Topology): ProfileAttribute[] => { const attributes = t ? getProfileAttributes(t) : defaultProfileAttributes; return Array.isArray(attributes) ? attributes : []; };
const attributeFor = (field: string, attributes: ProfileAttribute[] = defaultProfileAttributes) => attributes.find(attribute => attribute.key === field);
const allExpression = (): AudienceExpression => ({ kind: 'group', operator: 'and', children: [] });
export function getAudienceExpression(definition: Pick<AudienceDefinition, 'rules' | 'expression'>): AudienceExpression {
  if (definition.expression !== undefined) return definition.expression;
  return Array.isArray(definition.rules) ? { kind: 'group', operator: 'and', children: definition.rules.map(rule => ({ kind: 'rule', rule })) } : { kind: 'rule', rule: { field: '', op: 'eq', value: '' } };
}
function ruleError(rule: unknown, attributes: ProfileAttribute[]): string | null {
  if (!plain(rule) || Object.keys(rule).some(key => !['field', 'op', 'value'].includes(key))) return '受众条件格式无效。';
  const field = typeof rule.field === 'string' && isSafeProfileKey(rule.field) ? attributeFor(rule.field, attributes) : undefined;
  if (!field) return '受众条件引用了未登记或不安全的画像属性。';
  if (field.type === 'number') {
    if (!['eq', 'gte', 'lte'].includes(rule.op as string) || !profileValueIsValid(field, rule.value)) return '数值受众条件需要非负有限数；整数属性不接受小数。';
  } else if (field.type === 'boolean') {
    if (rule.op !== 'eq' || typeof rule.value !== 'boolean') return '布尔条件必须使用等于 true 或 false。';
  } else if (rule.op === 'eq') {
    if (!text(rule.value) || (rule.value as string).trim() !== rule.value || !profileValueIsValid(field, rule.value)) return '文本或枚举条件需要有效的非空取值；自定义枚举须在目录集合中。';
  } else if (rule.op === 'in') {
    if (!Array.isArray(rule.value) || !rule.value.length || rule.value.some(value => !text(value) || value.trim() !== value || !profileValueIsValid(field, value)) || new Set(rule.value).size !== rule.value.length) return 'IN 条件需要不重复的有效非空取值集合。';
  } else return '文本或枚举属性仅支持等于或属于集合。';
  return null;
}
type Constraint = { enumValues?: Set<string | boolean>; minimum?: number; maximum?: number };
function constraints(rules: AudienceRule[], attributes: ProfileAttribute[]): Map<string, Constraint> {
  const result = new Map<string, Constraint>();
  for (const rule of rules) {
    const existing = result.get(rule.field) ?? {}, kind = attributeFor(rule.field, attributes)?.type;
    if (kind === 'number') {
      const value = rule.value as number;
      if (rule.op === 'gte' || rule.op === 'eq') existing.minimum = Math.max(existing.minimum ?? 0, value);
      if (rule.op === 'lte' || rule.op === 'eq') existing.maximum = Math.min(existing.maximum ?? Infinity, value);
    } else {
      const values = new Set<string | boolean>(rule.op === 'in' ? rule.value as string[] : [rule.value as string | boolean]);
      existing.enumValues = existing.enumValues ? new Set([...existing.enumValues].filter(value => values.has(value))) : values;
    }
    result.set(rule.field, existing);
  }
  return result;
}
function contradiction(rules: AudienceRule[], attributes: ProfileAttribute[]): string | undefined {
  for (const [field, constraint] of constraints(rules, attributes)) {
    const minimum = attributeFor(field, attributes)?.integer ? Math.ceil(constraint.minimum ?? 0) : constraint.minimum ?? 0;
    if (constraint.enumValues?.size === 0 || minimum > (constraint.maximum ?? Infinity)) return field;
  }
  return undefined;
}
type DNF = { clauses: AudienceRule[][]; limited: boolean; unknown: boolean };
const DNF_LIMIT = 64;
function toDNF(expression: AudienceExpression, attributes: ProfileAttribute[], budget = { nodes: 0 }, depth = 0): DNF {
  if (++budget.nodes > 4096 || depth > 100) return { clauses: [], limited: true, unknown: false };
  if (!expression || typeof expression !== 'object') return { clauses: [], limited: false, unknown: true };
  if (expression.kind === 'rule') return ruleError(expression.rule, attributes) ? { clauses: [], limited: false, unknown: true } : { clauses: [[expression.rule]], limited: false, unknown: false };
  if (expression.kind !== 'group' || !['and', 'or'].includes(expression.operator) || !Array.isArray(expression.children)) return { clauses: [], limited: false, unknown: true };
  if (expression.operator === 'or' && !expression.children.length) return { clauses: [], limited: false, unknown: true };
  let clauses: AudienceRule[][] = expression.operator === 'and' ? [[]] : [], unknown = false;
  for (const child of expression.children) {
    const part = toDNF(child, attributes, budget, depth + 1); unknown ||= part.unknown;
    if (part.limited) return { clauses: [], limited: true, unknown };
    if (expression.operator === 'or') {
      if (clauses.length + part.clauses.length > DNF_LIMIT) return { clauses: [], limited: true, unknown };
      clauses.push(...part.clauses);
    } else {
      if (clauses.length * part.clauses.length > DNF_LIMIT) return { clauses: [], limited: true, unknown };
      clauses = clauses.flatMap(left => part.clauses.map(right => [...left, ...right])).filter(clause => !contradiction(clause, attributes));
    }
  }
  return { clauses, limited: false, unknown };
}
export function validateAudienceExpression(expression: unknown, t?: Topology, options: { allowUniversal?: boolean } = {}): { valid: boolean; issues: AudienceIssue[]; ruleCount: number; proofLimited: boolean } {
  const issues: AudienceIssue[] = [], attributes = attributesFor(t), groups: { expression: AudienceExpression; path: string }[] = [];
  const active = new Set<object>(); let ruleCount = 0, nodes = 0;
  const error = (path: string, code: string, message: string) => issues.push({ path, code, message, severity: 'error' });
  function visit(node: unknown, path: string, groupDepth: number) {
    if (++nodes > 200) { if (nodes === 201) error(path, 'complexity', '条件树节点过多。'); return; }
    if (!plain(node) || active.has(node)) { error(path, 'structure', '条件树结构无效或形成环。'); return; }
    active.add(node);
    if (node.kind === 'rule') {
      ruleCount++; const message = ruleError(node.rule, attributes);
      if (Object.keys(node).some(key => !['kind', 'rule'].includes(key))) error(path, 'structure', '规则节点含不支持的字段。');
      if (message) error(path, 'rule', message);
    } else if (node.kind === 'group') {
      if (Object.keys(node).some(key => !['kind', 'operator', 'children'].includes(key)) || !['and', 'or'].includes(node.operator as string) || !Array.isArray(node.children)) error(path, 'structure', '条件组必须指定 AND 或 OR 及子条件。');
      else {
        const depth = groupDepth + 1;
        if (depth > 3) error(path, 'depth', '条件组最多 3 层（根组计第 1 层）。');
        if (!node.children.length && !(path === 'root' && node.operator === 'and' && options.allowUniversal)) error(path, 'empty-group', '条件组不能为空；全体人群需明确选择。');
        if (depth <= 3) node.children.forEach((child, index) => visit(child, `${path}.children.${index}`, depth));
        groups.push({ expression: node as AudienceExpression, path });
      }
    } else error(path, 'structure', '条件节点必须是规则或条件组。');
    active.delete(node);
  }
  visit(expression, 'root', 0);
  if (ruleCount > 30) error('root', 'rule-limit', '受众最多 30 条规则。');
  let proofLimited = false;
  if (!issues.length) {
    for (const group of groups) {
      const proof = toDNF(group.expression, attributes);
      if (!proof.unknown && !proof.limited && !proof.clauses.length) error(group.path, 'empty-audience', '该条件分支相互矛盾，受众交集为空；请删除或修正此分支。');
    }
    proofLimited = toDNF(expression as AudienceExpression, attributes).limited;
    if (proofLimited) issues.push({ path: 'root', code: 'proof-limit', message: '条件展开超过 64 个组合，仍可按完整树判断资格，但无法据此证明桶复用安全。', severity: 'warning' });
  }
  return { valid: !issues.some(issue => issue.severity === 'error'), issues, ruleCount, proofLimited };
}
export function audienceRuleCount(definition: Pick<AudienceDefinition, 'rules' | 'expression'>): number {
  let count = 0, nodes = 0;
  function visit(node: AudienceExpression, depth = 0) { if (++nodes > 4096 || depth > 100 || !node) return; if (node.kind === 'rule') count++; else if (node.kind === 'group' && Array.isArray(node.children)) node.children.forEach(child => visit(child, depth + 1)); }
  visit(getAudienceExpression(definition)); return count;
}
export function validateAudienceRules(rules: unknown, t?: Topology): string | null {
  if (!Array.isArray(rules)) return '受众规则必须是最多 30 条 AND 条件。';
  const result = validateAudienceExpression({ kind: 'group', operator: 'and', children: rules.map(rule => ({ kind: 'rule', rule })) }, t, { allowUniversal: true });
  return result.issues.find(issue => issue.severity === 'error')?.message ?? null;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const normalizedName = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
export function validateAudienceCatalog(t: Topology): string | null {
  const profileError = validateProfileAttributeCatalog(t); if (profileError) return profileError;
  if (t.audiences !== undefined && !Array.isArray(t.audiences)) return '受众目录格式无效。';
  const audiences = getAudienceCatalog(t), ids = new Set<string>(), versions = new Set<string>(), nameFamilies = new Map<string, string>();
  for (const audience of audiences) {
    if (!plain(audience) || !text(audience.id) || !text(audience.familyId) || !text(audience.name) || !text(audience.owner) || typeof audience.description !== 'string' || !Number.isInteger(audience.version) || audience.version < 1 || typeof audience.createdAt !== 'string' || !Number.isFinite(Date.parse(audience.createdAt))) return '受众版本需要唯一标识、名称、负责人、有效版本号和创建时间。';
    if (audience.name.trim().length > 60 || audience.description.length > 300) return '受众名称最多 60 字，描述最多 300 字。';
    const name = normalizedName(audience.name), ownerFamily = nameFamilies.get(name);
    if (ownerFamily && ownerFamily !== audience.familyId) return '不同受众系列不能使用同名名称，请明确区分；同系列新版本可以沿用名称。';
    nameFamilies.set(name, audience.familyId);
    if (ids.has(audience.id) || versions.has(`${audience.familyId}\0${audience.version}`)) return '受众标识或同一受众的版本号重复。';
    ids.add(audience.id); versions.add(`${audience.familyId}\0${audience.version}`);
    if (!Array.isArray(audience.rules)) return '受众旧版 rules 字段必须保留为数组。';
    if (audience.expression !== undefined && audience.rules.length) return '条件树与旧 rules 不能同时定义规则，树版本的 rules 必须为空。';
    const error = audience.expression !== undefined ? validateAudienceExpression(audience.expression, t, { allowUniversal: true }).issues.find(issue => issue.severity === 'error')?.message : validateAudienceRules(audience.rules, t);
    if (error) return `${audience.name}：${error}`;
  }
  if (t.audiences !== undefined && defaultAudiences.some(seed => !same(audiences.find(item => item.id === seed.id), seed))) return '内置受众版本不能删除或改写，请创建新版本。';
  return null;
}
export function validateAudienceTransition(previous: Topology, next: Topology): string | null {
  if (previous.audiences !== undefined && next.audiences === undefined) return '保存时必须保留现有受众版本目录，请重新读取最新配置。';
  for (const audience of getAudienceCatalog(previous)) if (!same(getAudienceById(audience.id, next), audience)) return '已登记受众版本不能修改或删除，请创建新 ID 的版本。';
  for (const domain of previous.domains) {
    const candidate = next.domains.find(item => item.id === domain.id);
    if (candidate && candidate.audienceId !== domain.audienceId) return '已有域的受众绑定不能直接修改，请创建引用新版本的域。';
    if (candidate && candidate.parentLayerId !== domain.parentLayerId) return '已有域不能直接更换父层，避免改变继承受众与固定分流路径。';
  }
  for (const layer of previous.layers) if (next.layers.some(candidate => candidate.id === layer.id && candidate.domainId !== layer.domainId)) return '已有层不能直接更换所属域，避免改变继承受众与固定分流路径。';
  return null;
}
export type NewAudienceInput = Omit<AudienceDefinition, 'createdAt' | 'familyId'> & { familyId?: string; allowUniversal?: boolean };
export function planAudienceRegistration(input: NewAudienceInput, t: Topology): { topology: Topology | null; error: string | null } {
  const reject = (error: string) => ({ topology: null, error });
  const oldError = validateAudienceCatalog(t); if (oldError) return reject(oldError);
  if (!input || !text(input.id)) return reject('请填写受众版本标识。');
  if (input.expression !== undefined) { const issue = validateAudienceExpression(input.expression, t, { allowUniversal: input.allowUniversal }).issues.find(issue => issue.severity === 'error'); if (issue) return reject(`${issue.path}：${issue.message}`); }
  const { allowUniversal: _allowUniversal, ...persisted } = input;
  const audience: AudienceDefinition = { ...structuredClone(persisted), id: input.id.trim(), familyId: input.familyId?.trim() || input.id.trim(), name: input.name?.trim(), owner: input.owner?.trim(), createdAt: new Date().toISOString() };
  const old = getAudienceCatalog(t);
  if (old.some(item => item.id === audience.id)) return reject('受众版本标识已存在，请使用新的 ID。');
  const family = old.filter(item => item.familyId === audience.familyId);
  if (family.length && audience.version <= Math.max(...family.map(item => item.version))) return reject('新版本号必须大于此受众已有的版本号。');
  const next: Topology = { ...structuredClone(t), audiences: [...structuredClone(old), audience] };
  const error = validateAudienceCatalog(next); return error ? reject(error) : { topology: next, error: null };
}

const universal = (): EffectiveAudience => ({ rules: [], unknown: false, labels: [] });
export function audienceCondition(definition: Pick<AudienceDefinition, 'rules' | 'expression'> & Partial<Pick<AudienceDefinition, 'name' | 'version'>>, t: Topology): EffectiveAudience {
  return { rules: Array.isArray(definition.rules) ? [...definition.rules] : [], expression: getAudienceExpression(definition), unknown: validateProfileAttributeCatalog(t) !== null, attributes: attributesFor(t), labels: definition.name ? [`${definition.name}${definition.version ? ` v${definition.version}` : ''}`] : [] };
}
export function selectionAudience(selection: AudienceSelection, t: Topology): EffectiveAudience {
  if (!selection.audienceId && (!selection.audience || selection.audience === '全部活跃用户')) return universal();
  const definition = selection.audienceId ? getAudienceById(selection.audienceId, t) : defaultAudiences.find(item => item.name === selection.audience);
  return definition ? audienceCondition(definition, t) : { rules: [], unknown: true, labels: [selection.audienceId || selection.audience || '未知受众'] };
}
export function combineAudiences(...conditions: EffectiveAudience[]): EffectiveAudience {
  const rules = conditions.flatMap(condition => condition.rules), attributes = conditions.find(condition => condition.attributes)?.attributes;
  return { rules, unknown: conditions.some(condition => condition.unknown), labels: [...new Set(conditions.flatMap(condition => condition.labels))], ...(attributes ? { attributes } : {}), ...(conditions.some(condition => condition.expression) ? { expression: { kind: 'group' as const, operator: 'and' as const, children: conditions.map(condition => getAudienceExpression(condition)) } } : {}) };
}
export function domainEffectiveAudience(domainId: string, t: Topology, visited = new Set<string>()): EffectiveAudience {
  const domain = t.domains.find(item => item.id === domainId);
  if (!domain || visited.has(domainId)) return { rules: [], unknown: true, labels: ['域路径无效'] };
  visited.add(domainId);
  const parentLayer = domain.parentLayerId ? t.layers.find(layer => layer.id === domain.parentLayerId) : undefined;
  return combineAudiences(parentLayer ? domainEffectiveAudience(parentLayer.domainId, t, visited) : universal(), selectionAudience(domain, t));
}
export const experimentEffectiveAudience = (experiment: Pick<Experiment, 'domainId' | 'audience' | 'audienceId'>, t: Topology): EffectiveAudience => combineAudiences(domainEffectiveAudience(experiment.domainId, t), selectionAudience(experiment, t));
export function audienceIsEmpty(condition: EffectiveAudience): boolean {
  const proof = toDNF(getAudienceExpression(condition), condition.attributes ?? defaultProfileAttributes);
  return !proof.unknown && !proof.limited && proof.clauses.length === 0;
}
function witnessFor(rules: AudienceRule[], attributes: ProfileAttribute[]): AudienceProfile {
  const profile: AudienceProfile = {};
  for (const [field, constraint] of constraints(rules, attributes)) {
    if (constraint.enumValues) profile[field] = [...constraint.enumValues].sort((a, b) => String(a).localeCompare(String(b)))[0];
    else profile[field] = attributeFor(field, attributes)?.integer ? Math.ceil(constraint.minimum ?? 0) : constraint.minimum ?? 0;
  }
  return profile;
}
export function compareAudienceConditions(a: EffectiveAudience, b: EffectiveAudience): AudienceComparison {
  const unresolved = (reason: string): AudienceComparison => ({ relation: 'potential-overlap', reason, conflicts: [], unknown: true });
  if (a.unknown || b.unknown) return unresolved('包含未定义受众，无法证明人群互斥。');
  const attributes = a.attributes ?? b.attributes ?? defaultProfileAttributes;
  if (a.attributes && b.attributes && a.attributes.some(attribute => b.attributes!.some(other => other.key === attribute.key && !same(attribute, other)))) return unresolved('两份条件的画像属性语义不一致，不能证明互斥。');
  const left = toDNF(getAudienceExpression(a), attributes), right = toDNF(getAudienceExpression(b), attributes);
  if (left.limited || right.limited) return unresolved('条件展开超过 64 个组合，无法完成互斥证明；保守保留独立桶。');
  if (left.unknown || right.unknown) return unresolved('包含未知属性或无效条件，无法证明人群互斥。');
  const conflicts: AudienceConflictEvidence[] = [];
  for (const l of left.clauses) for (const r of right.clauses) {
    const field = contradiction([...l, ...r], attributes);
    if (!field) return { relation: 'potential-overlap', reason: '存在同时满足两份完整条件的固定画像，受众可能同时匹配，需分配不同桶段。', witness: witnessFor([...l, ...r], attributes), conflicts: [], unknown: false };
    const label = attributeFor(field, attributes)?.label ?? field;
    if (!conflicts.some(item => item.field === field)) conflicts.push({ field, label, reason: `${label} 的取值集合或数值区间不相交。` });
  }
  return { relation: 'disjoint', reason: conflicts.length ? `所有 OR 分支组合均互斥：${conflicts.map(item => item.reason).join(' ')}可在固定入组画像下复用桶。` : '条件交集为空，可证明不会同时匹配。', conflicts, unknown: false };
}
export const audiencesMayOverlap = (a: EffectiveAudience, b: EffectiveAudience) => compareAudienceConditions(a, b).relation !== 'disjoint';
function ruleDescription(rule: AudienceRule, attributes: ProfileAttribute[]): string {
  return `${attributeFor(rule.field, attributes)?.label ?? rule.field} ${{ eq: '=', in: 'IN', gte: '≥', lte: '≤' }[rule.op]} ${JSON.stringify(rule.value)}`;
}
function expressionDescription(expression: AudienceExpression, attributes: ProfileAttribute[], depth = 0): string {
  if (!expression || depth > 100) return '无效条件';
  if (expression.kind === 'rule') return ruleDescription(expression.rule, attributes);
  if (expression.kind !== 'group' || !Array.isArray(expression.children)) return '无效条件';
  if (!expression.children.length) return expression.operator === 'and' ? '不追加条件（继承基础资格）' : '空 OR（无效）';
  return expression.children.length === 1 ? expressionDescription(expression.children[0], attributes, depth + 1) : `(${expression.children.map(child => expressionDescription(child, attributes, depth + 1)).join(expression.operator === 'or' ? ' OR ' : ' AND ')})`;
}
export const describeExpression = (expression: AudienceExpression, t?: Topology) => expressionDescription(expression, attributesFor(t));
export function describeRules(rules: AudienceRule[], t?: Topology): string { return rules.length ? rules.map(rule => ruleDescription(rule, attributesFor(t))).join(' AND ') : '不追加条件（继承基础资格）'; }
export const audienceSummary = (condition: EffectiveAudience) => `${expressionDescription(getAudienceExpression(condition), condition.attributes ?? defaultProfileAttributes)}${condition.unknown ? '；包含未验证受众' : ''}`;
export const describeAudience = (id: string | undefined, t: Topology) => { const audience = id ? getAudienceById(id, t) : undefined; return audience ? `${audience.name} v${audience.version} · ${describeExpression(getAudienceExpression(audience), t)}` : id ? '未知受众版本' : '继承上级资格，不追加条件'; };
export function evaluateAudience(condition: EffectiveAudience, profile: AudienceProfile = {}): AudienceEvaluation {
  const attributes = condition.attributes ?? defaultProfileAttributes; let nodes = 0, schemaNodes = 0;
  function validSchema(expression: AudienceExpression, depth = 0): boolean {
    if (!expression || ++schemaNodes > 4096 || depth > 100) return false;
    if (expression.kind === 'rule') return !ruleError(expression.rule, attributes);
    return expression.kind === 'group' && ['and', 'or'].includes(expression.operator) && Array.isArray(expression.children) && (expression.operator !== 'or' || expression.children.length > 0) && expression.children.every(child => validSchema(child, depth + 1));
  }
  if (!validSchema(getAudienceExpression(condition))) return { status: 'unknown', reason: '表达式或画像属性定义无效，资格未验证；不执行实验。' };
  function visit(expression: AudienceExpression, depth = 0): AudienceEvaluation {
    if (!expression || ++nodes > 4096 || depth > 100) return { status: 'unknown', reason: '受众条件无法安全解析，资格未验证。' };
    if (expression.kind === 'rule') {
      const rule = expression.rule, field = rule && attributeFor(rule.field, attributes);
      if (!field || ruleError(rule, attributes)) return { status: 'unknown', reason: '包含未登记属性或无效规则，资格未验证。' };
      const value = profile && Object.prototype.hasOwnProperty.call(profile, rule.field) ? profile[rule.field] : undefined;
      if (!profileValueIsValid(field, value)) return { status: 'unknown', reason: `受众资格未验证：缺少或无效属性 ${field.label}；不执行实验。` };
      const match = rule.op === 'eq' ? value === rule.value : rule.op === 'in' ? (rule.value as string[]).includes(value as string) : rule.op === 'gte' ? (value as number) >= (rule.value as number) : (value as number) <= (rule.value as number);
      return match ? { status: 'match', reason: '固定入组画像满足条件。' } : { status: 'not-match', reason: `固定入组画像不满足：${ruleDescription(rule, attributes)}。` };
    }
    if (expression.kind !== 'group' || !Array.isArray(expression.children) || !['and', 'or'].includes(expression.operator)) return { status: 'unknown', reason: '受众条件结构无效，资格未验证。' };
    const children = expression.children.map(child => visit(child, depth + 1));
    if (expression.operator === 'and') {
      const rejected = children.find(child => child.status === 'not-match'); if (rejected) return rejected;
      const missing = children.filter(child => child.status === 'unknown'); if (missing.length) return { status: 'unknown', reason: missing.map(child => child.reason).join(' ') };
      return { status: 'match', reason: '固定入组画像满足全部有效受众条件。' };
    }
    if (children.some(child => child.status === 'match')) return { status: 'match', reason: '固定入组画像满足至少一个 OR 分支。' };
    if (children.some(child => child.status === 'unknown')) return { status: 'unknown', reason: children.filter(child => child.status === 'unknown').map(child => child.reason).join(' ') };
    return { status: 'not-match', reason: `所有 OR 分支均不匹配。${children.map(child => child.reason).join(' ')}` };
  }
  const result = visit(getAudienceExpression(condition));
  return condition.unknown && result.status !== 'not-match' ? { status: 'unknown', reason: '受众资格未验证：包含未定义受众；不执行实验。' } : result;
}
