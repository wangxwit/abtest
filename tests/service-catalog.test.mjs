import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { initialExperiments } from '../src/data.ts';
import { defaultTopology, validateTopology, validateAllocation, simulateAllocation } from '../src/traffic.ts';
import { planParameterRegistration, planParameterLayerAssignment } from '../src/parameter-registration.ts';
import {
  getCatalog, getServiceTags, getParameterBinding, getParameterService, getParameterTags, experimentServices, migrateServiceCatalog,
  validateServiceCatalog, planServiceRegistration, planServiceEnvironment, planTagCreate, planParameterTags, planParameterService,
} from '../src/service-catalog.ts';

const base = () => structuredClone(defaultTopology);
const withCatalog = () => ({ ...base(), catalog: getCatalog(base()) });
const tagId = (serviceId, name, topology = base()) => getServiceTags(serviceId, topology).find(tag => tag.name === name)?.id;
const parameter = (overrides = {}) => ({ key: 'ranking.new_weight', name: '新权重', owner: '策略组', description: '', type: 'number', defaultValue: 0, serviceId: 'ranking-service', tagIds: [], ...overrides });
const register = (input = parameter(), topology = base()) => planParameterRegistration(input, { overlap: 'ranking' }, initialExperiments, topology);
const service = (overrides = {}) => ({ id: 'experiment-gateway', name: '实验网关', owner: '平台组', type: 'gateway', description: '统一决策入口', ...overrides });
function legacyCustom() {
 const registered = register().topology;
 const topology = planParameterLayerAssignment('ranking.new_weight', { overlap: 'ranking' }, initialExperiments, registered).topology;
 delete topology.catalog; delete topology.pendingParameterKeys; return topology;
}
function rejected(plan) { assert.equal(plan.topology, null); assert.ok(plan.error); }

test('old snapshots hydrate explicit built-in service owners and leave custom keys unassigned without mutation', () => {
  const topology = legacyCustom(), before = structuredClone(topology), catalog = getCatalog(topology);
  assert.equal(catalog.services.length, 4);
  assert.equal(catalog.bindings.length, 14);
  assert.equal(getParameterService('ui.layout', topology).id, 'ui-web');
  assert.equal(getParameterService('ranking.model', topology).id, 'ranking-service');
  assert.equal(getParameterBinding('ranking.new_weight', topology).serviceId, null, 'A matching prefix is not ownership evidence');
  assert.deepEqual(topology, before);
  assert.equal(validateTopology(topology, initialExperiments), null);
  for (const experiment of initialExperiments.filter(item => item.status === 'running')) assert.equal(validateAllocation(experiment, initialExperiments, topology), null);
});

test('parameter registration requires a real service and valid tags in the same snapshot as its definition', () => {
  for (const changes of [{ serviceId: undefined }, { serviceId: null }, { serviceId: 'unknown' }, { tagIds: undefined }, { tagIds: ['unknown'] }, { tagIds: ['performance', 'performance'] }]) rejected(register(parameter(changes)));
  const ids = [tagId('ranking-service', '首页推荐'), tagId('ranking-service', '性能优化')];
  const topology = register(parameter({ tagIds: ids })).topology;
  assert.equal(validateTopology(topology, initialExperiments), null);
  assert.deepEqual(getParameterBinding('ranking.new_weight', topology), { key: 'ranking.new_weight', serviceId: 'ranking-service', tagIds: ids });
  assert.equal('serviceId' in topology.parameters[0], false, 'The existing parameter definition schema remains unchanged');
  assert.equal('tagIds' in topology.parameters[0], false);
});

test('same-name tags stay private to each service and experiment service lists deduplicate parameter owners', () => {
  const topology = base();
  assert.ok(getParameterTags('ui.layout', topology).some(tag => tag.name === '首页推荐'));
  assert.ok(getParameterTags('ranking.model', topology).some(tag => tag.name === '首页推荐'));
  assert.notEqual(tagId('ui-web', '首页推荐'), tagId('ranking-service', '首页推荐'));
  assert.ok(getServiceTags('ui-web', topology).every(tag => tag.serviceId === 'ui-web'));
  assert.deepEqual(experimentServices({ parameterKeys: ['ui.layout', 'ranking.model', 'ranking.recall', 'ui.layout'] }, topology).map(item => item.id), ['ui-web', 'ranking-service']);
  assert.deepEqual(experimentServices({ parameterKeys: ['ranking.new_weight'] }, legacyCustom()), []);
});

test('tag add, remove, and replace preserve declared experiment parameters, payloads, and deterministic allocations', () => {
  const topology = base(), before = structuredClone(topology), experiments = structuredClone(initialExperiments);
  const created = planTagCreate('ui-web', '推荐联动', 'green', topology);
  assert.equal(created.error, null);
  let updated = planParameterTags(['ui.layout', 'ui.content_card'], [created.tagId], 'add', created.topology).topology;
  assert.ok(getParameterBinding('ui.layout', updated).tagIds.includes(tagId('ui-web', '首页推荐')));
  updated = planParameterTags(['ui.layout'], [tagId('ui-web', '首页推荐')], 'remove', updated).topology;
  assert.deepEqual(getParameterBinding('ui.layout', updated).tagIds, [created.tagId]);
  updated = planParameterTags(['ranking.model'], [], 'replace', updated).topology;
  assert.deepEqual(getParameterTags('ranking.model', updated), []);
  assert.deepEqual(updated.domains, topology.domains);
  assert.deepEqual(updated.layers, topology.layers);
  assert.deepEqual(initialExperiments, experiments);
  assert.deepEqual(topology, before);
  for (let index = 0; index < 50; index++) assert.deepEqual(simulateAllocation(`tag-stability-${index}`, initialExperiments, updated), simulateAllocation(`tag-stability-${index}`, initialExperiments, topology));
});

test('tag operations reject duplicate names, unsafe colors, unknown parameters, and unknown tag references atomically', () => {
  const topology = withCatalog(), before = structuredClone(topology);
  rejected(planTagCreate('ui-web', '首页推荐', 'blue', topology));
  rejected(planTagCreate('ui-web', '新标签', 'url(https://example.com)', topology));
  rejected(planTagCreate('ui-web', ' '.repeat(2), 'green', topology));
  rejected(planParameterTags(['unknown.key'], ['performance'], 'add', topology));
  rejected(planParameterTags(['ui.layout'], ['unknown'], 'remove', topology));
  rejected(planParameterTags(['ui.layout', 'ui.layout'], ['performance'], 'add', topology));
  rejected(planParameterTags(['ui.layout'], [], 'invalid', topology));
  assert.deepEqual(topology, before);
});

test('service registration creates separate unverified environment configurations without fabricated runtime evidence', () => {
  const topology = base(), before = structuredClone(topology), result = planServiceRegistration(service(), topology);
  assert.equal(result.error, null);
  const saved = getCatalog(result.topology).services.find(item => item.id === 'experiment-gateway');
  assert.deepEqual(saved.environments, ['development', 'staging', 'production'].map(name => ({ name, mode: 'direct' })));
  assert.equal(saved.status, undefined);
  assert.equal(saved.lastHeartbeat, undefined);
  assert.deepEqual(topology, before);
  rejected(planServiceRegistration(service({ id: 'ui-web' }), topology));
  rejected(planServiceRegistration(service({ name: '用户界面服务' }), topology));
  rejected(planServiceRegistration(service({ owner: '' }), topology));
});

test('delegation is gateway-only and environment-specific; switching mode preserves other environments', () => {
  const topology = planServiceRegistration(service(), base()).topology;
  const result = planServiceEnvironment('ui-web', { name: 'production', mode: 'delegated', decisionServiceId: 'experiment-gateway' }, topology);
  assert.equal(result.error, null);
  const environments = getCatalog(result.topology).services.find(item => item.id === 'ui-web').environments;
  assert.deepEqual(environments.slice(0, 2), [{ name: 'development', mode: 'direct' }, { name: 'staging', mode: 'direct' }]);
  assert.equal(environments[2].decisionServiceId, 'experiment-gateway');
  rejected(planServiceEnvironment('ui-web', { name: 'production', mode: 'delegated', decisionServiceId: 'ranking-service' }, topology));
  rejected(planServiceEnvironment('ui-web', { name: 'production', mode: 'delegated', decisionServiceId: 'unknown' }, topology));
  rejected(planServiceEnvironment('ui-web', { name: 'production', mode: 'direct', decisionServiceId: 'experiment-gateway' }, topology));
  const direct = planServiceEnvironment('ui-web', { name: 'production', mode: 'direct' }, result.topology);
  assert.equal(direct.error, null);
  assert.equal(getCatalog(direct.topology).services.find(item => item.id === 'ui-web').environments[2].decisionServiceId, undefined);
});

test('delegation rejects self-reference and same-environment cycles while allowing independent environment routes', () => {
  let topology = planServiceRegistration(service(), base()).topology;
  topology = planServiceRegistration(service({ id: 'second-gateway', name: '备用网关' }), topology).topology;
  rejected(planServiceEnvironment('experiment-gateway', { name: 'production', mode: 'delegated', decisionServiceId: 'experiment-gateway' }, topology));
  topology = planServiceEnvironment('experiment-gateway', { name: 'production', mode: 'delegated', decisionServiceId: 'second-gateway' }, topology).topology;
  rejected(planServiceEnvironment('second-gateway', { name: 'production', mode: 'delegated', decisionServiceId: 'experiment-gateway' }, topology));
  const independent = planServiceEnvironment('second-gateway', { name: 'staging', mode: 'delegated', decisionServiceId: 'experiment-gateway' }, topology);
  assert.equal(independent.error, null);
});

test('catalog validator rejects malformed catalogs, missing bindings, unknown references, duplicate environments, and forged readiness', () => {
  const mutations = [
    topology => { topology.catalog = null; },
    topology => { topology.catalog.bindings.push(structuredClone(topology.catalog.bindings[0])); },
    topology => { topology.catalog.bindings.pop(); },
    topology => { topology.catalog.bindings[0].serviceId = 'missing'; },
    topology => { topology.catalog.bindings[0].tagIds = ['missing']; },
    topology => { topology.catalog.bindings[0].key = 'unregistered.key'; },
    topology => { topology.catalog.tags.push(structuredClone(topology.catalog.tags[0])); },
    topology => { topology.catalog.services.push(structuredClone(topology.catalog.services[0])); },
    topology => { topology.catalog.services[0].environments[1].name = 'development'; },
    topology => { topology.catalog.services[0].environments.pop(); },
    topology => { topology.catalog.services[0].environments[0].status = 'connected'; },
    topology => { topology.catalog.services[0].lastHeartbeat = '2026-09-12T00:00:00Z'; },
  ];
  for (const mutate of mutations) {
    const topology = withCatalog(); mutate(topology);
    assert.doesNotThrow(() => validateServiceCatalog(topology));
    assert.ok(validateServiceCatalog(topology));
    assert.ok(validateTopology(topology));
  }
});

test('only historical unassigned parameters can acquire an owner; explicit service ownership cannot be migrated', () => {
  const topology = legacyCustom();
  const result = planParameterService('ranking.new_weight', 'checkout-service', topology);
  assert.equal(result.error, null);
  assert.equal(getParameterService('ranking.new_weight', result.topology).id, 'checkout-service', 'Ownership is explicit rather than inferred from key prefixes');
  assert.deepEqual(result.topology.parameters, topology.parameters);
  assert.deepEqual(result.topology.layers, topology.layers);
  rejected(planParameterService('ranking.new_weight', 'ranking-service', result.topology));
  rejected(planParameterService('ui.layout', 'ranking-service', topology));
  rejected(planParameterService('ranking.new_weight', 'missing-service', topology));
});

function browserProcess(script, input) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const values = new Map(Object.entries(input.entries ?? {}));
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (input.failStorage) throw new Error('quota'); values.set(key, value); } }, configurable: true });
    const traffic = await import('./src/traffic.ts');
    const catalog = await import('./src/service-catalog.ts');
    ${script}
  `], { cwd: new URL('..', import.meta.url), input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('service and parameter ownership persist in one snapshot and direct saves cannot bypass ownership locks', () => {
  const topology = register().topology;
  const result = browserProcess(`
    const error = traffic.saveTopology(input.topology, []);
    const original = values.get('exp-lab-topology-v1');
    const changed = structuredClone(traffic.getTopology());
    changed.catalog.bindings.find(item => item.key === 'ranking.new_weight').serviceId = 'checkout-service';
    const changeError = traffic.saveTopology(changed, []);
    process.stdout.write(JSON.stringify({ error, changeError, original, persisted: values.get('exp-lab-topology-v1') }));
  `, { topology });
  assert.equal(result.error, null);
  assert.ok(result.changeError);
  assert.equal(result.original, result.persisted);
  const restored = browserProcess(`process.stdout.write(JSON.stringify({ topology: traffic.getTopology(), owner: catalog.getParameterService('ranking.new_weight', traffic.getTopology()).id }));`, { entries: { 'exp-lab-topology-v1': result.persisted } });
  assert.deepEqual(restored.topology, topology);
  assert.equal(restored.owner, 'ranking-service');
  const bypass = browserProcess(`process.stdout.write(JSON.stringify({ error: traffic.saveTopology(input.topology, []) }));`, { topology: legacyCustom() });
  assert.ok(bypass.error, 'New parameters cannot be introduced without ownership by bypassing the registration planner');
});

test('failed storage never partially applies service/tag metadata or emits a topology notification', () => {
  const result = browserProcess(`
    const before = structuredClone(traffic.getTopology()); let notifications = 0;
    traffic.subscribeTopology(() => notifications++);
    const planned = catalog.planTagCreate('ui-web', '未保存标签', 'green', before);
    const error = traffic.saveTopology(planned.topology, []);
    process.stdout.write(JSON.stringify({ before, after: traffic.getTopology(), error, notifications }));
  `, { failStorage: true });
  assert.ok(result.error);
  assert.deepEqual(result.before, result.after);
  assert.equal(result.notifications, 0);
});

test('omitting an existing catalog cannot reset custom services, tags, or environment configuration', () => {
  const result = browserProcess(`
    const registered = catalog.planServiceRegistration({ id: 'custom-gateway', name: '自定义网关', owner: '平台组', type: 'gateway', description: '' }, traffic.getTopology());
    const delegated = catalog.planServiceEnvironment('ui-web', { name: 'production', mode: 'delegated', decisionServiceId: 'custom-gateway' }, registered.topology);
    const tagged = catalog.planTagCreate('ui-web', '自定义业务标签', 'green', delegated.topology);
    const firstError = traffic.saveTopology(tagged.topology, []);
    const before = structuredClone(traffic.getTopology());
    const storedBefore = values.get('exp-lab-topology-v1');
    let notifications = 0;
    traffic.subscribeTopology(() => notifications++);
    const error = traffic.saveTopology(structuredClone(traffic.defaultTopology), []);
    process.stdout.write(JSON.stringify({ firstError, error, before, after: traffic.getTopology(), storedBefore, storedAfter: values.get('exp-lab-topology-v1'), notifications }));
  `, {});
  assert.equal(result.firstError, null);
  assert.match(result.error, /完整目录/);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.storedAfter, result.storedBefore);
  assert.equal(result.notifications, 0);
  assert.ok(getCatalog(result.after).services.some(item => item.id === 'custom-gateway'));
  assert.ok(getCatalog(result.after).tags.some(item => item.name === '自定义业务标签'));
  assert.equal(getCatalog(result.after).services.find(item => item.id === 'ui-web').environments.find(item => item.name === 'production').decisionServiceId, 'custom-gateway');
});

function oldSharedTopology() {
  const topology = legacyCustom(), current = getCatalog(topology);
  topology.catalog = {
    services: current.services,
    tags: [
      { id: 'shared-homepage', name: '首页推荐', color: 'purple' },
      { id: 'shared-pending', name: '待认领标签', color: '#123456' },
      { id: 'shared-unused', name: '未使用标签', color: 'orange' },
    ],
    bindings: current.bindings.map(binding => ({ key: binding.key, serviceId: binding.serviceId,
      tagIds: ['ui.layout', 'ranking.model'].includes(binding.key) ? ['shared-homepage'] : binding.key === 'ranking.new_weight' ? ['shared-homepage', 'shared-pending'] : [],
    })),
  };
  return topology;
}

test('application tag names are unique within an owner while different owners may create the same normalized name', () => {
  const first = planTagCreate('ui-web', 'Independent Label', 'green', base());
  assert.equal(first.error, null);
  rejected(planTagCreate('ui-web', ' independent label ', 'blue', first.topology));
  const second = planTagCreate('ranking-service', 'Independent Label', 'blue', first.topology);
  assert.equal(second.error, null);
  assert.notEqual(first.tagId, second.tagId);
  assert.equal(getServiceTags('ui-web', second.topology).find(tag => tag.id === first.tagId).color, 'green');
  assert.equal(getServiceTags('ranking-service', second.topology).find(tag => tag.id === second.tagId).color, 'blue');
  assert.ok(!getServiceTags('ui-web', second.topology).some(tag => tag.id === second.tagId));
  rejected(planTagCreate('missing-service', 'Independent Label', 'green', second.topology));
});

test('all tag mutation modes and registration reject foreign tag ids or mixed-owner parameter selections', () => {
  const topology = withCatalog(), before = structuredClone(topology);
  const uiTag = tagId('ui-web', '首页推荐', topology), rankingTag = tagId('ranking-service', '首页推荐', topology);
  for (const mode of ['add', 'remove', 'replace']) {
    rejected(planParameterTags(['ui.layout'], [rankingTag], mode, topology));
    rejected(planParameterTags(['ui.layout', 'ranking.model'], [uiTag], mode, topology));
    rejected(planParameterTags(['ui.layout', 'ranking.model'], [], mode, topology));
    rejected(planParameterTags(['ranking.new_weight'], [], mode, legacyCustom()));
  }
  rejected(register(parameter({ tagIds: [uiTag] }), topology));
  assert.deepEqual(topology, before);
  const forged = structuredClone(topology);
  forged.catalog.bindings.find(binding => binding.key === 'ui.layout').tagIds = [rankingTag];
  assert.match(validateServiceCatalog(forged), /其他应用/);
  assert.deepEqual(getParameterTags('ui.layout', forged), [], 'Read helpers cannot expose another owner even in a malformed snapshot');
});

test('legacy shared tags split into stable private copies while unused tags and unassigned associations remain archived', () => {
  const legacy = oldSharedTopology(), before = structuredClone(legacy), result = migrateServiceCatalog(legacy);
  assert.equal(result.error, null);
  assert.equal(result.migrated, true);
  assert.equal(result.topology.catalog.schemaVersion, 2);
  assert.equal(validateTopology(result.topology, initialExperiments), null);
  const uiTag = getParameterTags('ui.layout', result.topology)[0], rankingTag = getParameterTags('ranking.model', result.topology)[0];
  assert.equal(uiTag.name, '首页推荐'); assert.equal(uiTag.color, 'purple');
  assert.equal(rankingTag.name, uiTag.name); assert.notEqual(rankingTag.id, uiTag.id);
  assert.equal(uiTag.serviceId, 'ui-web'); assert.equal(rankingTag.serviceId, 'ranking-service');
  assert.deepEqual(result.topology.catalog.legacyTags, legacy.catalog.tags, 'Even unreferenced global labels are retained');
  assert.deepEqual(getParameterBinding('ranking.new_weight', result.topology), { key: 'ranking.new_weight', serviceId: null, tagIds: [], pendingTagIds: ['shared-homepage', 'shared-pending'] });
  assert.deepEqual(getParameterTags('ranking.new_weight', result.topology), []);
  assert.ok(getServiceTags('pricing-service', result.topology).length === 0, 'Unreferenced legacy tags are not exposed in unrelated applications');
  assert.deepEqual(result.topology.parameters, legacy.parameters);
  assert.deepEqual(result.topology.domains, legacy.domains);
  assert.deepEqual(result.topology.layers, legacy.layers);
  assert.deepEqual(legacy, before, 'The migration plan is pure');
  assert.deepEqual(migrateServiceCatalog(legacy).topology, result.topology, 'Repeated migration of the same legacy input yields identical ids');
  const current = migrateServiceCatalog(result.topology);
  assert.equal(current.migrated, false);
  assert.deepEqual(current.topology, result.topology);
  const reordered = structuredClone(legacy);
  reordered.catalog.services.reverse(); reordered.catalog.tags.reverse();
  const stableIds = migrateServiceCatalog(reordered).topology.catalog.tags.map(tag => [tag.serviceId, tag.name, tag.id]).sort();
  assert.deepEqual(stableIds, result.topology.catalog.tags.map(tag => [tag.serviceId, tag.name, tag.id]).sort());
  const comparable = structuredClone(legacy); delete comparable.catalog;
  for (let index = 0; index < 20; index++) assert.deepEqual(simulateAllocation(`migration-${index}`, initialExperiments, result.topology), simulateAllocation(`migration-${index}`, initialExperiments, comparable));
});

test('claiming a migrated parameter restores pending labels and reuses same-name private labels with their existing color', () => {
  let topology = migrateServiceCatalog(oldSharedTopology()).topology;
  const created = planTagCreate('ranking-service', '待认领标签', 'blue', topology);
  assert.equal(created.error, null); topology = created.topology;
  const count = topology.catalog.tags.length;
  const originalId = getParameterTags('ranking.model', topology)[0].id;
  const result = planParameterService('ranking.new_weight', 'ranking-service', topology);
  assert.equal(result.error, null);
  assert.equal(result.topology.catalog.tags.length, count);
  assert.deepEqual(getParameterBinding('ranking.new_weight', result.topology).tagIds, [originalId, created.tagId]);
  assert.equal(getParameterBinding('ranking.new_weight', result.topology).pendingTagIds, undefined);
  assert.equal(getParameterTags('ranking.new_weight', result.topology).find(tag => tag.id === created.tagId).color, 'blue');
  assert.deepEqual(result.topology.catalog.legacyTags, topology.catalog.legacyTags);
  assert.deepEqual(result.topology.parameters, topology.parameters);
});

test('stable tag identifiers resolve hash collisions without replacing another service tag', () => {
  const predicted = planTagCreate('ui-web', '碰撞标签', 'green', base());
  const topology = withCatalog();
  topology.catalog.tags.push({ id: predicted.tagId, serviceId: 'ranking-service', name: '保留原标签', color: 'orange' });
  const result = planTagCreate('ui-web', '碰撞标签', 'green', topology);
  assert.equal(result.error, null);
  assert.equal(result.tagId, `${predicted.tagId}-1`);
  assert.equal(getServiceTags('ranking-service', result.topology).find(tag => tag.id === predicted.tagId).name, '保留原标签');
  assert.equal(planTagCreate('ui-web', '碰撞标签', 'green', topology).tagId, result.tagId);
});

test('the migration boundary never repairs forged current-format cross-owner tags or mixed legacy/current schemas', () => {
  const current = withCatalog(), foreign = tagId('ranking-service', '首页推荐', current);
  current.catalog.bindings.find(binding => binding.key === 'ui.layout').tagIds = [foreign];
  rejected(migrateServiceCatalog(current));
  assert.equal(migrateServiceCatalog(current).migrated, false);
  const stripped = structuredClone(current); delete stripped.catalog.schemaVersion;
  rejected(migrateServiceCatalog(stripped));
  const oldWithOwner = oldSharedTopology(); oldWithOwner.catalog.tags[0].serviceId = 'ui-web';
  rejected(migrateServiceCatalog(oldWithOwner));
  const future = withCatalog(); future.catalog.schemaVersion = 3;
  rejected(migrateServiceCatalog(future));
  assert.ok(validateServiceCatalog(oldSharedTopology()), 'Ordinary current-format validation must not perform legacy repair');
});

test('direct saves reject foreign references and moving even an unbound existing tag to another application', () => {
  const result = browserProcess(`
    const created = catalog.planTagCreate('ui-web', '不可迁移标签', 'green', traffic.getTopology());
    const firstError = traffic.saveTopology(created.topology, []);
    const stored = values.get('exp-lab-topology-v1');
    const moved = structuredClone(traffic.getTopology());
    moved.catalog.tags.find(tag => tag.id === created.tagId).serviceId = 'ranking-service';
    const structuralError = traffic.validateTopology(moved);
    const moveError = traffic.saveTopology(moved, []);
    const foreign = structuredClone(traffic.getTopology());
    foreign.catalog.bindings.find(binding => binding.key === 'ranking.model').tagIds.push(created.tagId);
    const referenceError = traffic.saveTopology(foreign, []);
    process.stdout.write(JSON.stringify({ firstError, structuralError, moveError, referenceError, stored, after: values.get('exp-lab-topology-v1') }));
  `, {});
  assert.equal(result.firstError, null);
  assert.equal(result.structuralError, null, 'Cross-snapshot ownership locks are distinct from snapshot structural checks');
  assert.match(result.moveError, /迁移/);
  assert.match(result.referenceError, /其他应用/);
  assert.equal(result.after, result.stored);
});

test('loading a legacy catalog atomically migrates, claiming restores labels, and reload retains exact private identifiers', () => {
  const legacy = oldSharedTopology(), entries = { 'exp-lab-topology-v1': JSON.stringify(legacy), 'exp-lab-experiments-v3': JSON.stringify(initialExperiments) };
  const migrated = browserProcess(`process.stdout.write(JSON.stringify({ error: traffic.getTopologyLoadError(), topology: traffic.getTopology(), entries: Object.fromEntries(values) }));`, { entries });
  assert.equal(migrated.error, null);
  assert.equal(migrated.topology.catalog.schemaVersion, 2);
  assert.deepEqual(JSON.parse(migrated.entries['exp-lab-topology-v1']), migrated.topology);
  assert.equal(migrated.entries['exp-lab-experiments-v3'], entries['exp-lab-experiments-v3']);
  const claimed = browserProcess(`
    const planned = catalog.planParameterService('ranking.new_weight', 'ranking-service', traffic.getTopology());
    const error = traffic.saveTopology(planned.topology, []);
    process.stdout.write(JSON.stringify({ error, topology: traffic.getTopology(), entries: Object.fromEntries(values) }));
  `, { entries: migrated.entries });
  assert.equal(claimed.error, null);
  const restored = browserProcess(`process.stdout.write(JSON.stringify({ error: traffic.getTopologyLoadError(), topology: traffic.getTopology(), entries: Object.fromEntries(values) }));`, { entries: claimed.entries });
  assert.equal(restored.error, null);
  assert.deepEqual(restored.topology, claimed.topology);
  assert.deepEqual(restored.entries, claimed.entries);
  assert.deepEqual(getParameterTags('ranking.new_weight', restored.topology).map(tag => tag.name), ['首页推荐', '待认领标签']);
  const removed = browserProcess(`
    const planned = catalog.planParameterTags(['ranking.new_weight'], [], 'replace', traffic.getTopology());
    const error = traffic.saveTopology(planned.topology, []);
    process.stdout.write(JSON.stringify({ error, topology: traffic.getTopology() }));
  `, { entries: restored.entries });
  assert.equal(removed.error, null, 'Once ownership claim has committed, restored private tags can be removed normally');
  assert.deepEqual(getParameterTags('ranking.new_weight', removed.topology), []);
  assert.equal(getParameterBinding('ranking.new_weight', removed.topology).pendingTagIds, undefined);
  assert.deepEqual(removed.topology.catalog.legacyTags, restored.topology.catalog.legacyTags);
});

test('a legacy migration storage failure preserves raw data and blocks subsequent topology overwrites', () => {
  const entries = { 'exp-lab-topology-v1': JSON.stringify(oldSharedTopology()), 'exp-lab-experiments-v3': JSON.stringify(initialExperiments) };
  const result = browserProcess(`
    const before = structuredClone(traffic.getTopology()); let notifications = 0;
    traffic.subscribeTopology(() => notifications++);
    const loadError = traffic.getTopologyLoadError();
    const saveError = traffic.saveTopology(traffic.defaultTopology, []);
    process.stdout.write(JSON.stringify({ loadError, saveError, before, after: traffic.getTopology(), entries: Object.fromEntries(values), notifications }));
  `, { entries, failStorage: true });
  assert.match(result.loadError, /迁移保存失败/);
  assert.equal(result.saveError, result.loadError);
  assert.deepEqual(result.entries, entries);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.notifications, 0);
});

test('invalid current data is never replaced with demo defaults or silently migrated during load', () => {
  const forged = withCatalog(); forged.catalog.bindings.find(binding => binding.key === 'ui.layout').tagIds = [tagId('ranking-service', '首页推荐', forged)];
  for (const raw of [JSON.stringify(forged), '{broken-json', JSON.stringify({ ...forged, catalog: null }), JSON.stringify({ ...forged, parameters: {} }), JSON.stringify({ ...forged, parameters: [null] })]) {
    const entries = { 'exp-lab-topology-v1': raw };
    const result = browserProcess(`
      const error = traffic.getTopologyLoadError();
      const saveError = traffic.saveTopology(traffic.defaultTopology, []);
      process.stdout.write(JSON.stringify({ error, saveError, entries: Object.fromEntries(values) }));
    `, { entries });
    assert.match(result.error, /无效/);
    assert.equal(result.saveError, result.error);
    assert.deepEqual(result.entries, entries);
  }
});

test('pending associations and unused legacy archives cannot be dropped by an unrelated save', () => {
  const entries = { 'exp-lab-topology-v1': JSON.stringify(oldSharedTopology()) };
  const result = browserProcess(`
    const stored = values.get('exp-lab-topology-v1');
    const removedPending = structuredClone(traffic.getTopology());
    removedPending.catalog.bindings.find(binding => binding.key === 'ranking.new_weight').pendingTagIds = [];
    const pendingError = traffic.saveTopology(removedPending, []);
    const removedArchive = structuredClone(traffic.getTopology());
    removedArchive.catalog.legacyTags = removedArchive.catalog.legacyTags.filter(tag => tag.id !== 'shared-unused');
    const archiveError = traffic.saveTopology(removedArchive, []);
    const bypassClaim = structuredClone(traffic.getTopology());
    const binding = bypassClaim.catalog.bindings.find(binding => binding.key === 'ranking.new_weight');
    binding.serviceId = 'ranking-service'; delete binding.pendingTagIds;
    const claimError = traffic.saveTopology(bypassClaim, []);
    process.stdout.write(JSON.stringify({ pendingError, archiveError, claimError, stored, after: values.get('exp-lab-topology-v1') }));
  `, { entries });
  assert.match(result.pendingError, /认领前删除/);
  assert.match(result.archiveError, /归档/);
  assert.match(result.claimError, /完整转换/);
  assert.equal(result.after, result.stored);
});

test('failed ownership claim persistence keeps pending labels and archive unchanged until the whole snapshot commits', () => {
  const entries = { 'exp-lab-topology-v1': JSON.stringify(oldSharedTopology()) };
  const result = browserProcess(`
    const before = structuredClone(traffic.getTopology()), storedBefore = values.get('exp-lab-topology-v1');
    const planned = catalog.planParameterService('ranking.new_weight', 'ranking-service', before);
    localStorage.setItem = () => { throw new Error('quota'); };
    const error = traffic.saveTopology(planned.topology, []);
    process.stdout.write(JSON.stringify({ error, before, after: traffic.getTopology(), storedBefore, storedAfter: values.get('exp-lab-topology-v1') }));
  `, { entries });
  assert.match(result.error, /存储失败/);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.storedAfter, result.storedBefore);
  assert.deepEqual(getParameterBinding('ranking.new_weight', result.after).pendingTagIds, ['shared-homepage', 'shared-pending']);
  assert.deepEqual(getParameterTags('ranking.new_weight', result.after), []);
});
