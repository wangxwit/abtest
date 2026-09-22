import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { initialExperiments, validTransition } from '../src/data.ts';
import {
 defaultTopology, registeredParameters, childDomains, domainLayers, domainGlobalTraffic,
 domainScope, layerScope, nodePath, maxConcurrent, simulateAllocation, validateTopology,
 validateAllocation, findAvailableStart, globalTraffic, migrateFlatTopology, normalizeExperiments,
 layerCreationBlock, layerParameterOptions, planLayerCreation,
} from '../src/traffic.ts';
import { getCatalog } from '../src/service-catalog.ts';

const cloneTopology = () => structuredClone(defaultTopology);
const byId = id => initialExperiments.find(e => e.id === id);
const active = initialExperiments.filter(e => ['running', 'paused', 'review'].includes(e.status));
let sampleCache;
function samples() {
 return sampleCache ??= Array.from({ length: 2500 }, (_, i) => {
  const user = `recursive_test_${i}`;
  return { user, result: simulateAllocation(user, initialExperiments) };
 });
}
function sampleHitting(id) {
 const found = samples().find(({ result }) => result.decisions.some(d => d.experimentId === id));
 assert.ok(found, `No deterministic fixture user reached ${id}`);
 return found;
}
function withParameters(exp, keys) {
 return { ...exp, parameterKeys: keys, variants: exp.variants.map(v => ({ ...v, value: JSON.stringify(Object.fromEntries(keys.map(k => [k, 'test']))) })) };
}
function addChild(topology, overrides = {}) {
 const domain = { id: 'new-ui-domain', name: '新建展示子域', mode: 'non-overlapping', parentLayerId: 'presentation', traffic: 10, start: 90, unit: 'user_id', description: 'Test domain', ...overrides };
 topology.domains.push(domain);
 topology.layers.push({ id: 'new-ui-layer', name: '新建继承参数层', domainId: domain.id, parameterKeys: ['*'], description: 'Inherited scope' });
 return topology;
}

test('only reviewed experiments can start; completed experiments cannot restart', () => {
 assert.equal(validTransition('draft', 'running'), false);
 assert.equal(validTransition('review', 'running'), true);
 assert.equal(validTransition('running', 'paused'), true);
 assert.equal(validTransition('paused', 'running'), true);
 for (const next of ['draft', 'review', 'running', 'paused', 'completed']) assert.equal(validTransition('completed', next), false);
});

test('default root routes through sibling domains that partition exactly 100%', () => {
 const roots = defaultTopology.domains.filter(d => d.parentLayerId === null);
 assert.equal(roots.length, 1);
 assert.equal(roots[0].id, 'root');
 assert.equal(roots[0].traffic, 100);
 const rootLayers = domainLayers('root');
 assert.equal(rootLayers.length, 1);
 assert.equal(rootLayers[0].role, 'routing');
 const siblings = childDomains('root-layer').sort((a, b) => a.start - b.start);
 assert.deepEqual(siblings.map(d => d.id), ['overlap', 'exclusive']);
 assert.equal(siblings.reduce((sum, d) => sum + d.traffic, 0), 100);
 assert.equal(siblings[0].start, 0);
 assert.equal(siblings[0].start + siblings[0].traffic, siblings[1].start);
 assert.equal(siblings[1].start + siblings[1].traffic, 100);
 assert.equal(validateTopology(defaultTopology, initialExperiments), null);
});

test('grandchild traffic is multiplied through ancestors and paths alternate domains and layers', () => {
 assert.equal(domainGlobalTraffic('root'), 100);
 assert.equal(domainGlobalTraffic('overlap'), 80);
 assert.equal(domainGlobalTraffic('ui-mobile'), 16);
 assert.equal(domainGlobalTraffic('ui-isolation'), 8);
 assert.equal(domainGlobalTraffic('card-depth'), 8);
 assert.equal(globalTraffic(byId('EXP-1204')), 4);
 assert.deepEqual(nodePath('layer', 'card-layout').map(n => n.id), [
  'root', 'root-layer', 'overlap', 'presentation', 'ui-mobile', 'ui-content', 'card-depth', 'card-layout',
 ]);
 assert.deepEqual(nodePath('domain', 'card-depth').map(n => n.kind), ['domain', 'layer', 'domain', 'layer', 'domain', 'layer', 'domain']);
 assert.equal(maxConcurrent('ui-isolation'), 1);
 assert.equal(maxConcurrent('exclusive'), 1);
 assert.equal(maxConcurrent('card-depth'), 2);
 assert.equal(maxConcurrent('overlap'), 5);
});

test('wildcard parameters inherit only the parent layer scope at every depth', () => {
 const uiParameters = registeredParameters.filter(key => key.startsWith('ui.'));
 assert.equal(uiParameters.length, 5);
 assert.deepEqual(layerScope('ui-full'), uiParameters);
 assert.deepEqual(domainScope('ui-isolation'), uiParameters);
 assert.deepEqual(layerScope('full'), registeredParameters);
 assert.deepEqual(domainScope('card-depth'), ['ui.cart', 'ui.content_card']);
 assert.deepEqual(layerScope('card-layout'), ['ui.content_card']);
 const uiExp = byId('EXP-1203');
 assert.equal(validateAllocation(uiExp, initialExperiments), null);
 assert.match(validateAllocation(withParameters(uiExp, ['ranking.model']), initialExperiments), /本层之外/);
 assert.match(validateAllocation(withParameters(byId('EXP-1204'), ['ui.layout']), initialExperiments), /本层之外/);
});

test('recursive routing is deterministic, preserves sibling exclusion, and permits independent branches', () => {
 let rootOverlap = 0, rootExclusive = 0, deepUsers = 0, isolatedWithAncestors = 0, simultaneousDeepHits = 0;
 const reachedExperiments = new Set();
 for (const { user, result } of samples()) {
  assert.equal(result.error, undefined, user);
  assert.equal(result.enteredDomains[0], 'root');
  assert.equal(new Set(result.enteredDomains).size, result.enteredDomains.length);
  assert.equal(new Set(result.decisions.map(d => d.layerId)).size, result.decisions.length);
  const rootDecision = result.decisions.find(d => d.layerId === 'root-layer');
  assert.equal(rootDecision.childDomainId, result.domain.id);
  assert.equal(rootDecision.experimentId, null);
  assert.ok(result.domainBucket >= result.domain.start && result.domainBucket < result.domain.start + result.domain.traffic);
  const hits = result.decisions.filter(d => d.experimentId);
  for (const hit of hits) {
   reachedExperiments.add(hit.experimentId);
   assert.ok(result.enteredDomains.includes(byId(hit.experimentId).domainId));
   assert.equal(hit.childDomainId, null, 'One parent-layer bucket cannot hold a direct experiment and a child domain');
  }
  for (const decision of result.decisions) {
   if (!decision.childDomainId) continue;
   const child = defaultTopology.domains.find(d => d.id === decision.childDomainId);
   assert.equal(child.parentLayerId, decision.layerId);
   assert.equal(decision.experimentId, null);
   assert.ok(decision.bucket >= child.start && decision.bucket < child.start + child.traffic);
   assert.ok(result.enteredDomains.includes(child.id));
  }
  const params = hits.flatMap(hit => Object.keys(hit.parameters));
  assert.equal(new Set(params).size, params.length, 'Parallel terminal branches cannot overwrite a parameter');
  if (result.domain.id === 'exclusive') {
   rootExclusive++;
   assert.deepEqual(result.enteredDomains, ['root', 'exclusive']);
   assert.ok(hits.length <= 1);
  } else {
   rootOverlap++;
   assert.equal(result.domain.id, 'overlap');
   assert.ok(!(result.enteredDomains.includes('ui-mobile') && result.enteredDomains.includes('ui-isolation')));
  }
  if (result.enteredDomains.includes('card-depth')) {
   deepUsers++;
   assert.ok(result.enteredDomains.includes('ui-mobile'));
   assert.equal(result.decisions.find(d => d.layerId === 'ui-content').experimentId, null);
   if (hits.some(d => d.layerId === 'card-layout') && hits.some(d => d.layerId === 'ui-cart')) simultaneousDeepHits++;
  }
  if (result.enteredDomains.includes('ui-isolation')) {
   const branchHits = hits.filter(d => d.domainId === 'ui-isolation');
   assert.ok(branchHits.length <= 1);
   if (branchHits.length && hits.some(d => d.layerId === 'ranking') && hits.some(d => d.layerId === 'transaction')) isolatedWithAncestors++;
  }
 }
 assert.ok(rootOverlap > 1800 && rootOverlap < 2200);
 assert.ok(rootExclusive > 300 && rootExclusive < 700);
 assert.ok(deepUsers > 0 && isolatedWithAncestors > 0 && simultaneousDeepHits > 0);
 for (const id of ['EXP-1201', 'EXP-1202', 'EXP-1203', 'EXP-1204', 'EXP-1205']) assert.ok(reachedExperiments.has(id));
 for (const { user, result } of samples().filter((_, i) => i % 100 === 0)) assert.deepEqual(simulateAllocation(user, initialExperiments), result);
});

test('first-fit allocation includes child-domain reservations and handles touching boundaries', () => {
 assert.equal(findAvailableStart('presentation', 10, initialExperiments), 90);
 assert.equal(findAvailableStart('presentation', 11, initialExperiments), null);
 assert.equal(findAvailableStart('ui-content', 10, initialExperiments), 40);
 assert.equal(findAvailableStart('ui-content', 11, initialExperiments), null);
 assert.equal(findAvailableStart('full', 51, initialExperiments), null);
 const prototype = byId('EXP-1202');
 assert.equal(validateAllocation({ ...prototype, id: 'VALID-BOUNDARY', traffic: 10, bucketStart: 40 }, initialExperiments), null);
 assert.match(validateAllocation({ ...prototype, id: 'CHILD-COLLISION', traffic: 2, bucketStart: 49 }, initialExperiments), /包括子域/);
 assert.match(validateAllocation({ ...prototype, id: 'EXPERIMENT-COLLISION', traffic: 2, bucketStart: 39 }, initialExperiments), /区间已被占用/);
 assert.match(validateAllocation({ ...prototype, domainId: 'root', layerId: 'root-layer' }, initialExperiments), /路由层/);
});

test('topology rejects child ranges outside the parent or overlapping direct experiments and siblings', () => {
 const outside = cloneTopology();
 Object.assign(outside.domains.find(d => d.id === 'ui-mobile'), { start: 95, traffic: 10 });
 assert.match(validateTopology(outside, initialExperiments), /父层桶范围无效/);
 const siblingCollision = cloneTopology();
 siblingCollision.domains.find(d => d.id === 'ui-isolation').start = 70;
 assert.match(validateTopology(siblingCollision, initialExperiments), /区间发生重叠/);
 assert.match(validateTopology(addChild(cloneTopology(), { start: 55, traffic: 5 }), initialExperiments), /实验与子域桶区间发生重叠/);
 const invalidUnit = cloneTopology();
 invalidUnit.domains.find(d => d.id === 'card-depth').unit = 'device_id';
 assert.match(validateTopology(invalidUnit, initialExperiments), /随机化单元/);
});

test('topology rejects escaping scope, duplicate parameters, cycles and incomplete partitions', () => {
 const escape = cloneTopology();
 escape.layers.find(l => l.id === 'ui-navigation').parameterKeys.push('ranking.model');
 assert.match(validateTopology(escape), /超出父层范围/);
 const duplicate = cloneTopology();
 duplicate.layers.find(l => l.id === 'ui-navigation').parameterKeys.push('ui.cart');
 assert.match(validateTopology(duplicate), /唯一归层/);
 const duplicateInLayer = cloneTopology();
 duplicateInLayer.layers.find(l => l.id === 'card-layout').parameterKeys.push('ui.content_card');
 assert.match(validateTopology(duplicateInLayer), /唯一归层/);
 const missing = cloneTopology();
 missing.layers.find(l => l.id === 'ui-navigation').parameterKeys = ['ui.layout', 'ui.membership'];
 assert.match(validateTopology(missing), /完整划分父层参数/);
 const cycle = cloneTopology();
 cycle.domains.find(d => d.id === 'ui-mobile').parentLayerId = 'card-layout';
 assert.match(validateTopology(cycle), /不能形成环/);
 const oneBranch = addChild(cloneTopology(), { parentLayerId: 'ui-full', start: 70 });
 assert.equal(validateTopology(oneBranch, initialExperiments), null);
 const invalidIsolated = structuredClone(oneBranch);
 invalidIsolated.domains.find(d => d.id === 'new-ui-domain').mode = 'overlapping';
 invalidIsolated.layers.find(l => l.id === 'new-ui-layer').parameterKeys = ['ui.layout'];
 invalidIsolated.layers.push({ id: 'parallel-ui-layer', domainId: 'new-ui-domain', name: '并行分支', parameterKeys: layerScope('presentation').filter(k => k !== 'ui.layout'), description: 'Invalid inside isolated branch' });
 assert.match(validateTopology(invalidIsolated), /非重叠域需要单个完整参数层/);
});

test('adding a child in unused buckets does not move existing experiment or variant assignments', () => {
 const expanded = addChild(cloneTopology());
 assert.equal(validateTopology(expanded, initialExperiments), null);
 assert.equal(findAvailableStart('presentation', 1, initialExperiments, undefined, expanded), null);
 assert.equal(domainGlobalTraffic('new-ui-domain', expanded), 8);
 assert.deepEqual(layerScope('new-ui-layer', expanded), layerScope('presentation'));
 let enteredNewChild = 0;
 for (const { user, result: before } of samples().filter((_, i) => i % 3 === 0)) {
  const after = simulateAllocation(user, initialExperiments, expanded);
  assert.equal(after.error, undefined);
  if (after.enteredDomains.includes('new-ui-domain')) enteredNewChild++;
  const assignments = r => r.decisions.filter(d => d.experimentId).map(d => ({ layerId: d.layerId, experimentId: d.experimentId, variant: d.variant, bucket: d.bucket }));
  assert.deepEqual(assignments(after), assignments(before));
  assert.deepEqual(after.mergedParameters, before.mergedParameters);
 }
 assert.ok(enteredNewChild > 0);
});

test('pausing reserves a nested bucket, uses defaults, and leaves other branches stable', () => {
 const e = byId('EXP-1204');
 const { user, result: before } = sampleHitting(e.id);
 const after = simulateAllocation(user, initialExperiments.map(x => x.id === e.id ? { ...x, status: 'paused' } : x));
 const original = before.decisions.find(d => d.layerId === e.layerId);
 const paused = after.decisions.find(d => d.layerId === e.layerId);
 assert.equal(paused.bucket, original.bucket);
 assert.equal(paused.experimentId, null);
 assert.match(paused.reason, /暂停保留/);
 assert.deepEqual(after.decisions.filter(d => d.layerId !== e.layerId), before.decisions.filter(d => d.layerId !== e.layerId));
});

test('unknown audience eligibility does not backfill another experiment or child', () => {
 const e = byId('EXP-1202');
 const { user, result: before } = sampleHitting(e.id);
 const after = simulateAllocation(user, initialExperiments.map(x => x.id === e.id ? { ...x, audience: '新注册用户' } : x));
 const decision = after.decisions.find(d => d.layerId === e.layerId);
 assert.equal(decision.experimentId, null);
 assert.equal(decision.childDomainId, null);
 assert.match(decision.reason, /资格未验证/);
 assert.deepEqual(after.enteredDomains, before.enteredDomains);
 assert.deepEqual(after.decisions.filter(d => d.layerId !== e.layerId), before.decisions.filter(d => d.layerId !== e.layerId));
});

test('all seeded active allocations fit their layer, and unmeasured fixtures have no invented outcome', () => {
 assert.equal(new Set(initialExperiments.map(e => e.key)).size, initialExperiments.length);
 for (const e of initialExperiments) {
  assert.equal(e.variants.reduce((n, v) => n + v.weight, 0), 100);
  assert.ok(e.variants.every(v => v.weight > 0));
  if (e.participants === 0) {
   assert.equal(e.lift, null);
   assert.equal(e.significant, false);
  }
 }
 for (const e of active) assert.equal(validateAllocation(e, initialExperiments), null, e.id);
 for (const layer of defaultTopology.layers) {
  const used = active.filter(e => e.layerId === layer.id).reduce((n, e) => n + e.traffic, 0) + childDomains(layer.id).reduce((n, d) => n + d.traffic, 0);
  assert.ok(used <= 100, layer.id);
 }
});

test('experiment identifiers cannot hide a same-named child domain or layer reservation', () => {
 const exp = initialExperiments.find(e => e.layerId === 'presentation' && e.status === 'running');
 for (const id of ['ui-mobile', 'presentation']) {
  assert.match(validateAllocation({ ...exp, id, traffic: 10, bucketStart: 60 }, initialExperiments), /不能与域或层标识相同/);
 }
 assert.equal(findAvailableStart('presentation', 10, initialExperiments, 'ui-mobile'), 90);
 assert.equal(findAvailableStart('presentation', 20, initialExperiments, 'ui-mobile'), null);
 assert.equal(findAvailableStart('presentation', exp.traffic, initialExperiments, exp.id), exp.bucketStart);
});

test('the default domain requires exactly one root-layer wildcard routing entry', () => {
 const configurations = [
  topology => { topology.layers.find(l => l.id === 'root-layer').role = 'normal'; },
  topology => { topology.layers.find(l => l.id === 'root-layer').id = 'renamed-root-layer'; },
  topology => { topology.layers.find(l => l.id === 'root-layer').parameterKeys = [...registeredParameters]; },
  topology => { topology.layers.push({ id: 'extra-root-layer', domainId: 'root', name: 'Invalid extra layer', parameterKeys: ['ui.layout'], description: '' }); },
 ];
 for (const mutate of configurations) {
  const topology = cloneTopology();
  mutate(topology);
  assert.match(validateTopology(topology), /唯一的全参数默认路由层/);
 }
 const twoRoots = cloneTopology();
 twoRoots.domains.push({ ...twoRoots.domains[0], id: 'second-root' });
 assert.match(validateTopology(twoRoots), /唯一的默认根域/);
});

test('malformed parameter collections fail validation before recursive scope traversal', () => {
 for (const parameterKeys of [undefined, null, '*', 42, { key: 'ui.layout' }]) {
  const topology = cloneTopology();
  topology.layers.find(l => l.id === 'presentation').parameterKeys = parameterKeys;
  assert.doesNotThrow(() => validateTopology(topology));
  assert.match(validateTopology(topology), /参数层配置格式无效/);
 }
 for (const parameterKeys of [[null], [1], [{}]]) {
  const topology = cloneTopology();
  topology.layers.find(l => l.id === 'presentation').parameterKeys = parameterKeys;
  assert.doesNotThrow(() => validateTopology(topology));
  assert.match(validateTopology(topology), /参数集合格式无效/);
 }
 const mixedWildcard = cloneTopology();
 mixedWildcard.layers.find(l => l.id === 'ui-full').parameterKeys = ['*', 'ui.layout'];
 assert.match(validateTopology(mixedWildcard), /星号不能与具体参数混用/);
});

const flatExperiments = () => structuredClone(initialExperiments.filter(e => ['overlap', 'exclusive'].includes(e.domainId)));
const flatTopology = () => ({
 domains: structuredClone(defaultTopology.domains.filter(d => ['root', 'overlap', 'exclusive'].includes(d.id))),
 layers: structuredClone(defaultTopology.layers.filter(l => ['root', 'overlap', 'exclusive'].includes(l.domainId))),
});
function oldPresentationExperiment(id, bucketStart, traffic, status = 'running') {
 return { ...structuredClone(initialExperiments.find(e => e.layerId === 'presentation' && e.status === 'running')), id, key: id.toLowerCase().replaceAll('-', '_'), name: id, bucketStart, traffic, status };
}
function restoreBrowserState(entries) {
 const script = `
  import { readFileSync } from 'node:fs';
  const values = new Map(Object.entries(JSON.parse(readFileSync(0, 'utf8'))));
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, configurable: true });
  const traffic = await import('./src/traffic.ts');
  const { initialExperiments } = await import('./src/data.ts');
  process.stdout.write(JSON.stringify({ topology: traffic.getTopology(), savedTopology: values.get('exp-lab-topology-v1'), seedIds: initialExperiments.map(e => e.id), originalEntries: Object.fromEntries(values) }));
 `;
 const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), input: JSON.stringify(entries), encoding: 'utf8' });
 assert.equal(child.status, 0, child.stderr);
 return JSON.parse(child.stdout);
}

test('flat-model migration moves new demo domains into free buckets and preserves old assignments', () => {
 const existing = [...flatExperiments(), oldPresentationExperiment('OLD-CUSTOM', 60, 10)];
 const unchanged = structuredClone(existing);
 const beforeTopology = flatTopology();
 assert.equal(validateTopology(beforeTopology, existing), null);
 const afterTopology = migrateFlatTopology(existing);
 assert.deepEqual(existing, unchanged, 'Migration must not mutate existing experiment configurations');
 assert.equal(validateTopology(afterTopology, existing), null);
 assert.equal(afterTopology.domains.find(d => d.id === 'ui-mobile').start, 70);
 assert.equal(afterTopology.domains.find(d => d.id === 'ui-isolation').start, 90);
 const hits = result => result.decisions.filter(d => d.experimentId).map(d => ({ id: d.experimentId, layerId: d.layerId, variant: d.variant, bucket: d.bucket, parameters: d.parameters }));
 for (let i = 0; i < 800; i++) {
  const user = `migration_${i}`;
  const before = simulateAllocation(user, existing, beforeTopology);
  const after = simulateAllocation(user, existing, afterTopology);
  assert.equal(after.error, undefined);
  assert.deepEqual(hits(after), hits(before));
  assert.deepEqual(after.mergedParameters, before.mergedParameters);
 }
});

test('flat-model migration respects paused and pending reservations and ignores unreserved drafts', () => {
 for (const status of ['paused', 'review']) {
  const existing = [...flatExperiments(), oldPresentationExperiment(`OLD-${status}`, 60, 10, status)];
  const migrated = migrateFlatTopology(existing);
  assert.equal(validateTopology(migrated, existing), null);
  assert.equal(migrated.domains.find(d => d.id === 'ui-mobile').start, 70);
  assert.equal(migrated.domains.find(d => d.id === 'ui-isolation').start, 90);
 }
 for (const status of ['draft', 'completed']) {
  const migrated = migrateFlatTopology([...flatExperiments(), oldPresentationExperiment(`OLD-${status}`, 60, 40, status)]);
  assert.equal(migrated.domains.find(d => d.id === 'ui-mobile').start, 60);
  assert.equal(migrated.domains.find(d => d.id === 'ui-isolation').start, 80);
 }
});

test('flat-model migration drops an entire demonstration branch when no continuous space remains', () => {
 const busy = [...flatExperiments(), oldPresentationExperiment('OLD-BUSY', 60, 35)];
 const migrated = migrateFlatTopology(busy);
 assert.equal(validateTopology(migrated, busy), null);
 assert.deepEqual(migrated.domains.map(d => d.id), ['root', 'overlap', 'exclusive']);
 assert.ok(!migrated.layers.some(l => ['ui-mobile', 'ui-isolation', 'card-depth'].includes(l.domainId)));
 const fragmented = [...flatExperiments(), oldPresentationExperiment('OLD-FRAGMENT-A', 69, 11), oldPresentationExperiment('OLD-FRAGMENT-B', 89, 11)];
 assert.equal(validateTopology(flatTopology(), fragmented), null);
 assert.deepEqual(migrateFlatTopology(fragmented).domains.map(d => d.id), ['root', 'overlap', 'exclusive'], '18% total free in two 9% holes cannot host a 10% or 20% demo domain');
 const restored = restoreBrowserState({ 'exp-lab-experiments-v2': JSON.stringify(busy) });
 assert.deepEqual(restored.topology, migrated);
 assert.ok(!restored.seedIds.some(id => id.startsWith('EXP-12')), 'Removed domains must not leave orphaned example experiments');
 assert.deepEqual(JSON.parse(restored.originalEntries['exp-lab-experiments-v2']), busy, 'The original persisted experiment copy is retained');
});

test('saved topology takes precedence over reinserting default nested examples', () => {
 const saved = flatTopology();
 saved.domains.push({ id: 'user-domain', name: '用户自建子域', parentLayerId: 'presentation', mode: 'non-overlapping', traffic: 10, start: 90, unit: 'user_id', description: 'Preserve existing topology' });
 saved.layers.push({ id: 'user-layer', name: '用户继承参数层', domainId: 'user-domain', parameterKeys: ['*'], description: '' });
 const entries = { 'exp-lab-topology-v1': JSON.stringify(saved), 'exp-lab-experiments-v2': JSON.stringify(flatExperiments()) };
 const restored = restoreBrowserState(entries);
 assert.deepEqual(restored.topology, saved);
 assert.equal(restored.savedTopology, entries['exp-lab-topology-v1']);
 assert.ok(!restored.seedIds.some(id => id.startsWith('EXP-12')));
});

test('legacy v1 normalization establishes flat allocations before nested examples are inserted', () => {
 const existing = [...flatExperiments(), oldPresentationExperiment('OLD-V1', 60, 10)];
 const legacy = existing.map(e => ({ ...e, domainId: '', layerId: '', parameterKeys: undefined, bucketStart: undefined }));
 // Earlier v1 had no root non-overlap domain, so this fixture uses only overlap records.
 const overlapLegacy = legacy.filter((_, i) => existing[i].domainId === 'overlap');
 const baseline = normalizeExperiments(overlapLegacy, flatTopology());
 const migrated = migrateFlatTopology(overlapLegacy);
 assert.equal(validateTopology(migrated, baseline), null);
 assert.deepEqual(normalizeExperiments(overlapLegacy, migrated), baseline);
 const restored = restoreBrowserState({ 'exp-lab-experiments-v1': JSON.stringify(overlapLegacy) });
 assert.deepEqual(restored.topology, migrated);
});

// Domain-local parameter partitions can be split without changing existing traffic buckets.
const newLayerInput = (overrides = {}) => ({
 id: 'new-independent-layer', domainId: 'overlap', name: '召回与库存参数层',
 description: 'Move unused parameters into an independently randomized layer',
 parameterKeys: ['ranking.recall', 'checkout.inventory'], ...overrides,
});

test('creating a layer transfers unused keys from sibling layers and preserves a complete partition', () => {
 const topology = cloneTopology();
 const originalTopology = structuredClone(topology);
 const experiments = structuredClone(initialExperiments);
 const originalExperiments = structuredClone(experiments);
 const planned = planLayerCreation(newLayerInput(), experiments, topology);
 assert.equal(planned.error, null);
 assert.ok(planned.topology);
 assert.deepEqual(topology, originalTopology, 'Planning must not mutate the current topology');
 assert.deepEqual(experiments, originalExperiments, 'Planning must not rewrite experiment configurations');
 assert.equal(validateTopology(planned.topology, experiments), null);
 assert.deepEqual(planned.topology.domains, topology.domains, 'Adding a layer does not reallocate domain traffic');
 const added = planned.topology.layers.find(l => l.id === 'new-independent-layer');
 assert.deepEqual(added.parameterKeys, ['ranking.recall', 'checkout.inventory']);
 assert.equal(added.domainId, 'overlap');
 assert.ok(!layerScope('ranking', planned.topology).includes('ranking.recall'));
 assert.ok(!layerScope('transaction', planned.topology).includes('checkout.inventory'));
 const partition = domainLayers('overlap', planned.topology).flatMap(l => layerScope(l.id, planned.topology));
 assert.deepEqual([...partition].sort(), [...domainScope('overlap', planned.topology)].sort());
 assert.equal(new Set(partition).size, partition.length);
 assert.ok(domainLayers('overlap', planned.topology).every(l => layerScope(l.id, planned.topology).length > 0));
 for (const e of active) assert.equal(validateAllocation(e, experiments, planned.topology), null, e.id);
 assert.equal(findAvailableStart(added.id, 100, experiments, undefined, planned.topology), 0, 'A new parameter layer starts with all its domain traffic available');
});

test('creating an independent layer leaves existing experiment variants, buckets and returned parameters unchanged', () => {
 const planned = planLayerCreation(newLayerInput(), initialExperiments, cloneTopology());
 assert.equal(planned.error, null);
 const assignments = result => result.decisions.filter(d => d.experimentId).map(d => ({
  layerId: d.layerId, experimentId: d.experimentId, variant: d.variant, bucket: d.bucket, parameters: d.parameters,
 }));
 let visitedNewLayer = 0;
 for (const { user, result: before } of samples().filter((_, i) => i % 5 === 0)) {
  const after = simulateAllocation(user, initialExperiments, planned.topology);
  assert.equal(after.error, undefined);
  assert.deepEqual(assignments(after), assignments(before));
  assert.deepEqual(after.mergedParameters, before.mergedParameters);
  assert.deepEqual(after.enteredDomains, before.enteredDomains);
  const addedDecision = after.decisions.find(d => d.layerId === 'new-independent-layer');
  if (addedDecision) {
   visitedNewLayer++;
   assert.equal(addedDecision.experimentId, null);
   assert.equal(addedDecision.childDomainId, null);
  }
 }
 assert.ok(visitedNewLayer > 0);
});

test('nested domains can split unused parameters while inheriting the exact ancestor traffic and scope', () => {
 assert.equal(layerCreationBlock('ui-mobile', defaultTopology), null);
 const planned = planLayerCreation(newLayerInput({ domainId: 'ui-mobile', name: '会员入口子层', parameterKeys: ['ui.membership'] }), initialExperiments, cloneTopology());
 assert.equal(planned.error, null);
 assert.equal(validateTopology(planned.topology, initialExperiments), null);
 assert.equal(domainGlobalTraffic('ui-mobile', planned.topology), 16);
 assert.deepEqual(layerScope('ui-navigation', planned.topology), ['ui.layout', 'ui.onboarding']);
 assert.deepEqual(layerScope('new-independent-layer', planned.topology), ['ui.membership']);
 assert.deepEqual(nodePath('layer', 'new-independent-layer', planned.topology).map(n => n.id), ['root', 'root-layer', 'overlap', 'presentation', 'ui-mobile', 'new-independent-layer']);
 const parentLayer = defaultTopology.layers.find(l => l.id === 'presentation');
 assert.deepEqual(planned.topology.layers.find(l => l.id === parentLayer.id), parentLayer, 'Nested splitting must not change the ancestor parameter layer');
});

test('parameter availability protects active and draft configurations, descendants, and single-key layers', () => {
 const overlapOptions = layerParameterOptions('overlap', initialExperiments, defaultTopology);
 const option = key => overlapOptions.find(o => o.key === key);
 assert.equal(option('ranking.recall').sourceLayerId, 'ranking');
 assert.equal(option('checkout.inventory').sourceLayerId, 'transaction');
 assert.ok(!option('ranking.recall').blockedReason);
 assert.ok(!option('checkout.inventory').blockedReason);
 for (const key of ['ranking.model', 'ranking.search', 'ranking.longtail', 'checkout.cache_ttl', 'checkout.parallel', 'pricing.coupon']) assert.ok(option(key).blockedReason, key);
 // Even currently unused keys remain protected if removing them would narrow descendants.
 for (const key of registeredParameters.filter(k => k.startsWith('ui.'))) assert.ok(option(key).blockedReason, key);
 const nested = layerParameterOptions('ui-mobile', initialExperiments, defaultTopology);
 assert.ok(!nested.find(o => o.key === 'ui.membership').blockedReason);
 assert.ok(nested.find(o => o.key === 'ui.cart').blockedReason);
 for (const entry of layerParameterOptions('card-depth', [], defaultTopology)) assert.ok(entry.blockedReason, 'One-key source layers cannot become empty');
});

test('all editable experiment states protect their declared parameters, while completed records remain historical', () => {
 const historical = initialExperiments.find(e => e.parameterKeys.includes('ranking.recall'));
 assert.equal(historical.status, 'completed');
 for (const status of ['draft', 'review', 'running', 'paused']) {
  const experiments = initialExperiments.map(e => e.id === historical.id ? { ...e, status, traffic: 5, bucketStart: 30 } : e);
  const option = layerParameterOptions('overlap', experiments, defaultTopology).find(o => o.key === 'ranking.recall');
  assert.ok(option.blockedReason, status);
  const planned = planLayerCreation(newLayerInput({ parameterKeys: ['ranking.recall'] }), experiments, cloneTopology());
  assert.ok(planned.error, status);
  assert.equal(planned.topology, null);
 }
 const planned = planLayerCreation(newLayerInput({ parameterKeys: ['ranking.recall'] }), initialExperiments, cloneTopology());
 assert.equal(planned.error, null);
 assert.equal(historical.layerId, 'ranking');
 assert.equal(validTransition(historical.status, 'running'), false, 'Historical configurations cannot restart after their parameter ownership changes');
});

test('root routing, non-overlapping domains, and their descendants reject adding a parallel layer', () => {
 for (const domainId of ['root', 'exclusive', 'ui-isolation', 'unknown-domain']) {
  assert.ok(layerCreationBlock(domainId, defaultTopology), domainId);
  const planned = planLayerCreation(newLayerInput({ domainId, parameterKeys: ['ui.layout'] }), initialExperiments, cloneTopology());
  assert.ok(planned.error, domainId);
  assert.equal(planned.topology, null);
 }
 const nested = addChild(cloneTopology(), { parentLayerId: 'full', mode: 'overlapping', start: 60 });
 assert.equal(validateTopology(nested, initialExperiments), null);
 assert.ok(layerCreationBlock('new-ui-domain', nested), 'An overlapping descendant must still respect its non-overlapping ancestor');
 const planned = planLayerCreation(newLayerInput({ domainId: 'new-ui-domain', parameterKeys: ['ui.layout'] }), initialExperiments, nested);
 assert.ok(planned.error);
 assert.equal(planned.topology, null);
});

test('layer creation rejects invalid names, identifier collisions and invalid parameter selections', () => {
 const invalid = [
  { name: '' }, { name: '   ' }, { name: '排序参数层' },
  { id: '' }, { id: 'overlap' }, { id: 'ranking' }, { id: initialExperiments[0].id },
  { parameterKeys: null }, { parameterKeys: ['ranking.recall', 'ranking.recall'] },
  { parameterKeys: ['unregistered.parameter'] }, { parameterKeys: ['*'] },
  { domainId: 'ui-mobile', parameterKeys: ['ranking.recall'] },
 ];
 for (const overrides of invalid) {
  const planned = planLayerCreation(newLayerInput(overrides), initialExperiments, cloneTopology());
  assert.ok(planned.error, JSON.stringify(overrides));
  assert.equal(planned.topology, null, JSON.stringify(overrides));
 }
 const drainSource = planLayerCreation(newLayerInput({ parameterKeys: layerScope('ranking') }), [], cloneTopology());
 assert.ok(drainSource.error, 'Combining individually transferable keys must not empty an existing source layer');
 assert.equal(drainSource.topology, null);
});

test('splitting an inherited wildcard layer materializes both remaining and moved parameter scopes', () => {
 const topology = addChild(cloneTopology(), { mode: 'overlapping' });
 assert.equal(validateTopology(topology, initialExperiments), null);
 assert.deepEqual(layerScope('new-ui-layer', topology), layerScope('presentation', topology));
 const planned = planLayerCreation(newLayerInput({ domainId: 'new-ui-domain', name: '独立会员层', parameterKeys: ['ui.membership'] }), initialExperiments, topology);
 assert.equal(planned.error, null);
 assert.equal(validateTopology(planned.topology, initialExperiments), null);
 const originalLayer = planned.topology.layers.find(l => l.id === 'new-ui-layer');
 assert.ok(!originalLayer.parameterKeys.includes('*'), 'The source wildcard cannot continue to overlap the new layer');
 assert.deepEqual(originalLayer.parameterKeys, layerScope('presentation', topology).filter(k => k !== 'ui.membership'));
 assert.deepEqual(layerScope('new-independent-layer', planned.topology), ['ui.membership']);
});

test('saved newly created layers restore after reload with the exact experiment history intact', () => {
 const planned = planLayerCreation(newLayerInput(), initialExperiments, cloneTopology());
 assert.equal(planned.error, null);
 const script = `
  import { readFileSync } from 'node:fs';
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const values = new Map([['exp-lab-experiments-v3', JSON.stringify(input.experiments)]]);
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, configurable: true });
  const traffic = await import('./src/traffic.ts');
  const error = traffic.saveTopology(input.topology, input.experiments);
  process.stdout.write(JSON.stringify({ error, entries: Object.fromEntries(values), topology: traffic.getTopology() }));
 `;
 const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), input: JSON.stringify({ topology: planned.topology, experiments: initialExperiments }), encoding: 'utf8' });
 assert.equal(child.status, 0, child.stderr);
 const saved = JSON.parse(child.stdout);
 assert.equal(saved.error, null);
 const expectedTopology = { ...planned.topology, catalog: getCatalog(planned.topology) };
 assert.deepEqual(saved.topology, expectedTopology, 'Saving hydrates the compatible service catalog without changing the planned domains or layers');
 assert.deepEqual(saved.topology.domains, planned.topology.domains);
 assert.deepEqual(saved.topology.layers, planned.topology.layers);
 const restored = restoreBrowserState(saved.entries);
 assert.deepEqual(restored.topology, expectedTopology);
 assert.deepEqual(JSON.parse(restored.originalEntries['exp-lab-experiments-v3']), initialExperiments);
 const remaining = layerParameterOptions('overlap', initialExperiments, restored.topology).find(o => o.key === 'ranking.recall');
 assert.equal(remaining.sourceLayerId, 'new-independent-layer', 'Reload resolves parameter ownership from the saved topology');
});
