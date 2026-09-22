import test from 'node:test';
import assert from 'node:assert/strict';
import { audiencePreflight } from '../src/audience-preflight.ts';
import { audienceCondition, domainEffectiveAudience, evaluateAudience, getAudiences } from '../src/audiences.ts';
import { defaultTopology } from '../src/traffic.ts';
import { initialExperiments } from '../src/data.ts';

const rule = (field, op, value) => ({ kind: 'rule', rule: { field, op, value } });
const group = (operator, ...children) => ({ kind: 'group', operator, children });
const draft = expression => ({ name: '预检草稿', version: 1, rules: [], expression });
const country = value => draft(group('and', rule('country', 'eq', value)));
const base = () => structuredClone(defaultTopology);
function register(t, id, definition) {
  t.audiences = [...getAudiences(t), { id, familyId: id, name: id, version: 1, description: '', owner: '验证团队', createdAt: '2026-09-12T00:00:00.000Z', ...structuredClone(definition) }];
  return t;
}
function experiment(id, start, traffic, audienceId, status = 'running') {
  const source = initialExperiments.find(item => item.layerId === 'ranking' && item.status === 'running');
  return { ...structuredClone(source), id, key: id, name: id, status, domainId: 'overlap', layerId: 'ranking', bucketStart: start, traffic, audience: '全部活跃用户', ...(audienceId ? { audienceId } : {}) };
}
const check = (definition, changes = {}) => audiencePreflight({ definition, topology: base(), experiments: [], ...changes });

test('incomplete own trees do not produce catalog or allocation conclusions', () => {
  const result = check(draft(group('and', rule('', 'eq', ''))), { allocation: { layerId: 'ranking', traffic: 20 } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === 'own-expression'));
  assert.equal(result.ownCondition, null);
  assert.equal(result.effectiveCondition, null);
  assert.deepEqual(result.catalogComparisons, []);
  assert.equal(result.allocation, null);
});

test('all catalog versions are compared using full nested OR expressions and valid witnesses', () => {
  const t = register(register(base(), 'germany', country('DE')), 'china', country('CN'));
  const definition = draft(group('and', group('or', rule('country', 'eq', 'CN'), rule('country', 'eq', 'US')), rule('is_member', 'eq', true)));
  const result = check(definition, { topology: t });
  assert.equal(result.valid, true);
  assert.equal(result.catalogComparisons.length, getAudiences(t).length);
  const germany = result.catalogComparisons.find(item => item.definition.id === 'germany');
  const china = result.catalogComparisons.find(item => item.definition.id === 'china');
  assert.equal(germany.relation, 'disjoint');
  assert.equal(china.relation, 'potential-overlap');
  assert.ok(china.comparison.witness);
  assert.equal(evaluateAudience(result.effectiveCondition, china.comparison.witness).status, 'match');
  assert.equal(evaluateAudience(china.condition, china.comparison.witness).status, 'match');
});

test('ordinary overlap with an existing audience is informational for central registration', () => {
  const definition = draft(group('and', rule('registration_days', 'lte', 7)));
  const result = check(definition, { experiments: [experiment('full', 0, 100)] });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.allocation, null);
  assert.equal(result.catalogComparisons.find(item => item.definition.id === 'new-users-v1').relation, 'potential-overlap');
});

test('inline inheritance is resolved from the latest layer parent instead of a stale passed snapshot', () => {
  const t = register(register(base(), 'china', country('CN')), 'usa', country('US'));
  t.domains.find(domain => domain.id === 'overlap').audienceId = 'china';
  const oldCondition = domainEffectiveAudience('overlap', t);
  t.domains.find(domain => domain.id === 'overlap').audienceId = 'usa';
  const result = check(country('CN'), { topology: t, inheritedCondition: oldCondition, allocation: { layerId: 'ranking', traffic: 10 } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === 'inheritance-empty'));
  assert.equal(result.allocation.availableStart, null);
  assert.equal(evaluateAudience(result.inheritedCondition, { country: 'US' }).status, 'match');
});

test('an explicitly supplied inherited condition also blocks an impossible own intersection', () => {
  const t = base();
  const result = check(country('CN'), { topology: t, inheritedCondition: audienceCondition(country('US'), t) });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === 'inheritance-empty'));
});

test('inline capacity blocks a full overlapping layer while the same central definition remains registrable', () => {
  const existing = [experiment('occupied', 0, 100)];
  const definition = country('CN');
  const central = check(definition, { experiments: existing });
  const inline = check(definition, { experiments: existing, allocation: { layerId: 'ranking', traffic: 10 } });
  assert.equal(central.valid, true);
  assert.equal(inline.valid, false);
  assert.ok(inline.errors.some(error => error.code === 'allocation-capacity'));
  assert.equal(inline.allocation.conflicts.length, 1);
  assert.ok(inline.allocation.conflicts[0].conditionSummary);
  assert.ok(inline.allocation.conflicts[0].reason);
});

test('a potential conflict is avoided by first fit and does not unnecessarily block inline creation', () => {
  const result = check(country('CN'), { experiments: [experiment('paused-slot', 0, 40, undefined, 'paused')], allocation: { layerId: 'ranking', traffic: 20 } });
  assert.equal(result.valid, true);
  assert.equal(result.allocation.availableStart, 40);
  assert.equal(result.allocation.capacity.available, 60);
  assert.equal(result.allocation.conflicts[0].start, 0);
  assert.equal(result.allocation.conflicts[0].end, 40);
});

test('child domains participate in preflight capacity and full condition conflict explanations', () => {
  const t = base();
  t.domains.push({ id: 'reserved-child', name: '保留子域', parentLayerId: 'ranking', mode: 'non-overlapping', traffic: 35, start: 0, unit: 'user_id', description: '' });
  t.layers.push({ id: 'reserved-child-layer', name: '子层', domainId: 'reserved-child', parameterKeys: ['*'], description: '' });
  const result = check(country('CN'), { topology: t, experiments: [experiment('review-slot', 50, 30, undefined, 'review')], allocation: { layerId: 'ranking', traffic: 20 } });
  assert.equal(result.valid, true);
  assert.equal(result.allocation.availableStart, 35);
  assert.deepEqual(result.allocation.bucketRanges, [{start:3500,end:5000},{start:8000,end:8500}]);
  assert.deepEqual(result.allocation.conflicts.map(item => item.kind).sort(), ['domain', 'experiment']);
});

test('inline audience creation combines free fragments when the total capacity fits', () => {
  const result = check(country('CN'), { experiments: [experiment('left', 20, 20), experiment('right', 60, 20)], allocation: { layerId: 'ranking', traffic: 30 } });
  assert.equal(result.allocation.capacity.available, 60);
  assert.equal(result.allocation.capacity.largestFree, 20);
  assert.equal(result.valid, true);
  assert.deepEqual(result.allocation.bucketRanges, [{start:0,end:2000},{start:4000,end:5000}]);
  assert.ok(!result.errors.some(error => error.code === 'allocation-capacity'));
});

test('provably disjoint full-size cohorts can reuse the same bucket coordinates', () => {
  const result = check(draft(group('and', rule('registration_days', 'gte', 8))), { experiments: [experiment('new-users', 0, 100, 'new-users-v1')], allocation: { layerId: 'ranking', traffic: 100 } });
  assert.equal(result.valid, true);
  assert.equal(result.allocation.availableStart, 0);
  assert.equal(result.allocation.capacity.reusable, 100);
  assert.deepEqual(result.allocation.conflicts, []);
});

test('proof-limited trees remain valid centrally but comparisons are explicitly unproven', () => {
  const expression = group('and', ...Array.from({ length: 7 }, (_, index) => group('or', rule('spend_30d', 'gte', index * 10), rule('spend_30d', 'gte', index * 10 + 1))));
  const result = check(draft(expression));
  assert.equal(result.valid, true);
  assert.equal(result.validation.proofLimited, true);
  assert.ok(result.catalogComparisons.every(item => item.relation === 'unproven' && item.comparison.unknown));
});

test('invalid allocation contexts and traffic never pass the inline gate', () => {
  for (const traffic of [0, 101, 1.001, 0.001, NaN]) {
    const result = check(country('CN'), { allocation: { layerId: 'ranking', traffic } });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.code === 'allocation-traffic'));
  }
  const result = check(country('CN'), { allocation: { layerId: 'missing', traffic: 10 } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === 'allocation-context'));
});

test('submission can recheck new reservations and the preflight never modifies catalog or traffic', () => {
  const t = base(), definition = country('CN'), existing = [experiment('first', 0, 40)];
  const input = { definition, topology: t, experiments: existing, allocation: { layerId: 'ranking', traffic: 20 } };
  const before = JSON.stringify(input);
  assert.equal(audiencePreflight(input).valid, true);
  assert.equal(JSON.stringify(input), before);
  const second = audiencePreflight({ ...input, experiments: [...existing, experiment('new-reservation', 40, 60)] });
  assert.equal(second.valid, false);
  assert.ok(second.errors.some(error => error.code === 'allocation-capacity'));
  assert.equal(JSON.stringify(input), before);
  assert.ok(!getAudiences(t).some(audience => audience.id.startsWith('audience-preflight-draft')));
});


test('inline audience preflight accepts one bucket and does not round an invalid precision up', () => {
  const smallest = check(country('CN'), {allocation:{layerId:'ranking',traffic:0.01}});
  assert.equal(smallest.valid,true);
  assert.deepEqual(smallest.allocation.bucketRanges,[{start:0,end:1}]);
  const fractional = check(country('CN'), {allocation:{layerId:'ranking',traffic:1.5}});
  assert.equal(fractional.valid,true);
  assert.deepEqual(fractional.allocation.bucketRanges,[{start:0,end:150}]);
  const invalid = check(country('CN'), {allocation:{layerId:'ranking',traffic:0.015}});
  assert.equal(invalid.valid,false);
  assert.equal(invalid.allocation.bucketRanges,null);
  assert.ok(invalid.errors.some(error=>error.code==='allocation-traffic'));
});

test('preflight ignores holes in a multi-segment reservation and reports only its real occupied buckets', () => {
  const reserved = experiment('fragmented-reservation',0,20);
  reserved.bucketRanges=[{start:0,end:1000},{start:9000,end:10000}];
  const before=JSON.stringify(reserved);
  const result=check(country('CN'),{experiments:[reserved],allocation:{layerId:'ranking',traffic:80}});
  assert.equal(result.valid,true);
  assert.equal(result.allocation.capacity.available,80);
  assert.deepEqual(result.allocation.bucketRanges,[{start:1000,end:9000}]);
  assert.deepEqual(result.allocation.conflicts[0].bucketRanges,reserved.bucketRanges);
  assert.equal(JSON.stringify(reserved),before);
});


test('malformed occupied ranges are reported as invalid configuration instead of insufficient capacity', () => {
  const reserved=experiment('invalid-reservation',0,20);
  reserved.bucketRanges=[{start:0,end:1}];
  const result=check(country('CN'),{experiments:[reserved],allocation:{layerId:'ranking',traffic:1}});
  assert.equal(result.valid,false);
  assert.ok(result.errors.some(error=>error.code==='allocation-context'));
  assert.ok(!result.errors.some(error=>error.code==='allocation-capacity'));
  assert.equal(result.allocation.bucketRanges,null);
});
