import test from 'node:test';
import assert from 'node:assert/strict';
import { initialExperiments } from '../src/data.ts';
import { defaultTopology, validateAllocation, simulateAllocation } from '../src/traffic.ts';

let implementation;
try { implementation = await import('../src/experiment-variants.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
function api() { assert.ok(implementation, 'Multi-group variant contract is not implemented'); return implementation; }
const group = (id, role, weight, value = id) => ({ id, role, name: id, weight, value: JSON.stringify({ 'ranking.model': value }) });
const three = () => [group('variant-a', 'treatment', 25), group('variant-b', 'control', 25), group('variant-c', 'treatment', 50)];
function experiment(changes = {}) { return { ...structuredClone(initialExperiments.find(e => e.layerId === 'ranking' && e.status === 'running')), id: 'multi-group-runtime', key: 'multi-group-runtime', traffic: 100, bucketStart: 0, parameterKeys: ['ranking.model'], variants: three(), ...changes }; }

test('new experiments support three through twenty groups with one explicitly identified control anywhere in the array', () => {
  const { validateExperimentVariants, getVariantRole, getVariantLabel, getVariantId, getControlVariant } = api();
  const variants = three(), before = structuredClone(variants);
  assert.equal(validateExperimentVariants(variants), null);
  assert.equal(getControlVariant(variants), variants[1]);
  assert.equal(getVariantRole(variants[0], 0), 'treatment');
  assert.equal(getVariantLabel(variants[1], 1), '对照组');
  assert.equal(getVariantLabel(variants[2], 2), '实验组');
  assert.equal(getVariantId(variants[1], 1), 'variant-b');
  assert.equal(validateExperimentVariants(Array.from({ length: 20 }, (_, index) => group(`v-${index}`, index === 12 ? 'control' : 'treatment', 5))), null);
  assert.deepEqual(variants, before, 'Validation and role helpers must not reorder or rewrite groups');
});

test('new groups require distinct stable IDs, complete metadata and exactly one control plus a treatment', () => {
  const { validateExperimentVariants } = api();
  for (const variants of [
    [], [group('only-control', 'control', 100)],
    Array.from({ length: 21 }, (_, i) => group(`v-${i}`, i ? 'treatment' : 'control', i === 20 ? 80 : 1)),
    [group('a', 'treatment', 50), group('b', 'treatment', 50)],
    [group('a', 'control', 50), group('b', 'control', 50)],
    [group('a', 'control', 50), group('a', 'treatment', 50)],
    [group('', 'control', 50), group('b', 'treatment', 50)],
    [group(' a ', 'control', 50), group('b', 'treatment', 50)],
    [group('a', 'control', 50), group('b', 'unknown', 50)],
    [group('a', 'control', 50), { name: 'legacy-b', weight: 50, value: '{}' }],
    [{ ...group('a', 'control', 50), role: undefined }, group('b', 'treatment', 50)],
    [null, group('b', 'treatment', 100)],
  ]) assert.ok(validateExperimentVariants(variants), JSON.stringify(variants));
});

test('new group names are present, bounded and unique after normalization without silently changing stored names', () => {
  const { validateExperimentVariants } = api();
  for (const name of ['', '  ', '长'.repeat(61), null]) assert.ok(validateExperimentVariants([{ ...group('a', 'control', 50), name }, group('b', 'treatment', 50)]));
  assert.ok(validateExperimentVariants([{ ...group('a', 'control', 50), name: 'Same' }, { ...group('b', 'treatment', 50), name: ' same ' }]));
  const variants = [{ ...group('a', 'control', 50), name: '  基准组  ' }, group('b', 'treatment', 50)];
  assert.equal(validateExperimentVariants(variants), null);
  assert.equal(variants[0].name, '  基准组  ');
});

test('new weights use positive integer basis points and must sum to exactly 100 percent', () => {
  const { validateExperimentVariants, selectExperimentVariant } = api();
  const precise = [group('a', 'control', 0.1), group('b', 'treatment', 0.2), group('c', 'treatment', 99.7)];
  assert.equal(validateExperimentVariants(precise), null);
  assert.equal(selectExperimentVariant(precise, 9), precise[0]);
  assert.equal(selectExperimentVariant(precise, 10), precise[1]);
  assert.equal(selectExperimentVariant(precise, 29), precise[1]);
  assert.equal(selectExperimentVariant(precise, 30), precise[2]);
  assert.equal(selectExperimentVariant(precise, 9999), precise[2]);
  assert.equal(validateExperimentVariants([group('a', 'control', 0.01), group('b', 'treatment', 99.99)]), null);
  for (const weights of [[0, 100], [-1, 101], [50, 49.99], [50, 50.01], [0.001, 99.999], [NaN, 50], [Infinity, 50], ['50', 50]]) assert.ok(validateExperimentVariants([group('a', 'control', weights[0]), group('b', 'treatment', weights[1])]));
});

test('legacy metadata-free groups keep their names, order, fallback identity and original fractional-weight boundaries', () => {
  const { validateExperimentVariants, getVariantRole, getVariantId, selectExperimentVariant } = api();
  const variants = [{ name: 'Historical baseline', weight: 0.1, value: '{}' }, { name: 'Historical treatment', weight: 0.2, value: '{}' }, { name: 'Old third group', weight: 99.7, value: '{}' }];
  const before = structuredClone(variants);
  assert.equal(validateExperimentVariants(variants), null);
  assert.equal(getVariantRole(variants[0], 0), 'control');
  assert.equal(getVariantRole(variants[1], 1), 'treatment');
  assert.equal(getVariantId(variants[2], 2), 'legacy-3');
  assert.equal(selectExperimentVariant(variants, 30), variants[1], 'Preserve the old percent-sum comparison, including historical floating-point boundaries');
  const fractional = [{ ...variants[0], weight: 1.001 }, { ...variants[1], weight: 98.999 }];
  assert.equal(validateExperimentVariants(fractional), null);
  assert.equal(selectExperimentVariant(fractional, 100), fractional[0]);
  assert.deepEqual(variants, before);
});

test('three-group simulation resolves every branch and carries stable IDs and roles without moving the control', () => {
  const { getVariantId, getVariantRole } = api();
  const e = experiment(), before = structuredClone(e), reached = new Set();
  assert.equal(validateAllocation(e, [e], defaultTopology), null);
  for (let i = 0; i < 120; i++) {
    const result = simulateAllocation(`multi_group_${i}`, [e], defaultTopology);
    assert.equal(result.error, undefined);
    const decision = result.decisions.find(item => item.experimentId === e.id);
    if (!decision) continue;
    const index = e.variants.findIndex(variant => variant.id === decision.variantId);
    assert.ok(index >= 0);
    assert.equal(decision.variantId, getVariantId(e.variants[index], index));
    assert.equal(decision.variantRole, getVariantRole(e.variants[index], index));
    assert.deepEqual(decision.parameters, JSON.parse(e.variants[index].value));
    const trace = result.trace.find(item => item.kind === 'experiment' && item.id === e.id);
    assert.equal(trace.variantId, decision.variantId);
    assert.equal(trace.variantRole, decision.variantRole);
    reached.add(decision.variantId);
  }
  assert.equal(reached.size, 3);
  assert.deepEqual(e, before);
});

test('adding IDs and choosing a non-first control changes labels only for existing exact-weight assignments', () => {
  api();
  const modern = experiment(), legacy = structuredClone(modern);
  legacy.variants = legacy.variants.map(({ id, role, ...variant }) => variant);
  const signature = result => ({ entered: result.enteredDomains, decisions: result.decisions.map(({ layerId, bucket, experimentId, variant, parameters }) => ({ layerId, bucket, experimentId, variant, parameters })), merged: result.mergedParameters });
  for (let i = 0; i < 100; i++) assert.deepEqual(signature(simulateAllocation(`multi_stable_${i}`, [modern], defaultTopology)), signature(simulateAllocation(`multi_stable_${i}`, [legacy], defaultTopology)));
});

test('malformed groups fail allocation and simulation before any partial execution', () => {
  api();
  for (const variants of [null, [null], [group('only', 'control', 100)], [group('a', 'control', 50), group('b', 'control', 50)]]) {
    const e = experiment({ variants });
    assert.doesNotThrow(() => validateAllocation(e, [e], defaultTopology));
    assert.ok(validateAllocation(e, [e], defaultTopology));
    const result = simulateAllocation('invalid_variants', [e], defaultTopology);
    assert.ok(result.error);
    assert.deepEqual(result.mergedParameters, {});
    assert.equal(result.decisions.length, 0);
  }
});

test('every additional group must still supply a valid complete parameter payload after combination rules are retired', () => {
  api();
  for (const value of ['{}', '[1]', 'null', '{broken', '{"ranking.model":"c","ui.layout":"outside"}']) {
    const e = experiment();
    e.variants[2].value = value;
    assert.ok(validateAllocation(e, [e], defaultTopology));
    const result = simulateAllocation('third_group_payload', [e], defaultTopology);
    assert.ok(result.error);
    assert.deepEqual(result.mergedParameters, {});
  }
});

test('retired parameter rules never block runtime, and historical rule bytes are preserved', () => {
  api();
  for (const parameterRules of [null, 'bad archive', [{ id: 'retired', ifKey: 'ranking.model', ifValue: '"variant-a"', thenKey: 'ranking.model', thenValue: '"incompatible"' }]]) {
    const e = experiment({ parameterRules }), before = structuredClone(e);
    assert.equal(validateAllocation(e, [e], defaultTopology), null);
    assert.equal(simulateAllocation('retired_rules', [e], defaultTopology).error, undefined);
    assert.deepEqual(e, before);
  }
});

test('retired coordination rules are ignored while declared legacy execution bindings still validate', () => {
  api();
  const e = experiment({ coordination: { bindings: [
    { id: 'consumer-web', target: 'frontend', system: 'web', owner: '体验组', parameterKeys: ['ranking.model'], artifactRefs: ['web-a', 'web-b', 'web-c'] },
    { id: 'consumer-rank', target: 'strategy', system: 'rank', owner: '算法组', parameterKeys: ['ranking.model'], artifactRefs: ['rank-a', 'rank-b', 'rank-c'] },
  ], rules: null } });
  const before = structuredClone(e);
  assert.equal(validateAllocation(e, [e], defaultTopology), null);
  assert.equal(simulateAllocation('retired_coordination', [e], defaultTopology).error, undefined);
  assert.deepEqual(e, before);
  e.coordination.bindings[0].artifactRefs.pop();
  assert.match(validateAllocation(e, [e], defaultTopology), /每个.*版本/);
  assert.ok(simulateAllocation('broken_binding', [e], defaultTopology).error);
});
