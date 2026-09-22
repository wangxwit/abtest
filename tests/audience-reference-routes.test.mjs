import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../src/audience-reference-routes.ts').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return null; throw error; });
const api = () => { assert.ok(module, 'Audience reference navigation is not implemented yet'); return module; };
const leaf = (field, value) => ({ kind: 'rule', rule: { field, op: 'eq', value } });
const audience = (id, expression) => ({ id, familyId: id, name: id, owner: '产品组', version: 1, description: '', createdAt: '2026-09-12T00:00:00Z', rules: [], expression });
const china = audience('china-v1', leaf('country', 'CN'));
const tiers = audience('tiers-v1', { kind: 'group', operator: 'or', children: [leaf('customer.tier', 'gold'), { kind: 'group', operator: 'and', children: [leaf('country', 'US'), leaf('customer.tier', 'silver')] }] });
const other = audience('other-v1', leaf('is_member', true));
const t = {
  domains: [{ id:'root', name:'根域', parentLayerId:null }, { id:'china', name:'中国域', parentLayerId:'root-layer', audienceId:'china-v1' }, { id:'child', name:'子域', parentLayerId:'china-layer', audienceId:'tiers-v1' }, { id:'other', name:'其他域', parentLayerId:'root-layer' }],
  layers: [{id:'root-layer',domainId:'root'},{id:'china-layer',domainId:'china'},{id:'child-layer',domainId:'child'},{id:'other-layer',domainId:'other'}],
  audiences:[china,tiers,other],
  profileAttributes:[{key:'customer.tier',label:'客户等级',type:'enum',values:['gold','silver'],serviceId:'checkout-service',description:'首次入组等级',createdAt:'2026-09-12T00:00:00Z'}],
};
const exps = [
 { id:'exp-inherit',domainId:'child',audience:'',parameterKeys:[] },
 { id:'exp-direct',domainId:'other',audienceId:'tiers-v1',parameterKeys:[] },
 { id:'exp-both',domainId:'child',audienceId:'tiers-v1',parameterKeys:[] },
 { id:'parameter-only',domainId:'other',audience:'',parameterKeys:['customer.tier'] },
];

test('reference links preserve encoded targets and source identity without adding a filter', () => {
 const {audienceReferenceHref,parseAudienceReferenceContext,parseExperimentDestination,parseTrafficDestination}=api();
 const exp=audienceReferenceHref('experiment','exp/汉?%',{audienceId:'受众 v1&x'});
 assert.equal(exp,'#experiments/exp%2F%E6%B1%89%3F%25?audience=%E5%8F%97%E4%BC%97%20v1%26x&focus=audience');
 assert.deepEqual(parseExperimentDestination(exp),{id:'exp/汉?%',error:null});
 assert.deepEqual(parseAudienceReferenceContext(exp),{kind:'audience',audienceId:'受众 v1&x'});
 const domain=audienceReferenceHref('domain','domain/one',{attributeKey:'customer.tier'});
 assert.equal(domain,'#traffic/domain/domain%2Fone?attribute=customer.tier&focus=audience');
 assert.deepEqual(parseTrafficDestination(domain),{kind:'domain',id:'domain/one',error:null});
 assert.deepEqual(parseAudienceReferenceContext(domain),{kind:'attribute',attributeKey:'customer.tier'});
});

test('ordinary routes remain compatible while malformed explicit destinations never fall back to a real object', () => {
 const {audienceReferenceHref,parseAudienceReferenceContext,parseExperimentDestination,parseTrafficDestination}=api();
 assert.equal(audienceReferenceHref('experiment','EXP-1',{}),'#experiments/EXP-1');
 assert.deepEqual(parseAudienceReferenceContext('#experiments/EXP-1'),{kind:'none'});
 assert.deepEqual(parseExperimentDestination('#experiments'),{id:null,error:null});
 assert.deepEqual(parseTrafficDestination('#traffic'),{kind:null,id:null,error:null});
 assert.deepEqual(parseTrafficDestination('#traffic/layer/ranking'),{kind:'layer',id:'ranking',error:null});
 for(const hash of ['#experiments/%ZZ','#experiments/id/extra','#experiments/'])assert.ok(parseExperimentDestination(hash).error,hash);
 for(const hash of ['#traffic/domain/%ZZ','#traffic/domain/id/extra','#traffic/wrong/id','#traffic/domain/'])assert.ok(parseTrafficDestination(hash).error,hash);
});

test('duplicate, mixed, malformed and unrelated query parameters cannot be interpreted as a verified source', () => {
 const {parseAudienceReferenceContext}=api();
 for(const query of ['audience=x&audience=y&focus=audience','audience=x&attribute=country&focus=audience','audience=&focus=audience','audience=%ZZ&focus=audience','audience=x&focus=parameters','focus=audience','audience=x&focus=audience&status=running','attribute=country&focus=audience&focus=audience','audience=x']) {
  assert.equal(parseAudienceReferenceContext(`#experiments/id?${query}`).kind,'invalid',query);
 }
});

test('audience context resolves exact immutable versions and distinguishes direct, inherited and both references', () => {
 const {resolveAudienceReference}=api();
 const direct=resolveAudienceReference('experiment','exp-direct',{kind:'audience',audienceId:'tiers-v1'},t,exps);
 assert.equal(direct.status,'matched');assert.equal(direct.relation,'direct');assert.equal(direct.references[0].audience.id,'tiers-v1');
 const inherited=resolveAudienceReference('experiment','exp-inherit',{kind:'audience',audienceId:'china-v1'},t,exps);
 assert.equal(inherited.status,'matched');assert.equal(inherited.relation,'inherited');assert.equal(inherited.references[0].domainId,'china');
 const both=resolveAudienceReference('experiment','exp-both',{kind:'audience',audienceId:'tiers-v1'},t,exps);
 assert.equal(both.relation,'both');assert.equal(both.references.length,2);
 const domain=resolveAudienceReference('domain','child',{kind:'audience',audienceId:'tiers-v1'},t,exps);
 assert.equal(domain.relation,'direct');
 assert.equal(resolveAudienceReference('domain','child',{kind:'audience',audienceId:'china-v1'},t,exps).relation,'inherited');
});

test('attribute navigation traverses every OR branch but never treats same-named experiment parameters as profile references', () => {
 const {resolveAudienceReference}=api();
 const context={kind:'attribute',attributeKey:'customer.tier'};
 const result=resolveAudienceReference('experiment','exp-inherit',context,t,exps);
 assert.equal(result.status,'matched');assert.equal(result.relation,'inherited');
 assert.equal(result.references.length,1);assert.equal(result.references[0].rules.length,2);
 assert.deepEqual(result.references[0].rules.map(rule=>rule.value),['gold','silver']);
 assert.match(result.references[0].expression,/OR/);assert.match(result.references[0].expression,/AND/);
 assert.match(result.effectiveCondition,/CN/);
 assert.equal(resolveAudienceReference('experiment','parameter-only',context,t,exps).status,'unrelated');
});

test('missing sources and targets or unrelated valid sources preserve the original objects without claiming a match', () => {
 const {resolveAudienceReference}=api();const before=JSON.stringify({t,exps});
 assert.equal(resolveAudienceReference('experiment','missing',{kind:'audience',audienceId:'china-v1'},t,exps).status,'missing-target');
 assert.equal(resolveAudienceReference('domain','missing',{kind:'audience',audienceId:'china-v1'},t,exps).status,'missing-target');
 assert.equal(resolveAudienceReference('experiment','exp-inherit',{kind:'audience',audienceId:'china-v2'},t,exps).status,'missing-source');
 assert.equal(resolveAudienceReference('experiment','exp-inherit',{kind:'attribute',attributeKey:'customer'},t,exps).status,'missing-source');
 assert.equal(resolveAudienceReference('experiment','exp-inherit',{kind:'audience',audienceId:'other-v1'},t,exps).status,'unrelated');
 assert.equal(JSON.stringify({t,exps}),before);
});

test('legacy named built-in audiences retain their exact compatibility reference', () => {
 const {resolveAudienceReference}=api();
 const legacy=[{id:'legacy',domainId:'other',audience:'新注册用户',parameterKeys:[]}];
 const result=resolveAudienceReference('experiment','legacy',{kind:'audience',audienceId:'new-users-v1'},{...t,audiences:undefined},legacy);
 assert.equal(result.status,'matched');assert.equal(result.relation,'direct');assert.equal(result.references[0].legacy,true);
});
