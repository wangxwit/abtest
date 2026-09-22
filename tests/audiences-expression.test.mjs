import test from 'node:test';
import assert from 'node:assert/strict';
import { initialExperiments } from '../src/data.ts';
import { defaultTopology, validateTopology, validateAllocation, simulateAllocation, explainAllocationConflicts } from '../src/traffic.ts';
import { planAudienceRegistration, getAudienceExpression, audienceCondition, validateAudienceExpression, describeExpression, audienceRuleCount, evaluateAudience, compareAudienceConditions, combineAudiences, domainEffectiveAudience } from '../src/audiences.ts';
import { planProfileAttributeRegistration } from '../src/profile-attributes.ts';

const base = () => structuredClone(defaultTopology);
const leaf = (field, op, value) => ({ kind: 'rule', rule: { field, op, value } });
const and = (...children) => ({ kind: 'group', operator: 'and', children });
const or = (...children) => ({ kind: 'group', operator: 'or', children });
const cn = () => leaf('country', 'eq', 'CN'), us = () => leaf('country', 'eq', 'US'), member = () => leaf('is_member', 'eq', true);
const definition = (id, expression) => ({ id, familyId: id, name: id, owner: '增长组', version: 1, description: '', rules: [], expression });
const condition = (expression, t = base()) => audienceCondition({ rules: [], expression }, t);
function ok(plan) { assert.equal(plan.error, null); assert.ok(plan.topology); return plan.topology; }
function experiment(id, audienceId, changes = {}) { return { ...structuredClone(initialExperiments.find(item => item.layerId === 'ranking' && item.status === 'running')), id, key: id, name: id, audienceId, traffic: 100, bucketStart: 0, ...changes }; }

test('AND and OR preserve three-valued semantics without flattening nested branches', () => {
  const expression = and(or(cn(), us()), or(member(), leaf('spend_30d', 'gte', 500)));
  assert.equal(validateAudienceExpression(expression, base()).valid, true);
  assert.equal(audienceRuleCount({ rules: [], expression }), 4);
  const c = condition(expression);
  assert.equal(evaluateAudience(c, { country: 'CN', is_member: true }).status, 'match', 'true OR unknown is true');
  assert.equal(evaluateAudience(c, { country: 'SG' }).status, 'not-match', 'false AND unknown is false');
  assert.equal(evaluateAudience(c, { country: 'US', is_member: false }).status, 'unknown');
  assert.equal(evaluateAudience(c, { country: 'US', is_member: false, spend_30d: 600 }).status, 'match');
  assert.match(describeExpression(expression, base()), /OR/);
  assert.match(describeExpression(expression, base()), /AND/);
});

test('OR overlap checks every branch pair and provides a witness matching both complete expressions', () => {
  const a = condition(or(cn(), member())), b = condition(or(us(), member()));
  const overlap = compareAudienceConditions(a, b);
  assert.equal(overlap.relation, 'potential-overlap');
  assert.equal(overlap.unknown, false);
  assert.equal(evaluateAudience(a, overlap.witness).status, 'match');
  assert.equal(evaluateAudience(b, overlap.witness).status, 'match');
  const disjoint = compareAudienceConditions(condition(or(cn(), us())), condition(and(leaf('country', 'eq', 'SG'), member())));
  assert.equal(disjoint.relation, 'disjoint');
  assert.ok(disjoint.conflicts.some(item => item.field === 'country'));
  const opaque = { ...condition(or(cn(), leaf('unregistered_field', 'eq', 'x'))), unknown: true };
  assert.equal(compareAudienceConditions(opaque, condition(us())).relation, 'potential-overlap');
  assert.equal(compareAudienceConditions(opaque, condition(us())).unknown, true);
});

test('validation returns paths for malformed, deep, empty or unreachable condition branches', () => {
  const invalid = and(cn(), or(member(), leaf('unknown_field', 'eq', 'x')));
  const issue = validateAudienceExpression(invalid, base()).issues.find(item => item.severity === 'error');
  assert.equal(issue.path, 'root.children.1.children.1');
  for (const expression of [or(), and(cn(), and()), and(and(and(and(cn())))), and(...Array.from({ length: 31 }, cn)), or(cn(), and(cn(), us()))]) assert.equal(validateAudienceExpression(expression, base()).valid, false);
  assert.equal(validateAudienceExpression(and(), base()).valid, false);
  assert.equal(validateAudienceExpression(and(), base(), { allowUniversal: true }).valid, true);
  assert.equal(planAudienceRegistration(definition('implicit-all', and()), base()).topology, null);
  assert.equal(planAudienceRegistration({ ...definition('explicit-all', and()), allowUniversal: true }, base()).error, null);
  assert.equal(planAudienceRegistration({ ...definition('double-source', or(cn(), us())), rules: [cn().rule] }, base()).topology, null);
});

test('old AND definitions retain exact bytes while tree definitions register without rewriting previous versions', () => {
  const legacy = { id: 'legacy', familyId: 'legacy', name: '旧人群', owner: '增长组', description: '', version: 1, rules: [cn().rule, member().rule] };
  const t = ok(planAudienceRegistration(legacy, base()));
  const bytes = JSON.stringify(t.audiences);
  assert.deepEqual(getAudienceExpression(t.audiences.find(item => item.id === legacy.id)), and(cn(), member()));
  const next = ok(planAudienceRegistration(definition('tree', or(cn(), us())), t));
  assert.equal(JSON.stringify(t.audiences), bytes);
  assert.equal(JSON.stringify(next.audiences.slice(0, -1)), bytes);
  assert.equal('expression' in next.audiences.find(item => item.id === legacy.id), false);
  assert.deepEqual(next.audiences.at(-1).rules, []);
});

test('ancestor conditions remain an AND around an OR child and may eliminate only incompatible branches', () => {
  let t = ok(planAudienceRegistration(definition('parent-cn', cn()), base()));
  t = ok(planAudienceRegistration(definition('child-or', or(and(cn(), member()), us())), t));
  t.domains.find(domain => domain.id === 'overlap').audienceId = 'parent-cn';
  t.domains.find(domain => domain.id === 'ui-mobile').audienceId = 'child-or';
  const c = domainEffectiveAudience('card-depth', t);
  assert.equal(evaluateAudience(c, { country: 'US', is_member: true }).status, 'not-match');
  assert.equal(evaluateAudience(c, { country: 'CN', is_member: false }).status, 'not-match');
  assert.equal(evaluateAudience(c, { country: 'CN', is_member: true }).status, 'match');
  assert.equal(compareAudienceConditions(c, condition(us())).relation, 'disjoint');
  const contradictory = combineAudiences(c, condition(leaf('is_member', 'eq', false)));
  assert.equal(compareAudienceConditions(contradictory, condition(and())).relation, 'disjoint');
});

test('proof expansion limits stay conservative while execution still evaluates the complete tree', () => {
  let t = ok(planProfileAttributeRegistration({ key: 'score', label: '评分', type: 'number', serviceId: 'ranking-service', description: '固定入组评分', integer: true }, base()));
  const expression = and(
    or(cn(), us()), or(leaf('platform', 'eq', 'iOS'), leaf('platform', 'eq', 'Web')),
    or(member(), leaf('is_member', 'eq', false)), or(leaf('registration_days', 'lte', 7), leaf('registration_days', 'gte', 8)),
    or(leaf('spend_30d', 'lte', 499), leaf('spend_30d', 'gte', 500)), or(leaf('last_active_days', 'lte', 14), leaf('last_active_days', 'gte', 15)),
    or(leaf('score', 'lte', 3), leaf('score', 'gte', 4)),
  );
  const validation = validateAudienceExpression(expression, t);
  assert.equal(validation.valid, true);
  assert.equal(validation.proofLimited, true);
  assert.ok(validation.issues.some(item => item.severity === 'warning'));
  const c = condition(expression, t), profile = { country: 'CN', platform: 'iOS', is_member: true, registration_days: 3, spend_30d: 100, last_active_days: 0, score: 4 };
  assert.equal(evaluateAudience(c, profile).status, 'match');
  const comparison = compareAudienceConditions(c, condition(leaf('country', 'eq', 'SG'), t));
  assert.equal(comparison.relation, 'potential-overlap');
  assert.equal(comparison.unknown, true);
  assert.equal(comparison.witness, undefined);
});

test('tree-based conflicts include all experiment and child-domain reservations with exact cross ranges', () => {
  let t = ok(planAudienceRegistration(definition('or-a', or(cn(), member())), base()));
  t = ok(planAudienceRegistration(definition('or-b', or(us(), member())), t));
  const a = experiment('reserved', 'or-a', { traffic: 50 });
  t.domains.push({ id: 'child', name: 'child', parentLayerId: 'ranking', audienceId: 'or-a', mode: 'overlapping', start: 50, traffic: 50, unit: 'user_id', description: '' });
  t.layers.push({ id: 'child-layer', name: 'child-layer', domainId: 'child', parameterKeys: ['*'], description: '' });
  const candidate = experiment('candidate', 'or-b', { bucketStart: 25, traffic: 50 });
  assert.equal(validateTopology(t, [a]), null);
  const conflicts = explainAllocationConflicts(candidate, [a], t);
  assert.deepEqual(conflicts.map(item => [item.kind, item.id, item.start, item.end]), [['experiment', 'reserved', 25, 50], ['domain', 'child', 50, 75]]);
  assert.ok(conflicts.every(item => item.witness && item.unknown === false));
  assert.match(validateAllocation(candidate, [a], t), /受众可能重叠/);
});

test('disjoint OR trees share buckets and preserve fixed hash and unique candidate selection', () => {
  let t = ok(planAudienceRegistration(definition('cn-or-us', or(cn(), us())), base()));
  t = ok(planAudienceRegistration(definition('sg', leaf('country', 'eq', 'SG')), t));
  const a = experiment('a', 'cn-or-us'), b = experiment('b', 'sg');
  assert.equal(validateTopology(t, [a, b]), null);
  for (let index = 0; index < 60; index++) {
    const user = `tree_${index}`;
    const result = simulateAllocation(user, [a, b], t, { country: 'US' });
    const selected = result.decisions.find(item => item.layerId === 'ranking');
    if (!selected) continue;
    assert.equal(selected.experimentId, a.id);
    assert.equal(selected.audienceStatus, 'match');
    assert.equal(selected.variant, simulateAllocation(user, [a], t, { country: 'US' }).decisions.find(item => item.layerId === 'ranking').variant);
    assert.ok(result.trace.find(item => item.kind === 'layer' && item.id === 'ranking').reason.includes('「b」不匹配'));
  }
});

test('invalid schema cannot hide behind a true OR branch or be treated as an empty disjoint population', () => {
  const invalidBranch = condition(or(cn(), leaf('unknown_attribute', 'eq', 'x')));
  assert.equal(evaluateAudience(invalidBranch, { country: 'CN' }).status, 'unknown');
  assert.equal(compareAudienceConditions(invalidBranch, condition(us())).unknown, true);
  const emptyOr = condition(or());
  assert.equal(evaluateAudience(emptyOr).status, 'unknown');
  assert.equal(compareAudienceConditions(emptyOr, condition(cn())).relation, 'potential-overlap');
  assert.equal(compareAudienceConditions(emptyOr, condition(cn())).unknown, true);
  const t = base();
  t.profileAttributes = [{ key: 'broken', label: '未知类型', type: 'date', serviceId: 'ui-web', description: '非法属性', createdAt: new Date().toISOString() }];
  assert.equal(evaluateAudience(condition(leaf('broken', 'eq', '2026-09-12'), t), { broken: '2026-09-12' }).status, 'unknown');
});
