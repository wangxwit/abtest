import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTopology, simulateAllocation, validateTopology } from '../src/traffic.ts';
import { initialExperiments } from '../src/data.ts';

let implementation;
try { implementation = await import('../src/traffic-validation.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
function api() { assert.ok(implementation, 'Traffic validation routes and focus explanation are not implemented yet'); return implementation; }

function base() {
  const topology = structuredClone(defaultTopology);
  topology.domains = topology.domains.filter(domain => ['root', 'overlap'].includes(domain.id));
  Object.assign(topology.domains[1], { start: 0, traffic: 100 });
  topology.layers = topology.layers.filter(layer => ['root-layer', 'presentation', 'ranking', 'transaction'].includes(layer.id));
  return topology;
}
function addChild(topology, id, changes = {}) {
  topology.domains.push({ id, name: id, parentLayerId: 'presentation', mode: 'overlapping', start: 0, traffic: 100, unit: 'user_id', description: '', ...changes });
  topology.layers.push({ id: `${id}-layer`, name: `${id}参数层`, domainId: id, parameterKeys: ['*'], description: '' });
  return topology;
}
function simulate(topology, profile = {}, experiments = []) {
  assert.equal(validateTopology(topology, experiments), null);
  const result = simulateAllocation('focus-fixture-user', experiments, topology, profile);
  assert.equal(result.error, undefined);
  return result;
}
const focus = (kind, id) => ({ kind, id });

test('validation routes encode one optional focus and keep the root simulation address distinct', () => {
  const { trafficValidationHref, parseTrafficValidationRoute } = api();
  for (const value of [undefined, null]) assert.equal(trafficValidationHref(value), '#traffic/validation');
  const selected = focus('layer', '排序 / A?x&=%');
  const href = trafficValidationHref(selected);
  assert.equal(href, '#traffic/validation/layer/%E6%8E%92%E5%BA%8F%20%2F%20A%3Fx%26%3D%25');
  assert.deepEqual(parseTrafficValidationRoute(href), { isValidation: true, focus: selected, error: null });
  assert.deepEqual(parseTrafficValidationRoute('#traffic/validation/domain/root'), { isValidation: true, focus: focus('domain', 'root'), error: null });
  assert.deepEqual(parseTrafficValidationRoute('traffic/validation'), { isValidation: true, focus: null, error: null });
  assert.deepEqual(parseTrafficValidationRoute('#traffic/validation?'), { isValidation: true, focus: null, error: null });
});

test('ordinary traffic routes and old audience-reference links are not consumed as validation', () => {
  const { parseTrafficValidationRoute } = api();
  for (const hash of ['#traffic', '#traffic/domain/overlap', '#traffic/layer/ranking?audience=new-users-v1&focus=audience', '#traffic/validation-tools', '#experiments/validation']) {
    assert.deepEqual(parseTrafficValidationRoute(hash), { isValidation: false, focus: null, error: null }, hash);
  }
});

test('malformed validation paths and any nonempty query are explicit errors without a substitute target', () => {
  const { parseTrafficValidationRoute } = api();
  for (const hash of [
    '#traffic/validation/', '#traffic/validation/domain', '#traffic/validation/layer/',
    '#traffic/validation/domain/%20', '#traffic/validation/layer/%20ranking', '#traffic/validation/layer/ranking%20',
    '#traffic/validation/domain/%ZZ', '#traffic/validation/domain/%E0%A4%A',
    '#traffic/validation/experiment/EXP-1', '#traffic/validation/domain/root/extra', '#traffic/validation/domain/root/',
    '#traffic/validation?focus=ranking', '#traffic/validation/domain/root?audience=new-users-v1', '#traffic/validation??',
  ]) {
    const result = parseTrafficValidationRoute(hash);
    assert.equal(result.isValidation, true, hash);
    assert.equal(result.focus, null, hash);
    assert.ok(result.error, hash);
  }
});

test('an unknown but well-encoded focus stays selected until topology lookup reports missing', () => {
  const { parseTrafficValidationRoute, explainTrafficFocus } = api();
  const selected = focus('layer', 'unknown-layer');
  const route = parseTrafficValidationRoute('#traffic/validation/layer/unknown-layer');
  assert.deepEqual(route, { isValidation: true, focus: selected, error: null });
  const topology = base(), result = simulate(topology);
  const explained = explainTrafficFocus(selected, result, topology);
  assert.equal(explained.status, 'missing');
  assert.equal(explained.nodeName, 'unknown-layer');
  assert.match(explained.reason, /不存在|未找到/);
  assert.equal(explained.blocker, undefined);
});

test('focus explanation keeps the full root result including independent parallel experiments unchanged', () => {
  const { explainTrafficFocus } = api();
  const topology = addChild(base(), 'target-child');
  const source = structuredClone(initialExperiments.find(experiment => experiment.layerId === 'ranking' && experiment.status === 'running'));
  const experiment = { ...source, id: 'parallel-ranking', name: '并行排序实验', traffic: 100, bucketStart: 0, audience: '全部活跃用户' };
  delete experiment.audienceId;
  const result = simulate(topology, {}, [experiment]);
  assert.equal(result.enteredDomains[0], 'root');
  assert.ok(result.decisions.some(decision => decision.experimentId === experiment.id));
  const before = JSON.stringify({ topology, result, experiment });
  const explained = explainTrafficFocus(focus('layer', 'target-child-layer'), result, topology);
  assert.equal(explained.status, 'reached');
  assert.equal(explained.nodeName, 'target-child参数层');
  assert.match(explained.reason, /到达/);
  assert.match(explained.reason, /不代表.*命中|不等于.*命中/);
  assert.equal(JSON.stringify({ topology, result, experiment }), before);
});

test('visiting a layer without an experiment is reached and no experiment or visited-ID collision can fake it', () => {
  const { explainTrafficFocus } = api();
  const topology = base(), result = simulate(topology);
  assert.equal(result.decisions.find(decision => decision.layerId === 'ranking').experimentId, null);
  assert.equal(explainTrafficFocus(focus('layer', 'ranking'), result, topology).status, 'reached');
  const missingLayerTrace = structuredClone(result);
  missingLayerTrace.trace = missingLayerTrace.trace.filter(step => !(step.kind === 'layer' && step.id === 'ranking'));
  missingLayerTrace.trace.push({ kind: 'experiment', id: 'ranking', name: 'Same identifier, wrong kind', domainId: 'overlap', depth: 1, reason: 'not a layer visit' });
  const explained = explainTrafficFocus(focus('layer', 'ranking'), missingLayerTrace, topology);
  assert.equal(explained.status, 'not-reached');
  assert.deepEqual(explained.blocker, focus('layer', 'ranking'));
  assert.match(explained.reason, /轨迹|记录/);
});

test('the first excluded ancestor explains a deeper focus with an exact outside-bucket cause', () => {
  const { explainTrafficFocus } = api();
  const topology = base(), baseline = simulate(topology);
  const bucket = baseline.decisions.find(decision => decision.layerId === 'presentation').bucket;
  addChild(topology, 'outside-parent', { start: bucket < 50 ? 50 : 0, traffic: 20 });
  addChild(topology, 'deep-target', { parentLayerId: 'outside-parent-layer' });
  const result = simulate(topology);
  const explained = explainTrafficFocus(focus('layer', 'deep-target-layer'), result, topology);
  assert.equal(explained.status, 'not-reached');
  assert.equal(explained.nodeName, 'deep-target参数层');
  assert.deepEqual(explained.blocker, focus('domain', 'outside-parent'));
  assert.match(explained.reason, /outside-parent/);
  assert.match(explained.reason, /桶.*外/);
  assert.ok(explained.reason.includes(String(bucket)));
  assert.doesNotMatch(explained.reason, /画像不匹配|资格未知/);
});

test('root eligibility rejection is attributed to root and preserves the actual engine reason', () => {
  const { explainTrafficFocus } = api();
  const topology = base();
  topology.domains[0].audienceId = 'new-users-v1';
  for (const profile of [{}, { registration_days: 30 }]) {
    const result = simulate(topology, profile);
    assert.deepEqual(result.enteredDomains, []);
    const reason = result.trace.find(step => step.id === 'audience-root').reason;
    const explained = explainTrafficFocus(focus('layer', 'ranking'), result, topology);
    assert.equal(explained.status, 'not-reached');
    assert.deepEqual(explained.blocker, focus('domain', 'root'));
    assert.ok(explained.reason.includes(reason));
  }
});

test('same-bucket unknown audiences reuse recorded candidate reasons without rerouting or inventing a match', () => {
  const { explainTrafficFocus } = api();
  const topology = addChild(addChild(base(), 'new-child', { audienceId: 'new-users-v1' }), 'old-child', { audienceId: 'returning-users-v1' });
  const result = simulate(topology);
  const parentDecision = result.decisions.find(decision => decision.layerId === 'presentation');
  assert.equal(parentDecision.audienceStatus, 'unknown');
  assert.equal(parentDecision.childDomainId, null);
  const explained = explainTrafficFocus(focus('layer', 'new-child-layer'), result, topology);
  assert.equal(explained.status, 'not-reached');
  assert.deepEqual(explained.blocker, focus('domain', 'new-child'));
  assert.match(explained.reason, /同桶/);
  assert.ok(explained.reason.includes(parentDecision.reason));
  assert.match(explained.reason, /未知/);
  assert.ok(result.trace.some(step => step.kind === 'layer' && step.id === 'transaction'));
});

test('another matched same-bucket branch does not make the focused domain matched', () => {
  const { explainTrafficFocus } = api();
  const topology = addChild(addChild(base(), 'new-child', { audienceId: 'new-users-v1' }), 'old-child', { audienceId: 'returning-users-v1' });
  const result = simulate(topology, { registration_days: 30 });
  const parentDecision = result.decisions.find(decision => decision.layerId === 'presentation');
  assert.equal(parentDecision.childDomainId, 'old-child');
  assert.equal(parentDecision.audienceStatus, 'match');
  const parentTrace = result.trace.find(step => step.kind === 'layer' && step.id === 'presentation');
  const explained = explainTrafficFocus(focus('domain', 'new-child'), result, topology);
  assert.equal(explained.status, 'not-reached');
  assert.deepEqual(explained.blocker, focus('domain', 'new-child'));
  assert.ok(explained.reason.includes(parentTrace.reason));
  assert.match(explained.reason, /new-child.*不匹配/);
});

test('empty layers are skipped with an explicit pending-configuration explanation', () => {
  const { explainTrafficFocus } = api();
  const topology = base();
  topology.layers.push({ id: 'empty-layer', name: '待配置参数层', domainId: 'overlap', parameterKeys: [], description: '' });
  const result = simulate(topology);
  const explained = explainTrafficFocus(focus('layer', 'empty-layer'), result, topology);
  assert.equal(explained.status, 'not-reached');
  assert.deepEqual(explained.blocker, focus('layer', 'empty-layer'));
  assert.match(explained.reason, /待配置|空参数/);
  assert.match(explained.reason, /跳过|不参与/);
});

test('simulation errors take priority over partial reached traces and even a missing focus', () => {
  const { explainTrafficFocus } = api();
  const topology = base(), result = simulate(topology);
  result.error = '同桶出现多个符合受众的候选，已拒绝分配。';
  for (const selected of [focus('layer', 'ranking'), focus('domain', 'unknown')]) {
    const explained = explainTrafficFocus(selected, result, topology);
    assert.equal(explained.status, 'error');
    assert.ok(explained.reason.includes(result.error));
    assert.match(explained.title, /未完成|失败/);
  }
});

test('absent parent decisions produce a record-limited explanation rather than a fabricated audience verdict', () => {
  const { explainTrafficFocus } = api();
  const topology = addChild(base(), 'unexplained-child', { traffic: 1 });
  const result = simulate(topology);
  const incomplete = structuredClone(result);
  incomplete.trace = incomplete.trace.filter(step => !['unexplained-child', 'unexplained-child-layer'].includes(step.id));
  incomplete.decisions = incomplete.decisions.filter(decision => decision.layerId !== 'presentation');
  const before = JSON.stringify({ topology, incomplete });
  const explained = explainTrafficFocus(focus('domain', 'unexplained-child'), incomplete, topology);
  assert.equal(explained.status, 'not-reached');
  assert.match(explained.reason, /记录|无法确认/);
  assert.doesNotMatch(explained.reason, /受众不匹配|受众未知|桶.*外/);
  assert.equal(JSON.stringify({ topology, incomplete }), before);
});


test('focus explanation treats an unallocated bucket between domain segments as outside', () => {
  const {explainTrafficFocus}=api();
  const topology=base();
  const baseline=simulate(topology);
  const bucket=Math.round(baseline.decisions.find(item=>item.layerId==='presentation').bucket*100);
  assert.ok(bucket>0&&bucket<9999);
  addChild(topology,'gap-domain',{start:0,traffic:99.99,bucketRanges:[{start:0,end:bucket},{start:bucket+1,end:10000}]});
  const result=simulate(topology);
  assert.ok(!result.enteredDomains.includes('gap-domain'));
  const explanation=explainTrafficFocus(focus('domain','gap-domain'),result,topology);
  assert.equal(explanation.status,'not-reached');
  assert.match(explanation.reason,/实际桶段.*外/);
  assert.ok(explanation.reason.includes(`#${bucket}`));
  assert.doesNotMatch(explanation.reason,/同桶候选判定没有选择/);
});

test('focus explanation checks a later segment before explaining an unknown audience', () => {
  const {explainTrafficFocus}=api();
  const topology=base();
  const baseline=simulate(topology);
  const bucket=Math.round(baseline.decisions.find(item=>item.layerId==='presentation').bucket*100);
  assert.ok(bucket>1);
  addChild(topology,'later-segment-domain',{start:0,traffic:0.02,audienceId:'new-users-v1',bucketRanges:[{start:0,end:1},{start:bucket,end:bucket+1}]});
  const result=simulate(topology);
  const explanation=explainTrafficFocus(focus('domain','later-segment-domain'),result,topology);
  assert.equal(explanation.status,'not-reached');
  assert.match(explanation.reason,/实际桶段.*内/);
  assert.match(explanation.reason,/同桶候选|未知/);
  assert.ok(explanation.reason.includes(`#${bucket}`));
});
