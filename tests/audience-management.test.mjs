import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceAttributeKeys, audienceUsage, profileAttributeUsage, parseAudienceRoute } from '../src/audience-management.ts';

const leaf = (field, value) => ({kind:'rule',rule:{field,op:'eq',value}});
const custom = {id:'custom-v1',familyId:'custom',version:1,name:'嵌套客户',owner:'产品组',description:'',createdAt:'2026-09-12T00:00:00Z',rules:[],expression:{kind:'group',operator:'or',children:[leaf('country','CN'),{kind:'group',operator:'and',children:[leaf('customer.tier','gold'),leaf('country','US')]}]}};
const unrelated = {...custom,id:'unrelated-v1',familyId:'unrelated',name:'近似名称',expression:leaf('customer.tier_extra','gold')};
const topology = {
  audiences:[custom,unrelated],
  domains:[{id:'root',parentLayerId:null},{id:'cn',parentLayerId:'root-layer',audienceId:'custom-v1'},{id:'grandchild',parentLayerId:'cn-layer'},{id:'other',parentLayerId:'root-layer'}],
  layers:[{id:'root-layer',domainId:'root'},{id:'cn-layer',domainId:'cn'},{id:'grand-layer',domainId:'grandchild'},{id:'other-layer',domainId:'other'}],
};
const experiments = [{id:'inherited',domainId:'grandchild',audience:'',parameterKeys:[]},{id:'direct',domainId:'other',audienceId:'custom-v1',parameterKeys:[]},{id:'parameter-only',domainId:'other',parameterKeys:['customer.tier']}];

test('attribute references traverse every OR branch and deduplicate repeated exact fields', () => {
  assert.deepEqual(audienceAttributeKeys(custom), ['country','customer.tier']);
  assert.deepEqual(audienceAttributeKeys({...custom,expression:undefined,rules:[{field:'is_member',op:'eq',value:true}]}), ['is_member']);
});

test('attribute impact includes inherited domains and experiments without treating experiment parameters as profile attributes', () => {
  const usage = profileAttributeUsage('customer.tier',topology,experiments);
  assert.deepEqual(usage.audiences.map(a=>a.id),['custom-v1']);
  assert.deepEqual(usage.domains.map(d=>d.id),['cn','grandchild']);
  assert.deepEqual(usage.experiments.map(e=>e.id),['inherited','direct']);
  assert.equal(profileAttributeUsage('customer',topology,experiments).audiences.length,0);
});

test('audience impact separates direct domain references from inherited references', () => {
  const usage=audienceUsage('custom-v1',topology,experiments);
  assert.deepEqual(usage.directDomains.map(d=>d.id),['cn']);
  assert.deepEqual(usage.domains.map(d=>d.id),['cn','grandchild']);
  assert.deepEqual(usage.experiments.map(e=>e.id),['inherited','direct']);
});

test('audience routes preserve encoded identity and reject malformed or extra segments', () => {
  assert.deepEqual(parseAudienceRoute('#audiences'),{tab:'audiences',id:null,invalid:false});
  assert.deepEqual(parseAudienceRoute('#audiences/attributes'),{tab:'attributes',id:null,invalid:false});
  assert.deepEqual(parseAudienceRoute('#audiences/attributes/customer.tier'),{tab:'attributes',id:'customer.tier',invalid:false});
  assert.deepEqual(parseAudienceRoute('#audiences/custom%2Fversion'),{tab:'audiences',id:'custom/version',invalid:false});
  assert.equal(parseAudienceRoute('#audiences/%ZZ').invalid,true);
  assert.equal(parseAudienceRoute('#audiences/attributes/key/extra').invalid,true);
});
