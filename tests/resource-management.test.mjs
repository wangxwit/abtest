import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { defaultResourceManagement, localDateString, planResourceManagementUpdate, resourceDueStatus, validateResourceManagement } from '../src/resource-management.ts';
import { defaultTopology, layerAudienceCapacity, layerScope, planLayerCreation, simulateAllocation, validateAllocation, validateTopology } from '../src/traffic.ts';
import { planChildDomainCreation } from '../src/child-domain-creation.ts';
import { planParameterRegistration } from '../src/parameter-registration.ts';
import { initialExperiments } from '../src/data.ts';
import { getCatalog } from '../src/service-catalog.ts';

const base = () => structuredClone(defaultTopology);
const temporary = (expectedEndDate = '2026-09-16') => ({ owner: '资源负责人', usageType: 'temporary', expectedEndDate });
const layerInput = (extra = {}) => ({ id: 'resource-layer', domainId: 'overlap', name: '资源管理验证层', description: '元数据不改变分流', parameterKeys: [], ...extra });
const childInput = (extra = {}) => ({ id: 'resource-child', parentLayerId: 'transaction', name: '临时策略域', mode: 'overlapping', traffic: 10, ...extra });
const planned = result => { assert.equal(result.error, null); assert.ok(result.topology); return result.topology; };
function isolatedStorageTest(body, entries = [['exp-lab-topology-v1', JSON.stringify(defaultTopology)]]) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const stored = new Map(${JSON.stringify(entries)});
    let failRead = false, failWrite = false, writes = 0;
    Object.defineProperty(globalThis, 'localStorage', { value: {
      getItem: key => { if (failRead) throw new Error('read unavailable'); return stored.get(key) ?? null; },
      setItem: (key, value) => { if (failWrite) throw new Error('quota exceeded'); writes++; stored.set(key, value); },
    }, configurable: true });
    const traffic = await import('./src/traffic.ts');
    const { planResourceManagementUpdate } = await import('./src/resource-management.ts');
    const candidate = () => planResourceManagementUpdate('domain', 'overlap', { owner: '资源负责人', usageType: 'long-term' }, traffic.getTopology()).topology;
    assert.equal(traffic.getTopologyLoadError(), null);
    ${body}
  `], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('resource defaults are explicit creation helpers; legacy nodes remain unmanaged', () => {
  assert.deepEqual(defaultResourceManagement(), { owner: '陈思远', usageType: 'long-term' });
  assert.deepEqual(defaultResourceManagement(' 张三 '), { owner: '张三', usageType: 'long-term' });
  assert.equal(validateResourceManagement(undefined), null);
  assert.equal(resourceDueStatus(undefined, '2026-09-16'), 'unmanaged');
  assert.equal(validateTopology(base(), initialExperiments), null);
  assert.ok([...defaultTopology.domains, ...defaultTopology.layers].every(node => !Object.hasOwn(node, 'management')));
});

test('resource metadata validates owner and usage type without silently accepting malformed values', () => {
  for (const value of [null, 7, 'owner', [], {}, { owner: '', usageType: 'long-term' }, { owner: '  ', usageType: 'temporary' }, { owner: 42, usageType: 'long-term' }, { owner: '张'.repeat(41), usageType: 'long-term' }, { owner: '张三', usageType: 'forever' }]) assert.ok(validateResourceManagement(value), JSON.stringify(value));
  assert.equal(validateResourceManagement({ owner: ' 张'.padEnd(41, '三') + ' ', usageType: 'long-term' }), null);
  assert.equal(validateResourceManagement({ owner: '张三', usageType: 'long-term' }), null);
});

test('temporary dates must be real calendar dates; past dates stay valid for reminders', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-04-30', '2001-01-01', '9999-12-31']) assert.equal(validateResourceManagement(temporary(date)), null, date);
  for (const date of [undefined, null, 20260916, '', '2026-2-03', '2026-02-30', '2026-04-31', '1900-02-29', '2026-00-01', '2026-13-01', '2026-01-00', '0000-01-01', '2026-09-16T00:00:00Z']) assert.ok(validateResourceManagement(temporary(date === undefined ? null : date)), String(date));
  assert.ok(validateResourceManagement({ owner: '张三', usageType: 'temporary' }));
  assert.ok(validateResourceManagement({ owner: '张三', usageType: 'long-term', expectedEndDate: '2026-09-16' }));
  assert.ok(validateResourceManagement({ owner: '张三', usageType: 'long-term', expectedEndDate: '' }));
});

test('date status compares local calendar days across month and year boundaries', () => {
  assert.equal(resourceDueStatus(defaultResourceManagement(), '2026-09-16'), 'long-term');
  assert.equal(resourceDueStatus(temporary('2026-12-31'), '2027-01-01'), 'overdue');
  assert.equal(resourceDueStatus(temporary('2026-09-16'), '2026-09-16'), 'due-today');
  assert.equal(resourceDueStatus(temporary('2026-10-01'), '2026-09-30'), 'scheduled');
  assert.equal(resourceDueStatus(temporary('2024-02-29'), '2024-03-01'), 'overdue');
  assert.equal(localDateString(new Date(2026, 8, 16, 23, 59, 59)), '2026-09-16');
  assert.equal(localDateString(new Date(2027, 0, 1, 0, 0, 1)), '2027-01-01');
  assert.throws(() => resourceDueStatus(temporary(), '2026-02-30'), RangeError);
});

test('topology validation rejects invalid metadata on either domains or layers without altering legacy records', () => {
  for (const kind of ['domains', 'layers']) {
    const topology = base(), before = JSON.stringify(topology);
    assert.equal(validateTopology(topology), null);
    topology[kind][1].management = temporary('2026-02-30');
    assert.match(validateTopology(topology), /预计结束日期/);
    delete topology[kind][1].management;
    assert.equal(JSON.stringify(topology), before);
  }
});

test('new parameter layers preserve management and reject invalid management before changing topology', () => {
  const topology = base(), before = structuredClone(topology), management = { ...temporary(), owner: ' 资源负责人 ' };
  const next = planned(planLayerCreation(layerInput({ management }), [], topology));
  assert.deepEqual(next.layers.find(layer => layer.id === 'resource-layer').management, temporary());
  next.layers.at(-1).management.owner = '返回副本';
  assert.equal(management.owner, ' 资源负责人 ');
  assert.deepEqual(topology, before);
  const bad = planLayerCreation(layerInput({ management: temporary('invalid') }), [], topology);
  assert.equal(bad.topology, null);
  assert.match(bad.error, /日期/);
  assert.equal(planned(planLayerCreation(layerInput(), [], topology)).layers.at(-1).management, undefined);
});

test('new layers with pending parameter assignments retain management through complete registration planning', () => {
  const registered = planned(planParameterRegistration({ key: 'pricing.resource_v22', name: '临时资源策略参数', type: 'number', defaultValue: 1, owner: '张三', description: '', serviceId: 'pricing-service', tagIds: [] }, [], base()));
  const input = layerInput({ parameterKeys: ['pricing.resource_v22'], management: temporary(), pendingSelections: { root: 'root-layer', overlap: 'resource-layer', exclusive: 'full' } });
  const next = planned(planLayerCreation(input, [], registered));
  assert.deepEqual(next.layers.at(-1).management, temporary());
  assert.deepEqual(layerScope('resource-layer', next), ['pricing.resource_v22']);
  assert.equal(next.pendingParameterKeys.includes('pricing.resource_v22'), false);
});

test('child domains copy creation metadata once into the initial layer without sharing references', () => {
  const topology = base(), before = structuredClone(topology), management = { ...temporary(), owner: ' 资源负责人 ' };
  const result = planChildDomainCreation(childInput({ management }), [], topology);
  assert.equal(result.ok, true, result.error);
  const domain = result.topology.domains.at(-1), layer = result.topology.layers.at(-1);
  assert.deepEqual(domain.management, temporary());
  assert.deepEqual(layer.management, temporary());
  domain.management.owner = '子域新负责人';
  assert.equal(layer.management.owner, '资源负责人');
  assert.equal(management.owner, ' 资源负责人 ');
  assert.deepEqual(topology, before);
  const invalid = planChildDomainCreation(childInput({ management: { owner: '', usageType: 'long-term' } }), [], topology);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /负责人/);
  const legacy = planChildDomainCreation(childInput(), [], topology);
  assert.equal(legacy.ok, true, legacy.error);
  assert.equal(legacy.topology.domains.at(-1).management, undefined);
  assert.equal(legacy.topology.layers.at(-1).management, undefined);
});

test('management edits update only the requested domain or layer and preserve every structural field', () => {
  for (const [kind, id, collection] of [['domain', 'overlap', 'domains'], ['layer', 'ranking', 'layers']]) {
    const topology = base(), before = structuredClone(topology), management = temporary();
    const next = planned(planResourceManagementUpdate(kind, id, management, topology));
    assert.deepEqual(next[collection].find(node => node.id === id).management, management);
    const withoutEdit = structuredClone(next);
    delete withoutEdit[collection].find(node => node.id === id).management;
    assert.deepEqual(withoutEdit, before);
    assert.deepEqual(topology, before);
    next[collection].find(node => node.id === id).management.owner = '后续修改';
    assert.equal(management.owner, '资源负责人');
    assert.equal(validateTopology(next, initialExperiments), null);
  }
});

test('editing a domain later does not rewrite metadata on its child layers', () => {
  const result = planChildDomainCreation(childInput({ management: temporary() }), [], base());
  assert.equal(result.ok, true, result.error);
  const next = planned(planResourceManagementUpdate('domain', 'resource-child', defaultResourceManagement('另一负责人'), result.topology));
  assert.deepEqual(next.domains.at(-1).management, defaultResourceManagement('另一负责人'));
  assert.deepEqual(next.layers.at(-1).management, temporary());
});

test('metadata update rejects missing resources and invalid payloads with no partial mutation', () => {
  const topology = base(), before = structuredClone(topology);
  for (const [kind, id, management] of [['domain', 'missing', temporary()], ['layer', 'overlap', temporary()], ['invalid', 'overlap', temporary()], ['domain', 'overlap', null], ['domain', 'overlap', undefined], ['domain', 'overlap', temporary('2026-02-30')]]) {
    const result = planResourceManagementUpdate(kind, id, management, topology);
    assert.equal(result.topology, null);
    assert.ok(result.error);
    assert.deepEqual(topology, before);
  }
});

test('overdue dates never change experiment eligibility, capacity, buckets, or deterministic assignments', () => {
  const topology = base();
  const next = planned(planResourceManagementUpdate('domain', 'overlap', temporary('2001-01-01'), topology));
  const updated = planned(planResourceManagementUpdate('layer', 'ranking', temporary('2001-01-01'), next));
  assert.equal(resourceDueStatus(updated.layers.find(layer => layer.id === 'ranking').management, '2026-09-16'), 'overdue');
  assert.deepEqual(layerAudienceCapacity('ranking', initialExperiments, updated), layerAudienceCapacity('ranking', initialExperiments, topology));
  for (const experiment of initialExperiments) assert.equal(validateAllocation(experiment, initialExperiments, updated), validateAllocation(experiment, initialExperiments, topology));
  for (let index = 0; index < 25; index++) {
    const user = `metadata-only-${index}`, before = simulateAllocation(user, initialExperiments, topology), after = simulateAllocation(user, initialExperiments, updated);
    assert.equal(before.error, undefined);
    const assignment = result => ({ ...result, domain: result.domain.id });
    assert.deepEqual(assignment(after), assignment(before));
  }
});

test('saveTopology persists management on both node types and rejects bad metadata without replacing current state', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const stored = new Map([['exp-lab-topology-v1', JSON.stringify(${JSON.stringify(defaultTopology)})]]);
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }, configurable: true });
    const { getTopology, saveTopology } = await import('./src/traffic.ts');
    const { initialExperiments } = await import('./src/data.ts');
    const { planResourceManagementUpdate } = await import('./src/resource-management.ts');
    assert.ok([...getTopology().domains, ...getTopology().layers].every(node => !Object.hasOwn(node, 'management')));
    const temporary = { owner: '资源负责人', usageType: 'temporary', expectedEndDate: '2001-01-01' };
    const permanent = { owner: '王五', usageType: 'long-term' };
    const domainEdit = planResourceManagementUpdate('domain', 'overlap', temporary, getTopology());
    assert.equal(domainEdit.error, null);
    const next = planResourceManagementUpdate('layer', 'ranking', permanent, domainEdit.topology);
    assert.equal(next.error, null);
    assert.equal(saveTopology(next.topology, initialExperiments), null);
    const persisted = JSON.parse(stored.get('exp-lab-topology-v1'));
    assert.deepEqual(persisted.domains.find(node => node.id === 'overlap').management, temporary);
    assert.deepEqual(persisted.layers.find(node => node.id === 'ranking').management, permanent);
    const before = structuredClone(getTopology()), raw = stored.get('exp-lab-topology-v1'), invalid = structuredClone(before);
    invalid.layers.find(node => node.id === 'ranking').management.owner = '';
    assert.match(saveTopology(invalid, initialExperiments), /负责人/);
    assert.deepEqual(getTopology(), before);
    assert.equal(stored.get('exp-lab-topology-v1'), raw);
    const reloaded = await import('./src/traffic.ts?resource-metadata-reload');
    assert.equal(reloaded.getTopologyLoadError(), null);
    assert.deepEqual(reloaded.getTopology().domains.find(node => node.id === 'overlap').management, temporary);
    assert.deepEqual(reloaded.getTopology().layers.find(node => node.id === 'ranking').management, permanent);
  `], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('stale owner edits cannot overwrite a newer topology with an added child domain', () => {
  isolatedStorageTest(`
    const before = structuredClone(traffic.getTopology()), edited = candidate();
    const { planChildDomainCreation } = await import('./src/child-domain-creation.ts');
    const newer = planChildDomainCreation({ id: 'other-tab-child', name: '其他页面新建的子域', parentLayerId: 'transaction', mode: 'overlapping', traffic: 10 }, [], before);
    assert.equal(newer.ok, true, newer.error);
    const newerRaw = JSON.stringify(newer.topology);
    stored.set('exp-lab-topology-v1', newerRaw);
    const count = writes;
    assert.match(traffic.saveTopology(edited, []), /其他页面更新.*当前填写内容仍保留/);
    assert.equal(stored.get('exp-lab-topology-v1'), newerRaw);
    assert.equal(writes, count);
    assert.deepEqual(traffic.getTopology(), before);
    assert.equal(edited.domains.find(node => node.id === 'overlap').management.owner, '资源负责人');
  `);
});

test('stale guard also catches removed keys and a new stored key after an initially empty load', () => {
  isolatedStorageTest(`
    const before = structuredClone(traffic.getTopology()), count = writes;
    stored.delete('exp-lab-topology-v1');
    assert.match(traffic.saveTopology(candidate(), []), /其他页面更新/);
    assert.equal(stored.has('exp-lab-topology-v1'), false);
    assert.equal(writes, count);
    assert.deepEqual(traffic.getTopology(), before);
  `);
  isolatedStorageTest(`
    const before = structuredClone(traffic.getTopology()), raw = JSON.stringify(before), count = writes;
    stored.set('exp-lab-topology-v1', raw);
    assert.match(traffic.saveTopology(candidate(), []), /其他页面更新/);
    assert.equal(stored.get('exp-lab-topology-v1'), raw);
    assert.equal(writes, count);
    assert.deepEqual(traffic.getTopology(), before);
  `, []);
});

test('failed storage reads or writes leave the snapshot and comparison base unchanged for a retry', () => {
  isolatedStorageTest(`
    const before = structuredClone(traffic.getTopology()), raw = stored.get('exp-lab-topology-v1');
    failRead = true;
    assert.match(traffic.saveTopology(candidate(), []), /存储失败/);
    failRead = false;
    assert.deepEqual(traffic.getTopology(), before);
    assert.equal(stored.get('exp-lab-topology-v1'), raw);
    failWrite = true;
    assert.match(traffic.saveTopology(candidate(), []), /存储失败/);
    failWrite = false;
    assert.deepEqual(traffic.getTopology(), before);
    assert.equal(stored.get('exp-lab-topology-v1'), raw);
    assert.equal(traffic.saveTopology(candidate(), []), null);
    const second = planResourceManagementUpdate('layer', 'ranking', { owner: '第二次修改', usageType: 'long-term' }, traffic.getTopology());
    assert.equal(traffic.saveTopology(second.topology, []), null);
    assert.equal(JSON.parse(stored.get('exp-lab-topology-v1')).layers.find(node => node.id === 'ranking').management.owner, '第二次修改');
  `);
});

test('comparison base follows successful catalog and legacy experiment migrations', () => {
  const catalog = getCatalog(defaultTopology);
  const legacy = { ...base(), catalog: { services: catalog.services, tags: [], bindings: catalog.bindings.map(binding => ({ key: binding.key, serviceId: binding.serviceId, tagIds: [] })) } };
  isolatedStorageTest(`
    assert.equal(writes, 1);
    assert.equal(JSON.parse(stored.get('exp-lab-topology-v1')).catalog.schemaVersion, 2);
    assert.equal(traffic.saveTopology(candidate(), []), null);
  `, [['exp-lab-topology-v1', JSON.stringify(legacy)]]);
  isolatedStorageTest(`
    assert.equal(writes, 1);
    assert.ok(stored.get('exp-lab-topology-v1'));
    assert.equal(traffic.saveTopology(candidate(), []), null);
  `, [['exp-lab-experiments-v1', JSON.stringify(initialExperiments)]]);
});

test('saveTopology still supports an environment without browser storage', () => {
  isolatedStorageTest(`
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    assert.equal(traffic.saveTopology(candidate(), []), null);
    assert.equal(traffic.getTopology().domains.find(node => node.id === 'overlap').management.owner, '资源负责人');
  `, []);
});
