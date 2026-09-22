import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { initialExperiments } from '../src/data.ts';
import {
  defaultTopology, parameterKeys, activeParameterKeys, isParameterPending, layerScope, domainScope,
  domainLayers, maxConcurrent, findAvailableStart, compatibleLayers, validateTopology, validateAllocation,
  planLayerCreation, newLayerRegistrationAssignments, layerParameterOptions, simulateAllocation,
} from '../src/traffic.ts';
import { planParameterRegistration, planParameterLayerAssignment, registrationAssignments } from '../src/parameter-registration.ts';
import { getParameterRelationships } from '../src/parameter-relations.ts';

const base = () => structuredClone(defaultTopology);
const input = (changes = {}) => ({ key: 'ui.pending_density', name: '待配置密度', type: 'number', defaultValue: 0.5, owner: '体验组', description: '', serviceId: 'ui-web', tagIds: [], ...changes });
const newLayer = (changes = {}) => ({ id: 'new-config-layer', name: '待配置层', domainId: 'overlap', parameterKeys: [], description: '', ...changes });
const register = (topology = base(), changes = {}) => planParameterRegistration(input(changes), initialExperiments, topology);
function ok(plan) { assert.equal(plan.error, null); assert.ok(plan.topology); return plan.topology; }
function rejected(plan, pattern) { assert.equal(plan.topology, null); assert.ok(plan.error); if (pattern) assert.match(plan.error, pattern); }
const owners = (key, topology) => topology.layers.filter(layer => layerScope(layer.id, topology).includes(key)).map(layer => layer.id).sort();
function assertCompletePartition(topology) {
  assert.equal(validateTopology(topology, initialExperiments), null);
  for (const domain of topology.domains) {
    const all = domainLayers(domain.id, topology).flatMap(layer => layerScope(layer.id, topology));
    assert.equal(new Set(all).size, all.length, domain.id);
    assert.deepEqual(all.sort(), domainScope(domain.id, topology).sort(), domain.id);
  }
}
function experiment(layerId, topology, keys = [], changes = {}) {
  const source = initialExperiments.find(item => item.layerId === 'ranking' && item.status === 'running');
  return { ...structuredClone(source), id: 'lifecycle-experiment', name: '生命周期实验', domainId: topology.layers.find(layer => layer.id === layerId).domainId, layerId, traffic: 10, bucketStart: 0, parameterKeys: keys,
    variants: source.variants.map(variant => ({ ...variant, value: JSON.stringify(Object.fromEntries(keys.map(key => [key, 0.5]))) })), ...changes };
}
function browserProcess(script, input = {}) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const values = new Map(Object.entries(input.entries ?? {}));
    let failStorage = false;
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (failStorage) throw new Error('Quota exceeded'); values.set(key, value); } }, configurable: true });
    const traffic = await import('./src/traffic.ts');
    ${script}
  `], { cwd: new URL('..', import.meta.url), input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('registration alone needs no layer, creates pending metadata, and leaves every wildcard and live allocation unchanged', () => {
  const topology = base(), before = structuredClone(topology);
  const registered = ok(register(topology));
  assert.deepEqual(topology, before);
  assert.ok(parameterKeys(registered).includes(input().key));
  assert.deepEqual(activeParameterKeys(registered), parameterKeys(before));
  assert.deepEqual(registered.pendingParameterKeys, [input().key]);
  assert.equal(isParameterPending(input().key, registered), true);
  assert.deepEqual(registered.layers, before.layers);
  assert.deepEqual(registered.domains, before.domains);
  assert.deepEqual(owners(input().key, registered), []);
  assert.deepEqual(compatibleLayers([input().key], registered), []);
  const relationships = getParameterRelationships(input().key, initialExperiments, registered);
  assert.equal(relationships.pending, true);
  assert.deepEqual(relationships.owners, []);
  assert.deepEqual(relationships.issues, []);
  assertCompletePartition(registered);
  for (let index = 0; index < 80; index++) assert.deepEqual(simulateAllocation(`pending_${index}`, initialExperiments, registered), simulateAllocation(`pending_${index}`, initialExperiments, before));
  rejected(planParameterLayerAssignment(input().key, {}, initialExperiments, registered), /请选择/);
  assert.match(validateAllocation(experiment('full', registered, [input().key]), [], registered), /待归层/);
});

test('the compatibility registration signature never auto-assigns even when old layer choices are supplied', () => {
  for (const selections of [{ overlap: 'ranking' }, { overlap: 'removed' }, {}]) {
    const registered = ok(planParameterRegistration(input(), selections, initialExperiments, base()));
    assert.equal(isParameterPending(input().key, registered), true);
    assert.deepEqual(owners(input().key, registered), []);
  }
});

test('an empty ordinary layer is valid configuration but reserves no runnable branch and accepts neither experiments nor child domains', () => {
  const topology = ok(planLayerCreation(newLayer(), initialExperiments, base()));
  assertCompletePartition(topology);
  assert.deepEqual(layerScope('new-config-layer', topology), []);
  assert.equal(maxConcurrent('root', topology), maxConcurrent('root', defaultTopology));
  assert.equal(findAvailableStart('new-config-layer', 1, [], undefined, topology), null);
  for (let index = 0; index < 40; index++) assert.deepEqual(simulateAllocation(`empty_${index}`, initialExperiments, topology), simulateAllocation(`empty_${index}`, initialExperiments, defaultTopology));
  const aa = experiment('new-config-layer', topology);
  assert.match(validateAllocation(aa, [], topology), /空参数层/);
  assert.match(validateTopology(topology, [aa]), /空参数层/);
  assert.match(validateTopology(topology, [{ ...aa, status: 'draft' }]), /空参数层/);
  const child = structuredClone(topology);
  child.domains.push({ id: 'empty-child', name: '非法空层子域', mode: 'overlapping', parentLayerId: 'new-config-layer', start: 0, traffic: 10, unit: 'user_id', description: '' });
  child.layers.push({ id: 'empty-child-layer', name: '子层', domainId: 'empty-child', parameterKeys: ['*'], description: '' });
  assert.match(validateTopology(child), /空参数层/);
  assert.equal(validateAllocation(experiment('ranking', topology), [], topology), null, 'A/A with an empty payload remains valid inside an assigned nonempty layer');
  for (const domainId of ['root', 'exclusive', 'ui-isolation']) rejected(planLayerCreation(newLayer({ domainId }), [], topology));
});

test('register, create empty layer, then assign completes the lifecycle without needing an existing parameter in the new layer', () => {
  const registered = ok(register());
  const empty = ok(planLayerCreation(newLayer(), initialExperiments, registered));
  const before = structuredClone(empty);
  const assigned = ok(planParameterLayerAssignment(input().key, { overlap: 'new-config-layer' }, initialExperiments, empty));
  assert.deepEqual(empty, before);
  assert.equal(isParameterPending(input().key, assigned), false);
  assert.deepEqual(owners(input().key, assigned), ['full', 'new-config-layer', 'root-layer']);
  assertCompletePartition(assigned);
  assert.equal(findAvailableStart('new-config-layer', 10, initialExperiments, undefined, assigned), 0);
  assert.equal(maxConcurrent('root', assigned), maxConcurrent('root', empty) + 1);
  assert.equal(validateAllocation(experiment('new-config-layer', assigned, [input().key]), initialExperiments, assigned), null);
  assert.equal(getParameterRelationships(input().key, initialExperiments, assigned).pending, false);
  rejected(planParameterLayerAssignment(input().key, { overlap: 'ranking' }, initialExperiments, assigned), /已完成归层/);
});

test('creating a layer can activate several pending parameters together and preserve parameters still awaiting assignment', () => {
  let registered = ok(register());
  registered = ok(register(registered, { key: 'ranking.pending_weight', serviceId: 'ranking-service' }));
  registered = ok(register(registered, { key: 'checkout.pending_ttl', serviceId: 'checkout-service' }));
  const selection = newLayer({ parameterKeys: [input().key, 'ranking.pending_weight'] });
  const rows = newLayerRegistrationAssignments(selection, registered);
  assert.equal(rows.find(row => row.domainId === 'overlap').layerId, selection.id);
  assert.equal(rows.find(row => row.domainId === 'overlap').forced, true);
  const assigned = ok(planLayerCreation(selection, initialExperiments, registered));
  assertCompletePartition(assigned);
  assert.deepEqual(layerScope(selection.id, assigned), selection.parameterKeys);
  assert.deepEqual(assigned.pendingParameterKeys, ['checkout.pending_ttl']);
  assert.deepEqual(owners('checkout.pending_ttl', assigned), []);
  for (const key of selection.parameterKeys) assert.deepEqual(owners(key, assigned), ['full', 'new-config-layer', 'root-layer']);
  assert.ok(layerParameterOptions('overlap', initialExperiments, registered).find(option => option.key === input().key)?.pending);
});

function extraPresentationBranch(topology = base(), wildcard = false) {
  topology.domains.push({ id: 'sibling-branch', name: '并列继承分支', mode: 'overlapping', parentLayerId: 'presentation', start: 90, traffic: 10, unit: 'user_id', description: '' });
  topology.layers.push({ id: 'sibling-navigation', name: '并列导航层', domainId: 'sibling-branch', parameterKeys: wildcard ? ['*'] : ['ui.layout', 'ui.onboarding', 'ui.membership'], description: '' });
  if (!wildcard) topology.layers.push({ id: 'sibling-content', name: '并列内容层', domainId: 'sibling-branch', parameterKeys: ['ui.cart', 'ui.content_card'], description: '' });
  assertCompletePartition(topology);
  return topology;
}

test('deep layer creation locks all ancestor choices and requires every other inherited branch before activating anything', () => {
  const registered = ok(register(extraPresentationBranch()));
  const selection = newLayer({ domainId: 'card-depth', parameterKeys: [input().key] });
  const rows = newLayerRegistrationAssignments(selection, registered);
  for (const [domainId, layerId] of Object.entries({ root: 'root-layer', overlap: 'presentation', 'ui-mobile': 'ui-content', 'card-depth': selection.id })) {
    assert.equal(rows.find(row => row.domainId === domainId).layerId, layerId);
    assert.equal(rows.find(row => row.domainId === domainId).forced, true);
  }
  assert.equal(rows.find(row => row.domainId === 'sibling-branch').layerId, null);
  const before = structuredClone(registered);
  rejected(planLayerCreation(selection, initialExperiments, registered), /并列继承分支/);
  rejected(planLayerCreation({ ...selection, pendingSelections: { overlap: 'ranking', 'sibling-branch': 'sibling-content' } }, initialExperiments, registered), /强制路径/);
  rejected(planLayerCreation({ ...selection, pendingSelections: { 'sibling-branch': 'ranking' } }, initialExperiments, registered), /属于对应域/);
  assert.deepEqual(registered, before);
  const assigned = ok(planLayerCreation({ ...selection, pendingSelections: { 'sibling-branch': 'sibling-content' } }, initialExperiments, registered));
  assertCompletePartition(assigned);
  assert.deepEqual(owners(input().key, assigned), ['full', 'new-config-layer', 'presentation', 'root-layer', 'sibling-content', 'ui-content', 'ui-full']);
  assert.ok(!layerScope('ranking', assigned).includes(input().key));
  assert.ok(!layerScope(selection.id, assigned).includes('ranking.model'));
});

test('assigning into an empty sibling materializes an old wildcard without letting it steal the newly activated parameter', () => {
  const source = extraPresentationBranch(base(), true);
  const registered = ok(register(source));
  const empty = ok(planLayerCreation(newLayer({ domainId: 'sibling-branch' }), initialExperiments, registered));
  const rows = registrationAssignments({ overlap: 'presentation', 'ui-mobile': 'ui-navigation' }, empty);
  assert.equal(rows.find(row => row.domainId === 'sibling-branch').layerId, null);
  const assigned = ok(planParameterLayerAssignment(input().key, { overlap: 'presentation', 'ui-mobile': 'ui-navigation', 'sibling-branch': 'new-config-layer' }, initialExperiments, empty));
  assert.deepEqual(assigned.layers.find(layer => layer.id === 'sibling-navigation').parameterKeys, layerScope('sibling-navigation', source));
  assert.ok(!layerScope('sibling-navigation', assigned).includes(input().key));
  assert.deepEqual(layerScope('new-config-layer', assigned), [input().key]);
  assertCompletePartition(assigned);
});

test('pending parameters and transferable assigned parameters can share a new layer while protected active and inherited parameters stay put', () => {
  const registered = ok(register());
  const selection = newLayer({ parameterKeys: ['ranking.recall', input().key] });
  const assigned = ok(planLayerCreation(selection, initialExperiments, registered));
  assertCompletePartition(assigned);
  assert.deepEqual(layerScope(selection.id, assigned), selection.parameterKeys);
  assert.ok(!layerScope('ranking', assigned).includes('ranking.recall'));
  for (const key of ['ranking.model', 'ui.layout']) rejected(planLayerCreation({ ...selection, parameterKeys: [key, input().key] }, initialExperiments, registered), /未结束实验|子域继承/);
  for (const index of Array.from({ length: 40 }, (_, index) => index)) {
    const before = simulateAllocation(`mixed_${index}`, initialExperiments, registered);
    const after = simulateAllocation(`mixed_${index}`, initialExperiments, assigned);
    assert.deepEqual(after.mergedParameters, before.mergedParameters);
    assert.deepEqual(after.decisions.filter(decision => decision.layerId !== selection.id), before.decisions);
  }
});

test('malformed lifecycle state, explicit pending references and invalid assignment input cannot partially activate parameters', () => {
  const registered = ok(register()), before = structuredClone(registered);
  for (const pending of [null, 'ui.pending_density', [input().key, input().key], ['unknown.key'], ['ranking.model'], [null]]) {
    const invalid = structuredClone(registered); invalid.pendingParameterKeys = pending;
    assert.doesNotThrow(() => validateTopology(invalid));
    assert.match(validateTopology(invalid), /待归层参数/);
  }
  const explicit = structuredClone(registered); explicit.layers.find(layer => layer.id === 'ranking').parameterKeys.push(input().key);
  assert.match(validateTopology(explicit), /不能直接引用待归层参数/);
  for (const selections of [null, [], 'ranking', { overlap: null }, { overlap: 'full' }, { overlap: 'presentation' }, { overlap: 'presentation', 'ui-mobile': 'ui-content' }]) rejected(planParameterLayerAssignment(input().key, selections, initialExperiments, registered));
  rejected(planParameterLayerAssignment('not.registered', { overlap: 'ranking' }, initialExperiments, registered));
  assert.deepEqual(registered, before);
});

test('legacy snapshots without lifecycle metadata retain every active parameter and assignment after load', () => {
  const pending = ok(register());
  const assigned = ok(planParameterLayerAssignment(input().key, { overlap: 'ranking' }, initialExperiments, pending));
  delete assigned.pendingParameterKeys;
  const result = browserProcess(`process.stdout.write(JSON.stringify({ topology: traffic.getTopology(), active: traffic.activeParameterKeys(), pending: traffic.isParameterPending(input.key), error: traffic.getTopologyLoadError() }));`, { key: input().key, entries: { 'exp-lab-topology-v1': JSON.stringify(assigned) } });
  assert.equal(result.error, null);
  assert.equal(result.pending, false);
  assert.deepEqual(result.topology, assigned);
  assert.deepEqual(result.active, parameterKeys(assigned));
});

test('pending registration, an empty layer, and completed assignment each persist as a complete reloadable snapshot', () => {
  const pending = ok(register());
  const empty = ok(planLayerCreation(newLayer(), initialExperiments, pending));
  const assigned = ok(planParameterLayerAssignment(input().key, { overlap: 'new-config-layer' }, initialExperiments, empty));
  let entries = { 'exp-lab-experiments-v3': JSON.stringify(initialExperiments) };
  for (const topology of [pending, empty, assigned]) {
    const saved = browserProcess(`
      const error = traffic.saveTopology(input.topology, input.experiments);
      process.stdout.write(JSON.stringify({ error, topology: traffic.getTopology(), entries: Object.fromEntries(values) }));
    `, { topology, experiments: initialExperiments, entries });
    assert.equal(saved.error, null);
    assert.deepEqual(saved.topology, topology);
    entries = saved.entries;
    const reloaded = browserProcess(`process.stdout.write(JSON.stringify({ topology: traffic.getTopology(), pending: traffic.isParameterPending(input.key), error: traffic.getTopologyLoadError() }));`, { key: input().key, entries });
    assert.equal(reloaded.error, null);
    assert.deepEqual(reloaded.topology, topology);
    assert.equal(reloaded.pending, isParameterPending(input().key, topology));
    assert.deepEqual(JSON.parse(entries['exp-lab-experiments-v3']), initialExperiments);
  }
});

test('failed assignment storage retains pending state, empty scope, exact bytes and listeners until one atomic retry succeeds', () => {
  const pending = ok(register());
  const empty = ok(planLayerCreation(newLayer(), initialExperiments, pending));
  const assigned = ok(planParameterLayerAssignment(input().key, { overlap: 'new-config-layer' }, initialExperiments, empty));
  const result = browserProcess(`
    const before = structuredClone(traffic.getTopology()), bytes = values.get('exp-lab-topology-v1');
    let notifications = 0; traffic.subscribeTopology(() => notifications++);
    failStorage = true;
    const error = traffic.saveTopology(input.assigned, input.experiments);
    const failed = { topology: traffic.getTopology(), bytes: values.get('exp-lab-topology-v1'), notifications };
    failStorage = false;
    const retryError = traffic.saveTopology(input.assigned, input.experiments);
    process.stdout.write(JSON.stringify({ error, before, bytes, failed, retryError, after: traffic.getTopology(), notifications }));
  `, { assigned, experiments: initialExperiments, entries: { 'exp-lab-topology-v1': JSON.stringify(empty) } });
  assert.match(result.error, /存储失败/);
  assert.deepEqual(result.failed.topology, result.before);
  assert.equal(result.failed.bytes, result.bytes);
  assert.equal(result.failed.notifications, 0);
  assert.equal(result.retryError, null);
  assert.deepEqual(result.after, assigned);
  assert.equal(result.notifications, 1);
});

test('direct saves cannot revert assigned parameters to pending or drain an existing layer even when the resulting partition is valid', () => {
  const assigned = ok(planParameterLayerAssignment(input().key, { overlap: 'ranking' }, initialExperiments, ok(register())));
  const result = browserProcess(`
    const before = structuredClone(traffic.getTopology()), bytes = values.get('exp-lab-topology-v1');
    let notifications = 0; traffic.subscribeTopology(() => notifications++);
    const reverted = structuredClone(before);
    reverted.pendingParameterKeys = [input.key];
    reverted.layers.find(layer => layer.id === 'ranking').parameterKeys = reverted.layers.find(layer => layer.id === 'ranking').parameterKeys.filter(key => key !== input.key);
    const revertValidation = traffic.validateTopology(reverted, []);
    const revertError = traffic.saveTopology(reverted, []);
    const drained = structuredClone(before);
    drained.layers.find(layer => layer.id === 'transaction').parameterKeys.push(...drained.layers.find(layer => layer.id === 'ranking').parameterKeys);
    drained.layers.find(layer => layer.id === 'ranking').parameterKeys = [];
    const drainValidation = traffic.validateTopology(drained, []);
    const drainError = traffic.saveTopology(drained, []);
    process.stdout.write(JSON.stringify({ revertValidation, revertError, drainValidation, drainError, notifications, before, after: traffic.getTopology(), bytes, stored: values.get('exp-lab-topology-v1') }));
  `, { key: input().key, entries: { 'exp-lab-topology-v1': JSON.stringify(assigned) } });
  assert.equal(result.revertValidation, null);
  assert.match(result.revertError, /不能退回待归层/);
  assert.equal(result.drainValidation, null);
  assert.match(result.drainError, /不能直接清空/);
  assert.equal(result.notifications, 0);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.stored, result.bytes);
});

test('direct topology saves retain draft parameter protection while allowing an unused parameter to fill an empty layer', () => {
  const empty = ok(planLayerCreation(newLayer(), [], base()));
  const draft = experiment('ranking', empty, ['ranking.recall'], { status: 'draft' });
  const result = browserProcess(`
    const moved = structuredClone(traffic.getTopology());
    moved.layers.find(layer => layer.id === 'ranking').parameterKeys = moved.layers.find(layer => layer.id === 'ranking').parameterKeys.filter(key => key !== 'ranking.recall');
    moved.layers.find(layer => layer.id === 'new-config-layer').parameterKeys = ['ranking.recall'];
    const validation = traffic.validateTopology(moved, [input.draft]);
    const blocked = traffic.saveTopology(moved, [input.draft]);
    const permitted = traffic.saveTopology(moved, []);
    process.stdout.write(JSON.stringify({ validation, blocked, permitted, topology: traffic.getTopology() }));
  `, { draft, entries: { 'exp-lab-topology-v1': JSON.stringify(empty) } });
  assert.equal(result.validation, null);
  assert.match(result.blocked, /未结束实验/);
  assert.equal(result.permitted, null);
  assert.deepEqual(layerScope('new-config-layer', result.topology), ['ranking.recall']);
});

test('omitting lifecycle metadata cannot implicitly activate pending parameters through an otherwise valid all-wildcard branch', () => {
  const topology = base();
  topology.domains = topology.domains.filter(domain => ['root', 'exclusive'].includes(domain.id));
  topology.layers = topology.layers.filter(layer => ['root-layer', 'full'].includes(layer.id));
  const pending = ok(planParameterRegistration(input(), [], topology));
  const omitted = structuredClone(pending); delete omitted.pendingParameterKeys;
  assert.equal(validateTopology(omitted, []), null, 'Legacy snapshots without lifecycle metadata are structurally valid');
  assert.ok(layerScope('full', omitted).includes(input().key), 'A field-omission guard must stop this implicit wildcard expansion at the write boundary');
  const result = browserProcess(`
    const before = structuredClone(traffic.getTopology()), bytes = values.get('exp-lab-topology-v1');
    let notifications = 0; traffic.subscribeTopology(() => notifications++);
    const error = traffic.saveTopology(input.omitted, []);
    const failed = { topology: traffic.getTopology(), bytes: values.get('exp-lab-topology-v1'), notifications };
    const { planParameterLayerAssignment } = await import('./src/parameter-registration.ts');
    const planned = planParameterLayerAssignment(input.key, {}, [], traffic.getTopology());
    const assignedError = traffic.saveTopology(planned.topology, []);
    process.stdout.write(JSON.stringify({ before, bytes, error, failed, assignedError, after: traffic.getTopology() }));
  `, { key: input().key, omitted, entries: { 'exp-lab-topology-v1': JSON.stringify(pending) } });
  assert.match(result.error, /必须保留该字段/);
  assert.equal(result.failed.notifications, 0);
  assert.equal(result.failed.bytes, result.bytes);
  assert.deepEqual(result.failed.topology, result.before);
  assert.equal(result.assignedError, null, 'An explicit assignment still activates the parameter in the single-layer branch');
  assert.deepEqual(result.after.pendingParameterKeys, []);
  assert.ok(layerScope('full', result.after).includes(input().key));
});
