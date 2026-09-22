import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTopology, domainLayers, domainScope, layerScope, planLayerCreation, simulateAllocation, validateTopology } from '../src/traffic.ts';
import { initialExperiments } from '../src/data.ts';
import { planParameterRegistration } from '../src/parameter-registration.ts';

let implementation;
try { implementation = await import('../src/child-domain-creation.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
function api() { assert.ok(implementation, 'Single-initial-layer child domain planning is not implemented yet'); return implementation; }
const base = () => structuredClone(defaultTopology);
const input = (changes = {}) => ({ id: 'child-v18', parentLayerId: 'transaction', name: '交易探索域', mode: 'overlapping', traffic: 10, ...changes });
function success(plan) { assert.equal(plan.ok, true, plan.error); assert.ok(plan.topology); return plan.topology; }
function rejected(plan, pattern) { assert.equal(plan.ok, false); assert.ok(plan.error); assert.equal('topology' in plan, false); if (pattern) assert.match(plan.error, pattern); }
function experiment(id, changes = {}) {
  const source = initialExperiments.find(item => item.layerId === 'ranking' && item.status === 'running');
  const result = { ...structuredClone(source), id, name: id, key: id, traffic: 30, bucketStart: 0, audience: '全部活跃用户', ...changes };
  delete result.audienceId;
  return result;
}

test('both child modes create exactly one ordinary initial layer inheriting the entire parent scope', () => {
  const { planChildDomainCreation } = api();
  for (const mode of ['overlapping', 'non-overlapping']) {
    const topology = base(), before = structuredClone(topology);
    const plan = planChildDomainCreation(input({ mode, name: '  交易探索域  ' }), [], topology);
    const next = success(plan);
    assert.equal(plan.domainId, 'child-v18');
    const domain = next.domains.find(item => item.id === plan.domainId);
    assert.equal(domain.name, '交易探索域');
    assert.equal(domain.mode, mode);
    assert.equal(domain.parentLayerId, 'transaction');
    assert.equal(domain.unit, 'user_id');
    assert.equal(domain.start, 0);
    assert.equal(domain.traffic, 10);
    const children = domainLayers(domain.id, next);
    assert.equal(children.length, 1);
    assert.equal(children[0].id, 'child-v18-initial');
    assert.equal(children[0].name, '初始参数层');
    assert.equal(children[0].role, 'normal');
    assert.deepEqual(children[0].parameterKeys, ['*']);
    assert.deepEqual(layerScope(children[0].id, next), layerScope('transaction', topology));
    assert.equal(validateTopology(next, []), null);
    assert.deepEqual(topology, before);
    assert.deepEqual(next.layers.filter(layer => layer.domainId !== domain.id), before.layers);
    assert.deepEqual(next.domains.filter(item => item.id !== domain.id), before.domains);
  }
});

test('a one-parameter parent can create an overlapping child with one complete initial layer', () => {
  const { planChildDomainCreation } = api();
  const topology = base();
  assert.deepEqual(layerScope('card-layout', topology), ['ui.content_card']);
  const next = success(planChildDomainCreation(input({ parentLayerId: 'card-layout', traffic: 100 }), [], topology));
  assert.equal(next.domains.find(domain => domain.id === 'child-v18').mode, 'overlapping');
  assert.deepEqual(layerScope('child-v18-initial', next), ['ui.content_card']);
  assert.equal(validateTopology(next, []), null);
});

test('overlapping children can subsequently split their initial wildcard through the existing layer planner', () => {
  const { planChildDomainCreation } = api();
  const original = base();
  const child = success(planChildDomainCreation(input(), [], original));
  const beforeSplit = structuredClone(child);
  const split = planLayerCreation({ id: 'child-extra', domainId: 'child-v18', name: '优惠参数层', description: '', parameterKeys: ['pricing.coupon'] }, [], child);
  assert.equal(split.error, null);
  const next = split.topology;
  assert.ok(next);
  assert.deepEqual(layerScope('child-extra', next), ['pricing.coupon']);
  assert.deepEqual(layerScope('child-v18-initial', next), ['checkout.cache_ttl', 'checkout.parallel', 'checkout.inventory']);
  assert.equal(next.layers.find(layer => layer.id === 'child-v18-initial').name, '初始参数层');
  const partition = domainLayers('child-v18', next).flatMap(layer => layerScope(layer.id, next));
  assert.equal(new Set(partition).size, partition.length);
  assert.deepEqual(partition.sort(), domainScope('child-v18', next).sort());
  assert.deepEqual(child, beforeSplit);
  assert.deepEqual(layerScope('transaction', next), layerScope('transaction', original));
  assert.equal(validateTopology(next, []), null);
});

test('non-overlapping children retain one layer and non-overlapping ancestry rejects new overlapping modes', () => {
  const { planChildDomainCreation } = api();
  const topology = base();
  rejected(planChildDomainCreation(input({ parentLayerId: 'full', mode: 'overlapping' }), [], topology), /非重叠/);
  const isolated = success(planChildDomainCreation(input({ parentLayerId: 'full', mode: 'non-overlapping' }), [], topology));
  const denied = planLayerCreation({ id: 'forbidden-extra', domainId: 'child-v18', name: '不得并行', description: '', parameterKeys: [] }, [], isolated);
  assert.match(denied.error, /非重叠/);
  rejected(planChildDomainCreation(input({ id: 'grandchild', parentLayerId: 'child-v18-initial', mode: 'overlapping' }), [], isolated), /非重叠/);
  const grandchild = success(planChildDomainCreation(input({ id: 'grandchild', parentLayerId: 'child-v18-initial', mode: 'non-overlapping' }), [], isolated));
  assert.deepEqual(layerScope('grandchild-initial', grandchild), layerScope('full', topology));
  assert.equal(validateTopology(grandchild, []), null);
});

test('allocation uses current reservations and preserves every existing experiment bucket, payload and assignment', () => {
  const { planChildDomainCreation } = api();
  const topology = base(), first = experiment('existing-first'), second = experiment('existing-second', { bucketStart: 35, traffic: 25, status: 'review' });
  const request = input({ parentLayerId: 'ranking', traffic: 10 });
  assert.equal(success(planChildDomainCreation(request, [first], topology)).domains.at(-1).start, 30);
  const existing = [first, second], before = JSON.stringify({ topology, existing, request });
  const next = success(planChildDomainCreation(request, existing, topology));
  assert.equal(next.domains.at(-1).start, 30);
  assert.deepEqual(next.domains.at(-1).bucketRanges, [{ start: 3000, end: 3500 }, { start: 6000, end: 6500 }]);
  assert.equal(JSON.stringify({ topology, existing, request }), before);
  for (let index = 0; index < 40; index++) {
    const user = `child-preserve-${index}`;
    const oldResult = simulateAllocation(user, existing, topology), newResult = simulateAllocation(user, existing, next);
    assert.equal(oldResult.error, undefined);
    assert.equal(newResult.error, undefined);
    const hits = result => result.decisions.filter(decision => decision.experimentId).map(({ experimentId, variant, parameters, bucket }) => ({ experimentId, variant, parameters, bucket }));
    assert.deepEqual(hits(newResult), hits(oldResult));
  }
});

test('full same-bucket child reuse requires a disjoint fixed audience version', () => {
  const { planChildDomainCreation } = api();
  const first = success(planChildDomainCreation(input({ id: 'new-users-child', parentLayerId: 'ranking', traffic: 100, audienceId: 'new-users-v1' }), [], base()));
  const next = success(planChildDomainCreation(input({ id: 'old-users-child', parentLayerId: 'ranking', traffic: 100, audienceId: 'returning-users-v1' }), [], first));
  assert.equal(next.domains.find(domain => domain.id === 'old-users-child').start, 0);
  assert.equal(next.domains.find(domain => domain.id === 'old-users-child').audienceId, 'returning-users-v1');
  const before = JSON.stringify(first);
  rejected(planChildDomainCreation(input({ id: 'same-users-child', parentLayerId: 'ranking', traffic: 1, audienceId: 'new-users-v1' }), [], first), /连续|可用/);
  assert.equal(JSON.stringify(first), before);
});

test('unknown audiences and contradictions with inherited eligibility are rejected before creation', () => {
  const { planChildDomainCreation } = api();
  const topology = base();
  for (const audienceId of ['missing-version', '', null, 42]) rejected(planChildDomainCreation(input({ audienceId }), [], topology), /受众/);
  topology.domains.find(domain => domain.id === 'overlap').audienceId = 'new-users-v1';
  const before = JSON.stringify(topology);
  rejected(planChildDomainCreation(input({ audienceId: 'returning-users-v1' }), [], topology), /祖先|交集|矛盾/);
  assert.equal(JSON.stringify(topology), before);
});

test('missing and empty parent layers cannot create a runnable child domain', () => {
  const { planChildDomainCreation } = api();
  const topology = base();
  topology.layers.push({ id: 'empty-parent', domainId: 'overlap', name: '空父层', description: '', parameterKeys: [] });
  const before = JSON.stringify(topology);
  rejected(planChildDomainCreation(input({ parentLayerId: 'missing-parent' }), [], topology), /父层.*不存在|未找到.*父层/);
  rejected(planChildDomainCreation(input({ parentLayerId: 'empty-parent' }), [], topology), /空|待配置|分配参数/);
  assert.equal(JSON.stringify(topology), before);
});

test('invalid names, modes, traffic and node or experiment identifier collisions fail without partial output', () => {
  const { planChildDomainCreation } = api();
  const topology = base(), existing = [experiment('exp-collision'), experiment('reserved-initial', { status: 'completed' })];
  const before = JSON.stringify({ topology, existing });
  for (const changes of [
    { name: '' }, { name: '  ' }, { name: '长'.repeat(41) }, { name: 42 },
    { mode: 'parallel' }, { traffic: 0 }, { traffic: 101 }, { traffic: 1.001 }, { traffic: NaN }, { traffic: Infinity }, { traffic: '10' },
    { id: '' }, { id: 'root' }, { id: 'transaction' }, { id: 'exp-collision' }, { id: 'reserved' },
  ]) rejected(planChildDomainCreation(input(changes), existing, topology));
  const collision = base();
  collision.layers.push({ id: 'child-v18-initial', domainId: 'overlap', name: '已有空层', description: '', parameterKeys: [] });
  rejected(planChildDomainCreation(input(), [], collision), /标识|重复/);
  assert.equal(JSON.stringify({ topology, existing }), before);
});

test('fragmented free capacity is combined for a child and only insufficient total capacity rejects', () => {
  const { planChildDomainCreation } = api();
  const topology = base(), existing = [experiment('first'), experiment('middle', { bucketStart: 40 }), experiment('last', { bucketStart: 80, traffic: 10, status: 'paused' })];
  const before = JSON.stringify({ topology, existing });
  const next = success(planChildDomainCreation(input({ parentLayerId: 'ranking', traffic: 15 }), existing, topology));
  assert.deepEqual(next.domains.at(-1).bucketRanges, [{ start: 3000, end: 4000 }, { start: 7000, end: 7500 }]);
  rejected(planChildDomainCreation(input({ parentLayerId: 'ranking', traffic: 30.01 }), existing, topology), /3001.*3000|可用/);
  assert.equal(JSON.stringify({ topology, existing }), before);
});

test('child creation accepts one bucket and exact full capacity with explicit ranges', () => {
  const { planChildDomainCreation } = api();
  for (const [traffic, end] of [[0.01, 1], [1.5, 150], [100, 10000]]) {
    const next = success(planChildDomainCreation(input({ traffic }), [], base()));
    assert.equal(next.domains.at(-1).traffic, traffic);
    assert.deepEqual(next.domains.at(-1).bucketRanges, [{ start: 0, end }]);
    assert.equal(domainLayers('child-v18', next).length, 1);
    assert.deepEqual(layerScope('child-v18-initial', next), layerScope('transaction', base()));
  }
});

test('pending parameters and application metadata stay unchanged and wildcard inheritance cannot activate them', () => {
  const { planChildDomainCreation } = api();
  const registration = planParameterRegistration({ key: 'pricing.pending_v18', name: '待归层参数', type: 'number', defaultValue: 1, owner: '策略组', description: '尚未归层', serviceId: 'pricing-service', tagIds: [] }, [], base());
  assert.equal(registration.error, null);
  const topology = registration.topology, before = structuredClone(topology);
  const next = success(planChildDomainCreation(input(), [], topology));
  assert.deepEqual(next.catalog, before.catalog);
  assert.deepEqual(next.parameters, before.parameters);
  assert.deepEqual(next.pendingParameterKeys, ['pricing.pending_v18']);
  assert.equal(layerScope('child-v18-initial', next).includes('pricing.pending_v18'), false);
  assert.deepEqual(topology, before);
  next.catalog.services[0].name = '修改返回副本';
  next.layers[0].description = '修改返回副本';
  assert.deepEqual(topology, before, 'Returned candidate must not share writable structures with the input');
});

test('invalid existing topology or invalid reserved experiments are not concealed by adding an initial layer', () => {
  const { planChildDomainCreation } = api();
  const invalid = base();
  invalid.layers.find(layer => layer.id === 'ranking').parameterKeys.push('ui.layout');
  rejected(planChildDomainCreation(input(), [], invalid), /唯一归层|重复/);
  const badExperiment = experiment('bad-existing', { parameterKeys: ['ui.layout'] });
  const topology = base(), before = JSON.stringify({ topology, badExperiment });
  rejected(planChildDomainCreation(input(), [badExperiment], topology), /bad-existing|本层之外/);
  assert.equal(JSON.stringify({ topology, badExperiment }), before);
});
