import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { initialExperiments } from '../src/data.ts';
import {
 defaultTopology, parameterKeys, getParameterDefinition, layerScope, domainScope,
 domainLayers, validateTopology, validateAllocation, simulateAllocation,
} from '../src/traffic.ts';
import { registrationAssignments, planParameterRegistration, planParameterLayerAssignment } from '../src/parameter-registration.ts';
import { getParameterRelationships } from '../src/parameter-relations.ts';

const cloneTopology = () => structuredClone(defaultTopology);
const newParameter = (overrides = {}) => ({ key: 'ranking.diversity_weight', name: '推荐多样性权重', type: 'number', defaultValue: 0.25, owner: '推荐策略组', description: '用于控制推荐结果的多样性', serviceId: 'ranking-service', tagIds: [], ...overrides });
const rankingSelections = { overlap: 'ranking' };
const deepSelections = { overlap: 'presentation', 'ui-mobile': 'ui-content', 'card-depth': 'card-layout' };
const plan = (input = newParameter(), selections = rankingSelections, topology = cloneTopology()) => {
 const registered = planParameterRegistration(input, initialExperiments, topology);
 return registered.topology ? planParameterLayerAssignment(input.key, selections, initialExperiments, registered.topology) : registered;
};
const owners = (key, topology) => topology.layers.filter(layer => layerScope(layer.id, topology).includes(key)).map(layer => layer.id).sort();

function assertRejected(input, selections = rankingSelections, topology = cloneTopology()) {
 let result;
 assert.doesNotThrow(() => { result = plan(input, selections, topology); });
 assert.equal(result.topology, null);
 assert.ok(typeof result.error === 'string' && result.error.length > 0);
}

test('first layer assignment requires a choice in every reached multi-layer domain and automatically assigns single-layer domains', () => {
 const assignments = registrationAssignments({}, defaultTopology);
 const root = assignments.find(row => row.domainId === 'root');
 const overlap = assignments.find(row => row.domainId === 'overlap');
 const isolated = assignments.find(row => row.domainId === 'exclusive');
 assert.equal(root.layerId, 'root-layer');
 assert.equal(root.automatic, true);
 assert.equal(overlap.layerId, null);
 assert.equal(overlap.automatic, false);
 assert.deepEqual(overlap.options.map(layer => layer.id).sort(), ['presentation', 'ranking', 'transaction']);
 assert.equal(isolated.layerId, 'full');
 assert.equal(isolated.automatic, true);
 assert.ok(!assignments.some(row => row.domainId === 'ui-mobile'), 'Descendants cannot be assigned before the parent layer is selected');
 assertRejected(newParameter(), {});
});

test('assigning a registered ranking parameter partitions it into root, ranking, and the mutually exclusive full layer only', () => {
 const before = cloneTopology();
 const experimentsBefore = structuredClone(initialExperiments);
 const result = plan(newParameter(), rankingSelections, before);
 assert.equal(result.error, null);
 const topology = result.topology;
 assert.equal(validateTopology(topology, initialExperiments), null);
 assert.deepEqual(owners('ranking.diversity_weight', topology), ['full', 'ranking', 'root-layer']);
 assert.deepEqual(parameterKeys(topology), [...parameterKeys(before), 'ranking.diversity_weight']);
 assert.equal(getParameterDefinition('ranking.diversity_weight', topology).defaultValue, 0.25);
 assert.deepEqual(topology.domains, before.domains, 'Registering a parameter does not reserve or move traffic');
 assert.deepEqual(before, defaultTopology, 'Planning must not mutate the source snapshot');
 assert.deepEqual(initialExperiments, experimentsBefore, 'Registration never edits old experiment payloads');
 for (const oldLayer of before.layers) {
  const newLayer = topology.layers.find(layer => layer.id === oldLayer.id);
  assert.deepEqual({ ...newLayer, parameterKeys: oldLayer.parameterKeys }, oldLayer);
  assert.deepEqual(newLayer.parameterKeys, oldLayer.id === 'ranking' ? [...oldLayer.parameterKeys, 'ranking.diversity_weight'] : oldLayer.parameterKeys);
 }
});

test('nested first assignment follows every selected-layer child domain and preserves inherited wildcard scopes', () => {
 const key = 'ui.card_density';
 const input = newParameter({ key, name: '卡片密度', type: 'string', defaultValue: 'comfortable' });
 const unresolved = registrationAssignments({ overlap: 'presentation' }, defaultTopology);
 assert.equal(unresolved.find(row => row.domainId === 'ui-mobile').layerId, null);
 assert.equal(unresolved.find(row => row.domainId === 'ui-isolation').layerId, 'ui-full');
 assertRejected(input, { overlap: 'presentation' });
 assertRejected(input, { overlap: 'presentation', 'ui-mobile': 'ui-content' });
 const result = plan(input, deepSelections);
 assert.equal(result.error, null);
 assert.deepEqual(owners(key, result.topology), ['card-layout', 'full', 'presentation', 'root-layer', 'ui-content', 'ui-full']);
 assert.ok(!domainScope('card-depth', result.topology).includes('ranking.model'));
 assert.ok(layerScope('ui-full', result.topology).includes(key));
 assert.deepEqual(result.topology.layers.find(layer => layer.id === 'ui-full').parameterKeys, ['*']);
 assert.equal(validateTopology(result.topology, initialExperiments), null);
 for (const domain of result.topology.domains) {
  const owned = domainLayers(domain.id, result.topology).flatMap(layer => layerScope(layer.id, result.topology));
  assert.equal(new Set(owned).size, owned.length, domain.name);
  assert.deepEqual([...owned].sort(), [...domainScope(domain.id, result.topology)].sort(), domain.name);
 }
});

test('invalid layer ownership and missing required descendant selections are rejected', () => {
 for (const selections of [
  { overlap: 'removed-layer' },
  { overlap: 'full' },
  { overlap: 'presentation', 'ui-mobile': 'ranking' },
  { overlap: 'presentation', 'ui-mobile': 'ui-content', 'card-depth': 'ui-cart-missing' },
 ]) assertRejected(newParameter(), selections);
});

test('registration rejects duplicate, malformed, and unsafe parameter keys without partial mutation', () => {
 for (const key of ['', 'ranking.model', '*', 'ranking..weight', '.ranking', 'ranking.', 'ranking weight', '__proto__', 'ui.__proto__.enabled', 'constructor', 'ui.constructor.enabled', 'prototype', 'ui.prototype.enabled']) {
  const topology = cloneTopology();
  assertRejected(newParameter({ key }), rankingSelections, topology);
  assert.deepEqual(topology, defaultTopology, key);
 }
 const first = plan();
 assert.equal(first.error, null);
 assertRejected(newParameter(), rankingSelections, first.topology);
});

test('registration validates required metadata, supported types, and finite JSON defaults', () => {
 for (const field of ['key', 'name', 'owner', 'type', 'defaultValue']) {
  const input = newParameter();
  delete input[field];
  assertRejected(input);
 }
 for (const changes of [
  { name: '   ' }, { owner: '   ' }, { type: 'integer' }, { type: null },
  { type: 'string', defaultValue: 7 }, { type: 'number', defaultValue: '0.25' },
  { type: 'number', defaultValue: NaN }, { type: 'number', defaultValue: Infinity },
  { type: 'boolean', defaultValue: 'false' }, { type: 'object', defaultValue: null },
  { type: 'object', defaultValue: [] }, { type: 'array', defaultValue: {} },
  { type: 'object', defaultValue: { nested: NaN } },
  { type: 'object', defaultValue: { nested: undefined } },
  { type: 'array', defaultValue: [1, undefined] },
  { type: 'object', defaultValue: { nested: () => true } },
  { type: 'object', defaultValue: { nested: 1n } },
 ]) assertRejected(newParameter(changes));
 const circular = {};
 circular.self = circular;
 assertRejected(newParameter({ type: 'object', defaultValue: circular }));
});

test('valid falsy defaults and nested JSON values are preserved exactly', () => {
 for (const [type, defaultValue] of [
  ['string', ''], ['number', 0], ['boolean', false],
  ['object', { enabled: false, weights: [0, 1], optional: null }],
  ['array', [0, false, '', null, { weight: 1 }]],
 ]) {
  const result = plan(newParameter({ type, defaultValue }));
  assert.equal(result.error, null, type);
  assert.deepEqual(getParameterDefinition('ranking.diversity_weight', result.topology).defaultValue, defaultValue);
 }
});

test('new parameter types constrain experiment values without imposing a schema on legacy parameters', () => {
 const experiment = structuredClone(initialExperiments.find(e => e.layerId === 'ranking' && e.status === 'running'));
 for (const [type, valid, invalid] of [['number', 0, '0'], ['string', '', 0], ['boolean', false, 'false'], ['object', {}, []], ['array', [], {}]]) {
  const result = plan(newParameter({ type, defaultValue: valid }));
  assert.equal(result.error, null);
  const typed = { ...experiment, parameterKeys: ['ranking.diversity_weight'], variants: experiment.variants.map(variant => ({ ...variant, value: JSON.stringify({ 'ranking.diversity_weight': valid }) })) };
  assert.equal(validateAllocation(typed, initialExperiments, result.topology), null, type);
  typed.variants[1].value = JSON.stringify({ 'ranking.diversity_weight': invalid });
  assert.ok(validateAllocation(typed, initialExperiments, result.topology), `Wrong ${type} value accepted`);
 }
 const topology = plan().topology;
 for (const oldExperiment of initialExperiments.filter(e => ['running', 'review', 'paused'].includes(e.status))) {
  assert.equal(validateAllocation(oldExperiment, initialExperiments, topology), null, oldExperiment.id);
 }
});

test('relationship queries use the supplied custom catalog and flag typed variant errors without replacing actual values', () => {
 const source = initialExperiments.find(e => e.layerId === 'ranking' && e.status === 'running');
 const key = 'ranking.diversity_weight';
 for (const [type, valid, invalid] of [
  ['number', 0, '0'], ['string', '', 0], ['boolean', false, 'false'],
  ['object', { enabled: false, nested: [0, null] }, []], ['array', [0, false, null], {}],
 ]) {
  const topology = plan(newParameter({ type, defaultValue: valid })).topology;
  assert.equal(getParameterDefinition(key), undefined, 'The planned catalog has not been published to global state');
  const experiment = { ...structuredClone(source), parameterKeys: [key], variants: source.variants.map(variant => ({ ...variant, value: JSON.stringify({ [key]: valid }) })) };
  const clean = getParameterRelationships(key, [experiment], topology);
  assert.deepEqual(clean.issues, [], type);
  assert.deepEqual(clean.owners.map(owner => owner.layerId).sort(), ['full', 'ranking', 'root-layer']);
  assert.equal(clean.references[0].currentOwner, true);
  assert.deepEqual(clean.references[0].values.map(item => item.value), [valid, valid]);
  experiment.variants[1].value = JSON.stringify({ [key]: invalid });
  const broken = getParameterRelationships(key, [experiment], topology);
  assert.equal(broken.issues.length, 1, type);
  assert.equal(broken.references[0].values[0].error, undefined);
  assert.ok(broken.references[0].values[1].error);
  assert.deepEqual(broken.references[0].values[1].value, invalid, 'Diagnostics preserve the stored value rather than substituting the registered default');
  assert.equal(broken.references[0].currentOwner, true, 'A type error is distinct from a scope error');
 }
});

test('topology validation enforces catalog integrity even when bypassing the registration form', () => {
 const planned = plan().topology;
 for (const mutate of [
  topology => { topology.parameters.push(structuredClone(topology.parameters[0])); },
  topology => { topology.parameters[0].key = 'ranking.model'; },
  topology => { topology.parameters[0].type = 'integer'; },
  topology => { topology.parameters[0].defaultValue = 'wrong-number'; },
  topology => { topology.parameters = null; },
  topology => { topology.layers.find(layer => layer.id === 'ranking').parameterKeys.pop(); },
 ]) {
  const invalid = structuredClone(planned);
  mutate(invalid);
  let error;
  assert.doesNotThrow(() => { error = validateTopology(invalid, initialExperiments); });
  assert.ok(error, 'An invalid catalog or incomplete ownership partition must not pass the shared validator');
 }
});

test('registration leaves deterministic user assignments and existing parameter outputs unchanged', () => {
 const topology = plan(newParameter({ key: 'ui.card_density', name: '卡片密度', type: 'string', defaultValue: 'comfortable' }), deepSelections).topology;
 for (let index = 0; index < 100; index++) {
  const unit = `registration_stability_${index}`;
  const before = simulateAllocation(unit, initialExperiments, defaultTopology);
  const after = simulateAllocation(unit, initialExperiments, topology);
  assert.equal(before.error, undefined);
  assert.equal(after.error, undefined);
  assert.deepEqual(after, before, unit);
 }
});

function browserProcess(script, input = {}) {
 const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
  import { readFileSync } from 'node:fs';
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const values = new Map(Object.entries(input.entries ?? {}));
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (input.failStorage) throw new Error('Quota exceeded'); values.set(key, value); } }, configurable: true });
  const traffic = await import('./src/traffic.ts');
  ${script}
 `], { cwd: new URL('..', import.meta.url), input: JSON.stringify(input), encoding: 'utf8' });
 assert.equal(child.status, 0, child.stderr);
 return JSON.parse(child.stdout);
}

test('legacy topology restores unchanged and does not fabricate custom parameter definitions', () => {
 const restored = browserProcess(`process.stdout.write(JSON.stringify({ topology: traffic.getTopology(), keys: traffic.parameterKeys(), custom: traffic.getTopology().parameters ?? [] }));`, { entries: { 'exp-lab-topology-v1': JSON.stringify(defaultTopology) } });
 assert.deepEqual(restored.topology, defaultTopology);
 assert.deepEqual(restored.keys, parameterKeys(defaultTopology));
 assert.deepEqual(restored.custom, []);
});

test('one persisted snapshot restores the parameter catalog and all recursive assignments after reload', () => {
 const input = newParameter({ key: 'ui.card_density', name: '卡片密度', type: 'string', defaultValue: 'comfortable' });
 const topology = plan(input, deepSelections).topology;
 const saved = browserProcess(`
  const error = traffic.saveTopology(input.topology, input.experiments);
  process.stdout.write(JSON.stringify({ error, topology: traffic.getTopology(), keys: traffic.registeredParameters, definition: traffic.getParameterDefinition(input.key), entries: Object.fromEntries(values) }));
 `, { key: input.key, topology, experiments: initialExperiments, entries: { 'exp-lab-experiments-v3': JSON.stringify(initialExperiments) } });
 assert.equal(saved.error, null);
 assert.deepEqual(saved.topology, topology);
 assert.ok(saved.keys.includes(input.key));
 assert.equal(saved.definition.defaultValue, 'comfortable');
 assert.deepEqual(JSON.parse(saved.entries['exp-lab-topology-v1']), topology);
 assert.deepEqual(JSON.parse(saved.entries['exp-lab-experiments-v3']), initialExperiments);
 const restored = browserProcess(`process.stdout.write(JSON.stringify({ topology: traffic.getTopology(), keys: traffic.registeredParameters, definition: traffic.getParameterDefinition(input.key) }));`, { key: input.key, entries: saved.entries });
 assert.deepEqual(restored.topology, topology);
 assert.deepEqual(restored.keys, saved.keys);
 assert.deepEqual(restored.definition, saved.definition);
 assert.deepEqual(owners(input.key, restored.topology), owners(input.key, topology));
});

test('storage failure cannot partially publish the catalog, ownership changes, or a topology notification', () => {
 const result = browserProcess(`
  const before = structuredClone(traffic.getTopology());
  const beforeKeys = [...traffic.registeredParameters];
  let notifications = 0;
  traffic.subscribeTopology(() => notifications++);
  const error = traffic.saveTopology(input.topology, input.experiments);
  process.stdout.write(JSON.stringify({ error, before, after: traffic.getTopology(), beforeKeys, afterKeys: traffic.registeredParameters, notifications }));
 `, { failStorage: true, topology: plan().topology, experiments: initialExperiments });
 assert.ok(result.error);
 assert.deepEqual(result.after, result.before);
 assert.deepEqual(result.afterKeys, result.beforeKeys);
 assert.equal(result.notifications, 0);
});

test('registered definitions cannot be silently changed or deleted by an unrelated topology save', () => {
 const result = browserProcess(`
  const saved = traffic.saveTopology(input.topology, input.experiments);
  const originalStored = values.get('exp-lab-topology-v1');
  let notifications = 0;
  traffic.subscribeTopology(() => notifications++);
  const changed = structuredClone(traffic.getTopology());
  changed.parameters[0].defaultValue = 0.5;
  const changeError = traffic.saveTopology(changed, input.experiments);
  const removed = structuredClone(traffic.getTopology());
  const key = removed.parameters[0].key;
  delete removed.parameters;
  removed.catalog.bindings = removed.catalog.bindings.filter(binding => binding.key !== key);
  removed.layers.forEach(layer => { layer.parameterKeys = layer.parameterKeys.filter(parameter => parameter !== key); });
  const removalTopologyError = traffic.validateTopology(removed, input.experiments);
  const removalError = traffic.saveTopology(removed, input.experiments);
  process.stdout.write(JSON.stringify({ saved, changeError, removalError, removalTopologyError, notifications, originalStored, stored: values.get('exp-lab-topology-v1'), topology: traffic.getTopology() }));
 `, { topology: plan().topology, experiments: initialExperiments });
 assert.equal(result.saved, null);
 assert.ok(result.changeError);
 assert.equal(result.removalTopologyError, null, 'The deletion forms a structurally valid topology, so immutability must block it separately');
 assert.ok(result.removalError);
 assert.equal(result.notifications, 0);
 assert.equal(result.stored, result.originalStored);
 assert.equal(getParameterDefinition('ranking.diversity_weight', result.topology).defaultValue, 0.25);
});
