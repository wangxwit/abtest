import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { defaultTopology, parameterKeys, validateTopology, simulateAllocation } from '../src/traffic.ts';
import { initialExperiments } from '../src/data.ts';
import { defaultProfileAttributes, getProfileAttributes, getProfileAttribute, planProfileAttributeRegistration, profileValueIsValid } from '../src/profile-attributes.ts';
import { audienceCondition, evaluateAudience, planAudienceRegistration } from '../src/audiences.ts';
const base = () => structuredClone(defaultTopology);
const attribute = (changes = {}) => ({ key: 'lifetime_orders', label: '历史下单数', type: 'number', integer: true, unit: '单', description: '固定入组画像', serviceId: 'checkout-service', ...changes });
function ok(plan) { assert.equal(plan.error, null); assert.ok(plan.topology); return plan.topology; }
function browserProcess(script, input = {}) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs'; const input = JSON.parse(readFileSync(0, 'utf8'));
    const values = new Map(Object.entries(input.entries ?? {})); let failStorage = false;
    Object.defineProperty(globalThis,'localStorage',{value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>{if(failStorage)throw new Error('Quota');values.set(key,value)}},configurable:true});
    const traffic = await import('./src/traffic.ts'); ${script}
  `], { cwd: new URL('..', import.meta.url), input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}

test('profile attributes register independently and never enter the experiment parameter registry', () => {
  const t = base(), before = structuredClone(t), next = ok(planProfileAttributeRegistration(attribute(), t));
  assert.equal(Object.hasOwn(getProfileAttribute('lifetime_orders', next), 'serviceId'), false);
  assert.equal(getProfileAttribute('lifetime_orders', next).integer, true);
  assert.deepEqual(parameterKeys(next), parameterKeys(t));
  assert.deepEqual(next.layers, t.layers);
  assert.deepEqual(t, before);
  assert.equal(validateTopology(next), null);
  for (const changes of [{ description: '  ' }, { key: 'country' }, { key: '__proto__' }, { key: 'constructor' }, { key: 'app.prototype' }, { type: 'enum', values: [] }, { type: 'enum', values: ['gold', 'gold'] }, { type: 'string', values: ['gold'] }]) assert.equal(planProfileAttributeRegistration(attribute(changes), t).topology, null);
});

test('custom enum, number, boolean and string fields execute with their own schema and own-property values only', () => {
  let t = ok(planProfileAttributeRegistration(attribute(), base()));
  for (const definition of [attribute({ key: 'tier', label: '等级', type: 'enum', values: ['gold', 'silver'], integer: undefined, unit: undefined }), attribute({ key: 'is_eligible', type: 'boolean', integer: undefined, unit: undefined }), attribute({ key: 'region_code', type: 'string', integer: undefined, unit: undefined })]) t = ok(planProfileAttributeRegistration(definition, t));
  const expression = { kind: 'group', operator: 'and', children: [['lifetime_orders', 'gte', 2], ['tier', 'in', ['gold']], ['is_eligible', 'eq', true], ['region_code', 'eq', 'zone-a']].map(([field,op,value]) => ({ kind:'rule',rule:{field,op,value} })) };
  const condition = audienceCondition({ rules: [], expression }, t);
  assert.equal(evaluateAudience(condition, { lifetime_orders: 2, tier: 'gold', is_eligible: true, region_code: 'zone-a' }).status, 'match');
  assert.equal(evaluateAudience(condition, { lifetime_orders: 2.5, tier: 'gold', is_eligible: true, region_code: 'zone-a' }).status, 'unknown');
  assert.equal(evaluateAudience(condition, Object.create({ lifetime_orders: 2, tier: 'gold', is_eligible: true, region_code: 'zone-a' })).status, 'unknown');
  const invalid = planAudienceRegistration({ id:'unknown-enum',name:'未知等级',owner:'增长组',description:'',version:1,rules:[{field:'tier',op:'eq',value:'platinum'}] }, t);
  assert.equal(invalid.topology, null);
});

test('attribute definitions and historical metadata persist atomically and cannot be changed, deleted or omitted', () => {
  const t = ok(planProfileAttributeRegistration(attribute(), base()));
  const saved = browserProcess(`const error=traffic.saveTopology(input.topology,[]);process.stdout.write(JSON.stringify({error,topology:traffic.getTopology(),entries:Object.fromEntries(values)}));`, { topology:t });
  assert.equal(saved.error,null);
  const result = browserProcess(`
    const before=structuredClone(traffic.getTopology()), bytes=values.get('exp-lab-topology-v1'); let notifications=0;traffic.subscribeTopology(()=>notifications++);
    const variants=['type','source','remove','omit'].map(kind=>{const next=structuredClone(before);const attr=next.profileAttributes.find(item=>item.key==='lifetime_orders');if(kind==='type'){attr.type='string';delete attr.integer;delete attr.unit}if(kind==='source')attr.serviceId='ranking-service';if(kind==='remove')next.profileAttributes=next.profileAttributes.filter(item=>item.key!=='lifetime_orders');if(kind==='omit')delete next.profileAttributes;return next});
    const errors=variants.map(next=>traffic.saveTopology(next,[]));process.stdout.write(JSON.stringify({errors,before,after:traffic.getTopology(),bytes,stored:values.get('exp-lab-topology-v1'),notifications}));
  `, { entries:saved.entries });
  assert.ok(result.errors.every(Boolean));assert.deepEqual(result.before,result.after);assert.equal(result.bytes,result.stored);assert.equal(result.notifications,0);
  const failed = browserProcess(`const before=structuredClone(traffic.getTopology());let notifications=0;traffic.subscribeTopology(()=>notifications++);failStorage=true;const error=traffic.saveTopology(input.topology,[]);process.stdout.write(JSON.stringify({error,before,after:traffic.getTopology(),notifications}));`, { topology:t });
  assert.match(failed.error,/存储失败/);assert.deepEqual(failed.before,failed.after);assert.equal(failed.notifications,0);
});

test('legacy snapshots hydrate built-in attribute metadata without rewriting the topology or old audience bytes', () => {
  assert.deepEqual(getProfileAttributes(base()),defaultProfileAttributes);
  const result=browserProcess(`process.stdout.write(JSON.stringify({topology:traffic.getTopology(),error:traffic.getTopologyLoadError(),stored:values.get('exp-lab-topology-v1')}));`,{entries:{'exp-lab-topology-v1':JSON.stringify(defaultTopology)}});
  assert.equal(result.error,null);assert.deepEqual(result.topology,defaultTopology);assert.equal(result.stored,JSON.stringify(defaultTopology));
});

test('new profile attributes register without an application and do not write an application binding', () => {
  const { serviceId, ...input } = attribute();
  const next = ok(planProfileAttributeRegistration(input, base()));
  assert.equal(Object.hasOwn(getProfileAttribute(input.key, next), 'serviceId'), false);
  const compatibility = ok(planProfileAttributeRegistration(attribute({ serviceId: 'removed-application' }), base()));
  assert.equal(Object.hasOwn(getProfileAttribute(input.key, compatibility), 'serviceId'), false, 'Old callers may pass a stale source but it no longer creates a binding');
  for (let index = 0; index < 30; index++) assert.deepEqual(simulateAllocation(`source-free_${index}`, initialExperiments, next), simulateAllocation(`source-free_${index}`, initialExperiments, defaultTopology));
});

test('historical application metadata survives reload even when that application is absent', () => {
  const t = ok(planProfileAttributeRegistration(attribute(), base()));
  getProfileAttribute('lifetime_orders', t).serviceId = 'retired-source-application';
  assert.equal(validateTopology(t), null);
  const bytes = JSON.stringify(t);
  const result = browserProcess(`process.stdout.write(JSON.stringify({topology:traffic.getTopology(),error:traffic.getTopologyLoadError(),stored:values.get('exp-lab-topology-v1')}));`, { entries: { 'exp-lab-topology-v1': bytes } });
  assert.equal(result.error, null);
  assert.deepEqual(result.topology, t);
  assert.equal(result.stored, bytes);
});

test('custom enums remain closed with absent or null legacy source while built-in open enums retain old values', () => {
  const custom = { key: 'customer_tier', label: '客户等级', type: 'enum', values: ['gold', 'silver'], description: '固定客户等级', createdAt: new Date().toISOString() };
  for (const candidate of [custom, { ...custom, serviceId: null }, { ...custom, serviceId: 'retired-app' }]) {
    assert.equal(profileValueIsValid(candidate, 'gold'), true);
    assert.equal(profileValueIsValid(candidate, 'platinum'), false);
  }
  assert.equal(profileValueIsValid(getProfileAttribute('country', base()), 'DE'), true);
  assert.equal(profileValueIsValid(getProfileAttribute('platform', base()), 'Desktop'), true);
  const { createdAt, ...input } = custom;
  const t = ok(planProfileAttributeRegistration(input, base()));
  const condition = audienceCondition({ rules: [{ field: 'customer_tier', op: 'eq', value: 'gold' }] }, t);
  assert.equal(evaluateAudience(condition, { customer_tier: 'platinum' }).status, 'unknown');
  assert.equal(planAudienceRegistration({ id: 'bad-tier', name: '非法等级', owner: '增长组', version: 1, description: '', rules: [{ field: 'customer_tier', op: 'eq', value: 'platinum' }] }, t).topology, null);
});
