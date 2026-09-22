import type { Experiment } from './data';
import type { Topology } from './traffic';
import { audienceSummary, defaultAudiences, describeExpression, domainEffectiveAudience, experimentEffectiveAudience, getAudience, getAudienceExpression, type AudienceDefinition, type AudienceExpression, type AudienceRule } from './audiences.ts';
import { getProfileAttribute, type ProfileAttribute } from './profile-attributes.ts';

export type AudienceReferenceSource = { audienceId?: string; attributeKey?: string };
export type AudienceReferenceContext = { kind: 'none' } | { kind: 'audience'; audienceId: string } | { kind: 'attribute'; attributeKey: string } | { kind: 'invalid'; error: string };
export type AudienceReference = { audience: AudienceDefinition; relation: 'direct' | 'inherited'; domainId?: string; domainName?: string; legacy?: boolean; rules: AudienceRule[]; expression: string };
export type AudienceReferenceResolution = { status: 'none' | 'invalid' | 'missing-target' | 'missing-source' | 'unrelated' | 'matched'; message: string; references: AudienceReference[]; effectiveCondition: string; relation?: 'direct' | 'inherited' | 'both'; audience?: AudienceDefinition; attribute?: ProfileAttribute; sourceHref?: string };

/** Source values select a reference to explain; they never change target configuration. */
export function audienceReferenceHref(kind: 'domain' | 'experiment', id: string, context: AudienceReferenceSource): string {
  const path = kind === 'domain' ? `#traffic/domain/${encodeURIComponent(id)}` : `#experiments/${encodeURIComponent(id)}`;
  const query: string[] = [];
  if (context.audienceId !== undefined) query.push(`audience=${encodeURIComponent(context.audienceId)}`);
  if (context.attributeKey !== undefined) query.push(`attribute=${encodeURIComponent(context.attributeKey)}`);
  return query.length ? `${path}?${query.join('&')}&focus=audience` : path;
}
export function parseAudienceReferenceContext(hash: string): AudienceReferenceContext {
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  if (!query) return { kind: 'none' };
  const invalid = (): AudienceReferenceContext => ({ kind: 'invalid', error: '引用来源参数无效，请从受众或画像属性的引用列表重新打开。' });
  try { decodeURIComponent(query.replaceAll('+', ' ')); } catch { return invalid(); }
  const params = new URLSearchParams(query);
  if ([...params.keys()].some(key => !['audience', 'attribute', 'focus'].includes(key))) return invalid();
  if (params.getAll('focus').length !== 1 || params.get('focus') !== 'audience') return invalid();
  const audiences = params.getAll('audience'), attributes = params.getAll('attribute');
  if (audiences.length + attributes.length !== 1) return invalid();
  const value = audiences[0] ?? attributes[0];
  if (!value || value !== value.trim()) return invalid();
  return audiences.length ? { kind: 'audience', audienceId: value } : { kind: 'attribute', attributeKey: value };
}
function decodeIdentity(encoded: string | undefined): string | null {
  if (!encoded) return null;
  try { const value = decodeURIComponent(encoded); return value && value === value.trim() ? value : null; } catch { return null; }
}
export function parseExperimentDestination(hash: string): { id: string | null; error: string | null } {
  const parts = hash.split('?')[0].replace(/^#/, '').split('/');
  if (parts[0] !== 'experiments' || parts.length === 1) return { id: null, error: null };
  const id = parts.length === 2 ? decodeIdentity(parts[1]) : null;
  return id ? { id, error: null } : { id: null, error: '实验地址无效，请从实验或受众引用列表重新打开。' };
}
export function parseTrafficDestination(hash: string): { kind: 'domain' | 'layer' | null; id: string | null; error: string | null } {
  const parts = hash.split('?')[0].replace(/^#/, '').split('/');
  if (parts[0] !== 'traffic' || parts.length === 1) return { kind: null, id: null, error: null };
  const id = parts.length === 3 ? decodeIdentity(parts[2]) : null;
  return id && (parts[1] === 'domain' || parts[1] === 'layer') ? { kind: parts[1], id, error: null } : { kind: null, id: null, error: '层域地址无效，请从层域树或受众引用列表重新打开。' };
}
function attributeRules(expression: AudienceExpression, key: string): AudienceRule[] {
  const rules: AudienceRule[] = []; let count = 0;
  function collect(node: AudienceExpression, depth = 0) {
    if (!node || ++count > 4096 || depth > 100) return;
    if (node.kind === 'rule') { if (node.rule.field === key) rules.push(node.rule); }
    else if (node.kind === 'group' && Array.isArray(node.children)) node.children.forEach(child => collect(child, depth + 1));
  }
  collect(expression); return rules;
}
/** Verify exact references on the target's own configuration and its ancestor path. */
export function resolveAudienceReference(kind: 'domain' | 'experiment', id: string, context: AudienceReferenceContext, topology: Topology, experiments: Experiment[]): AudienceReferenceResolution {
  const empty = (status: AudienceReferenceResolution['status'], message: string): AudienceReferenceResolution => ({ status, message, references: [], effectiveCondition: '' });
  if (context.kind === 'none') return empty('none', '');
  if (context.kind === 'invalid') return empty('invalid', context.error);
  const experiment = kind === 'experiment' ? experiments.find(item => item.id === id) : undefined;
  const targetDomain = topology.domains.find(item => item.id === (kind === 'domain' ? id : experiment?.domainId));
  if ((kind === 'experiment' && !experiment) || !targetDomain) return empty('missing-target', '引用目标不存在或所属域已不可用，无法确认受众关系。');
  const audience = context.kind === 'audience' ? getAudience(context.audienceId, topology) : undefined;
  const attribute = context.kind === 'attribute' ? getProfileAttribute(context.attributeKey, topology) : undefined;
  if (!audience && !attribute) return empty('missing-source', '来源受众版本或画像属性不存在；当前目标的条件保持原样。');
  const sourceHref = audience ? `#audiences/${encodeURIComponent(audience.id)}` : `#audiences/attributes/${encodeURIComponent(attribute!.key)}`;
  const references: AudienceReference[] = [];
  const include = (definition: AudienceDefinition | undefined, relation: 'direct' | 'inherited', domainId?: string, domainName?: string, legacy = false) => {
    if (!definition) return;
    const expression = getAudienceExpression(definition), rules = attribute ? attributeRules(expression, attribute.key) : [];
    if (audience ? definition.id !== audience.id : rules.length === 0) return;
    references.push({ audience: definition, relation, ...(domainId ? { domainId, domainName } : {}), ...(legacy ? { legacy: true } : {}), rules, expression: describeExpression(expression, topology) });
  };
  if (experiment) {
    const legacy = !experiment.audienceId ? defaultAudiences.find(item => item.name === experiment.audience) : undefined;
    include(experiment.audienceId ? getAudience(experiment.audienceId, topology) : legacy, 'direct', undefined, undefined, Boolean(legacy));
  }
  const visited = new Set<string>();
  let cursor: typeof targetDomain | undefined = targetDomain;
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    include(cursor.audienceId ? getAudience(cursor.audienceId, topology) : undefined, kind === 'domain' && cursor.id === id ? 'direct' : 'inherited', cursor.id, cursor.name);
    if (!cursor.parentLayerId) break;
    const layer = topology.layers.find(item => item.id === cursor!.parentLayerId);
    cursor = topology.domains.find(item => item.id === layer?.domainId);
  }
  const effectiveCondition = audienceSummary(experiment ? experimentEffectiveAudience(experiment, topology) : domainEffectiveAudience(id, topology));
  const source = { audience, attribute, sourceHref, effectiveCondition };
  if (!references.length) return { ...empty('unrelated', '当前目标未直接引用或继承此来源；已保留目标原有条件，没有应用额外筛选。'), ...source };
  const direct = references.some(reference => reference.relation === 'direct'), inherited = references.some(reference => reference.relation === 'inherited');
  return { status: 'matched', message: '已核对当前配置中的引用关系，以下展示来源条件及继承位置。', ...source, references, relation: direct && inherited ? 'both' : direct ? 'direct' : 'inherited' };
}
