import test from 'node:test';
import assert from 'node:assert/strict';
import { initialExperiments } from '../src/data.ts';
import { validateCoordination } from '../src/coordination.ts';
import { compatibleLayers, defaultTopology, validateAllocation, simulateAllocation, saveTopology } from '../src/traffic.ts';

const fixture = () => {
  const experiment = structuredClone(initialExperiments.find(e => e.id === 'EXP-1101'));
  experiment.coordination = {
    bindings: [
      { id: 'ui', target: 'frontend', system: 'checkout-web', owner: '体验团队', parameterKeys: ['ui.layout'], artifactRefs: ['web@v1', 'web@v2'] },
      { id: 'api', target: 'backend', system: 'checkout-service', owner: '交易团队', parameterKeys: ['checkout.parallel', 'ui.layout'], artifactRefs: ['api@v1', 'api@v2'] },
      { id: 'rank', target: 'strategy', system: 'ranking-model', owner: '算法团队', parameterKeys: ['ranking.model'], artifactRefs: ['model@v1', 'model@v2'] },
    ],
    rules: [{ id: 'compatibility', ifKey: 'ranking.model', ifValue: '"rank_v2"', thenKey: 'checkout.parallel', thenValue: 'true' }],
  };
  return experiment;
};

test('legacy experiments keep their behavior and multi-end consumers may share the same parameter', () => {
  assert.equal(validateCoordination(initialExperiments[0]), null);
  assert.equal(validateCoordination(fixture()), null);
  assert.equal(validateAllocation(fixture(), initialExperiments), null);
});

test('bindings require distinct identities, two endpoint types, complete ownership, and each variant artifact', () => {
  const mutations = [
    e => { e.coordination.bindings = []; },
    e => { e.coordination.bindings.forEach(b => { b.target = 'backend'; }); },
    e => { e.coordination.bindings[1].id = 'ui'; },
    e => { e.coordination.bindings[1].target = 'frontend'; e.coordination.bindings[1].system = 'checkout-web'; },
    e => { e.coordination.bindings[0].owner = ' '; },
    e => { e.coordination.bindings[0].system = ''; },
    e => { e.coordination.bindings[0].target = 'invalid'; },
    e => { e.coordination.bindings[0].artifactRefs.pop(); },
    e => { e.coordination.bindings[0].artifactRefs[1] = ''; },
    e => { e.coordination.bindings[0].parameterKeys = []; },
    e => { e.coordination.bindings[0].parameterKeys = ['ui.cart']; },
    e => { e.coordination.bindings[0].parameterKeys = ['ui.layout', 'ui.layout']; },
    e => { e.coordination.bindings.pop(); },
    e => { e.coordination.bindings[0] = null; },
  ];
  for (const mutate of mutations) { const e = fixture(); mutate(e); assert.ok(validateCoordination(e), mutate.toString()); }
});

test('dependencies validate every variant, preserve strict types and distinguish an untriggered rule', () => {
  const e = fixture();
  e.variants[1].value = JSON.stringify({ 'ui.layout': 'compact', 'ranking.model': 'rank_v2', 'checkout.parallel': false });
  assert.match(validateCoordination(e), /实验组 B.*违反联动规则/);
  e.coordination.rules[0].ifValue = '"unselected-model"';
  assert.equal(validateCoordination(e), null);
  e.coordination.rules[0].ifValue = '"rank_v2"';
  e.coordination.rules[0].thenValue = '"false"';
  assert.ok(validateCoordination(e), 'Boolean false must not equal the string false');
  e.coordination.rules[0].thenValue = 'false';
  assert.equal(validateCoordination(e), null);
});

test('rule equality supports structured JSON without treating object key order as a difference', () => {
  const e = fixture();
  e.variants.forEach(v => { v.value = JSON.stringify({ 'ui.layout': { b: [0, false, null], a: 1 }, 'ranking.model': 'same', 'checkout.parallel': 0 }); });
  e.coordination.rules = [{ id: 'objects', ifKey: 'ui.layout', ifValue: '{"a":1,"b":[0,false,null]}', thenKey: 'checkout.parallel', thenValue: '0' }];
  assert.equal(validateCoordination(e), null);
  e.coordination.rules[0].thenValue = 'null';
  assert.ok(validateCoordination(e));
});

test('malformed, nonfinite, missing, duplicate or out-of-scope dependency rules are rejected', () => {
  for (const mutate of [
    e => { e.coordination.rules[0].ifValue = '{broken'; },
    e => { e.coordination.rules[0].thenValue = '1e9999'; },
    e => { e.coordination.rules[0].ifKey = 'ui.cart'; },
    e => { e.coordination.rules.push({ ...e.coordination.rules[0] }); },
    e => { e.coordination.rules = Array.from({ length: 13 }, (_, index) => ({ ...e.coordination.rules[0], id: `r${index}` })); },
    e => { e.variants[0].value = '{}'; },
    e => { e.variants[0].value = 'null'; },
    e => { e.variants[0].value = '{bad'; },
  ]) { const e = fixture(); mutate(e); assert.ok(validateCoordination(e), mutate.toString()); }
});

test('multi-end contracts cannot bypass layer boundaries and compatible layers respect inherited scope', () => {
  const e = fixture();
  e.domainId = 'overlap'; e.layerId = 'presentation'; e.traffic = 5; e.bucketStart = 90;
  assert.match(validateAllocation(e, initialExperiments), /本层之外/);
  const candidates = compatibleLayers(e.parameterKeys, defaultTopology);
  assert.deepEqual(candidates.map(l => l.id), ['full']);
  assert.ok(!candidates.some(l => l.id === 'ui-full'), 'A nested UI isolation domain does not inherit ranking or checkout');
  assert.deepEqual(compatibleLayers(['unknown.parameter']), []);
});

test('a multi-end experiment can run within one ordinary layer without full-domain isolation', () => {
  const e = structuredClone(initialExperiments.find(e => e.id === 'EXP-1027'));
  e.coordination = { bindings: fixture().coordination.bindings.slice(0, 2).map(b => ({ ...b, parameterKeys: ['ui.layout'] })), rules: [] };
  assert.equal(validateAllocation(e, initialExperiments), null);
});

test('adding endpoint bindings never creates another randomization or changes a returned parameter bundle', () => {
  const e = fixture();
  const linked = initialExperiments.map(old => old.id === e.id ? e : old);
  let hits = 0;
  for (let i = 0; i < 250; i++) {
    const unit = `joint_contract_${i}`;
    const before = simulateAllocation(unit, initialExperiments);
    const after = simulateAllocation(unit, linked);
    assert.deepEqual(after, before);
    const hit = after.decisions.find(d => d.experimentId === e.id);
    if (hit) { hits++; assert.deepEqual(hit.parameters, JSON.parse(e.variants.find(v => v.name === hit.variant).value)); }
  }
  assert.ok(hits > 0);
});

test('invalid running contracts block topology submission and simulation before any partial execution', () => {
  const e = fixture();
  e.coordination.bindings[0].artifactRefs[1] = '';
  const invalid = initialExperiments.map(old => old.id === e.id ? e : old);
  assert.ok(saveTopology(defaultTopology, invalid));
  const result = simulateAllocation('user_5', invalid);
  assert.ok(result.error);
  assert.deepEqual(result.mergedParameters, {});
  assert.equal(result.decisions.length, 0);
});
