import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraftForm, draftParameterKeys } from '../src/experiment-draft-validation.ts';
import { defaultTopology, validateTopology } from '../src/traffic.ts';
import { getCatalog } from '../src/service-catalog.ts';
import { initialExperiments } from '../src/data.ts';

const topology = () => structuredClone(defaultTopology);
const group = (id, role, weight, value = { 'ranking.model': id }) => ({ id, name: id, role, weight, value: typeof value === 'string' ? value : JSON.stringify(value) });
function draft(changes = {}) {
  return { name: '多组草稿校验', key: 'draft_validation_example', description: '', hypothesis: '', traffic: 10, domainId: 'overlap', layerId: 'ranking', audienceId: '', metric: '下单转化率', guardrails: ['支付成功率'], variants: [group('group-a', 'treatment', 25), group('group-b', 'control', 25), group('group-c', 'treatment', 50)], ...changes };
}
function reservation(id, changes = {}) {
  const source = initialExperiments.find(experiment => experiment.layerId === 'ranking' && experiment.status === 'running');
  return { ...structuredClone(source), id, key: id, name: id, traffic: 100, bucketStart: 0, parameterKeys: ['ranking.model'], ...changes };
}
function withCustomParameters() {
  const t = topology();
  t.parameters = ['ranking.typed', 'ranking.pending', 'ranking.unassigned'].map(key => ({ key, name: key, type: 'number', defaultValue: 20, owner: '测试负责人', description: '', createdAt: '2026-09-12T00:00:00.000Z' }));
  t.pendingParameterKeys = ['ranking.pending'];
  t.layers.find(layer => layer.id === 'ranking').parameterKeys.push('ranking.typed', 'ranking.unassigned');
  t.catalog = structuredClone(getCatalog(t));
  for (const binding of t.catalog.bindings) if (['ranking.typed', 'ranking.pending'].includes(binding.key)) binding.serviceId = 'ranking-service';
  assert.equal(validateTopology(t), null);
  return t;
}
const groupIssues = issues => issues.filter(issue => issue.section === 'groups');

test('a complete twenty-group draft passes without changing IDs, control position, values or topology', () => {
  const form = draft({ variants: Array.from({ length: 20 }, (_, index) => group(`group-${index}`, index === 13 ? 'control' : 'treatment', 5)) });
  const t = topology(), before = structuredClone({ form, t });
  assert.deepEqual(validateDraftForm(form, [], t), []);
  assert.deepEqual({ form, t }, before);
});

test('unfinished goal and malformed JSON return section issues while preserving the exact editable text', () => {
  const form = draft({ name: '', key: '', metric: '', variants: [group('a', 'control', 50), group('b', 'treatment', 50, '{\n  "ranking.model": ')] });
  const before = structuredClone(form), issues = validateDraftForm(form, [], topology());
  for (const field of ['name', 'key', 'metric']) assert.ok(issues.some(issue => issue.section === 'goal' && issue.field === field), field);
  assert.ok(issues.some(issue => issue.section === 'groups' && issue.variantId === 'b' && issue.field === 'variant-value'));
  assert.deepEqual(form, before);
  assert.equal(new Set(issues.map(issue => issue.id)).size, issues.length, 'Problem-list IDs must not collide within one result');
});

test('formal experiment names and keys remain occupied when copying into a new draft', () => {
  const existing = [reservation('source')];
  const form = draft({ name: 'source', key: 'source', traffic: 1 });
  const issues = validateDraftForm(form, existing, topology());
  for (const field of ['name', 'key']) assert.ok(issues.some(issue => issue.section === 'goal' && issue.field === field), field);
  assert.ok(issues.some(issue => issue.field === 'traffic' && /可用 0 桶/.test(issue.message)), 'A source experiment must not be excluded from reservations');
});

test('goal validation rejects a guardrail as the primary metric and unknown guardrails', () => {
  const issues = validateDraftForm(draft({ metric: '支付成功率', guardrails: ['未知护栏'] }), [], topology());
  assert.ok(issues.some(issue => issue.section === 'goal' && issue.field === 'metric'));
  assert.ok(issues.some(issue => issue.section === 'goal' && issue.field === 'guardrails'));
});

test('missing, mismatched, routing and empty layer contexts report selection issues without throwing or alleging capacity shortage', () => {
  const t = topology();
  t.layers.push({ id: 'empty-draft-layer', domainId: 'overlap', name: '空草稿层', parameterKeys: [], description: '' });
  for (const changes of [
    { domainId: '', layerId: '' }, { domainId: 'gone', layerId: 'gone' },
    { domainId: 'exclusive', layerId: 'ranking' },
    { domainId: 'root', layerId: 'root-layer' },
    { layerId: 'empty-draft-layer' },
  ]) {
    const issues = validateDraftForm(draft(changes), [], t);
    assert.ok(issues.some(issue => issue.section === 'traffic' && ['domainId', 'layerId'].includes(issue.field)), JSON.stringify(changes));
    assert.equal(issues.some(issue => issue.field === 'traffic' && /可用.*桶|容量/.test(issue.message)), false, JSON.stringify(changes));
  }
});

test('invalid topology is described as invalid configuration instead of total capacity exhaustion', () => {
  const existing = [reservation('bad-reservation', { bucketRanges: [] })];
  const issues = validateDraftForm(draft(), existing, topology());
  assert.ok(issues.some(issue => issue.section === 'traffic' && /配置检查未通过/.test(issue.message)));
  assert.equal(issues.some(issue => /当前受众可用/.test(issue.message)), false);
});

test('unknown and contradictory inherited audiences are distinguished from insufficient traffic', () => {
  const unknown = validateDraftForm(draft({ audienceId: 'audience-missing' }), [], topology());
  assert.ok(unknown.some(issue => issue.field === 'audienceId' && /不存在/.test(issue.message)));
  assert.equal(unknown.some(issue => issue.field === 'traffic'), false);
  const t = topology();
  t.domains.find(domain => domain.id === 'overlap').audienceId = 'new-users-v1';
  const empty = validateDraftForm(draft({ audienceId: 'returning-users-v1' }), [], t);
  assert.ok(empty.some(issue => issue.field === 'audienceId' && /交集为空/.test(issue.message)));
  assert.equal(empty.some(issue => issue.field === 'traffic'), false);
});

test('traffic accepts a single bucket and combines fragmented capacity but rejects precision and true exhaustion', () => {
  const t = topology();
  assert.deepEqual(validateDraftForm(draft({ traffic: 0.01 }), [], t), []);
  for (const traffic of [0, 0.001, 1.001, 100.01]) assert.ok(validateDraftForm(draft({ traffic }), [], t).some(issue => issue.field === 'traffic'), String(traffic));
  const existing = [reservation('fragmented', { traffic: 50, bucketRanges: [{ start: 0, end: 2000 }, { start: 4000, end: 6000 }, { start: 8000, end: 9000 }] })];
  assert.deepEqual(validateDraftForm(draft({ traffic: 50 }), existing, t), []);
  const issues = validateDraftForm(draft({ traffic: 50.01 }), existing, t);
  assert.ok(issues.some(issue => issue.field === 'traffic' && /申请 5001 桶.*可用 5000 桶/.test(issue.message)));
});

test('malformed, primitive, array and overflowing JSON in a hidden group are rejected without rewriting any group', () => {
  for (const raw of ['{bad', 'null', '[]', '42', '{"ranking.model":1e309}']) {
    const form = draft(); form.variants[2].value = raw;
    const before = structuredClone(form);
    const issues = validateDraftForm(form, [], topology());
    assert.ok(issues.some(issue => issue.variantId === 'group-c' && issue.field === 'variant-value'), raw);
    assert.deepEqual(form, before);
  }
});

test('all group Key sets are compared and missing keys identify the exact group and parameter', () => {
  const form = draft(); form.variants[2].value = JSON.stringify({ 'ranking.model': 'c', 'ranking.search': 'search_v2' });
  const issues = validateDraftForm(form, [], topology());
  for (const id of ['group-a', 'group-b']) assert.ok(issues.some(issue => issue.variantId === id && issue.parameterKey === 'ranking.search' && /缺少参数/.test(issue.message)));
  assert.deepEqual(draftParameterKeys(form).sort(), ['ranking.model', 'ranking.search']);
});

test('cross-layer and unknown parameter keys are rejected in every affected group', () => {
  for (const key of ['ui.layout', 'unknown.parameter']) {
    const form = draft({ variants: [group('a', 'control', 50, { [key]: true }), group('b', 'treatment', 50, { [key]: false })] });
    const issues = validateDraftForm(form, [], topology());
    for (const id of ['a', 'b']) assert.ok(issues.some(issue => issue.variantId === id && issue.parameterKey === key), `${key}:${id}`);
  }
});

test('typed custom values and missing application ownership are localized to group and Key', () => {
  const t = withCustomParameters();
  const form = draft({ variants: [group('a', 'control', 50, { 'ranking.typed': 20, 'ranking.unassigned': 1 }), group('b', 'treatment', 50, { 'ranking.typed': '20', 'ranking.unassigned': 2 })] });
  const issues = validateDraftForm(form, [], t);
  assert.ok(issues.some(issue => issue.variantId === 'b' && issue.parameterKey === 'ranking.typed' && /number/.test(issue.message)));
  for (const id of ['a', 'b']) assert.ok(issues.some(issue => issue.variantId === id && issue.parameterKey === 'ranking.unassigned' && /归属应用/.test(issue.message)));
  assert.equal(issues.some(issue => issue.variantId === 'a' && issue.parameterKey === 'ranking.typed'), false);
});

test('pending parameters remain ineligible and their issue explains the missing assignment', () => {
  const form = draft({ variants: [group('a', 'control', 50, { 'ranking.pending': 10 }), group('b', 'treatment', 50, { 'ranking.pending': 20 })] });
  const issues = validateDraftForm(form, [], withCustomParameters());
  for (const id of ['a', 'b']) assert.ok(issues.some(issue => issue.variantId === id && issue.parameterKey === 'ranking.pending' && /待归层/.test(issue.message)), id);
});

test('hidden duplicate names and invalid weights have group-specific navigation targets', () => {
  const form = draft(); form.variants[2].name = ' GROUP-A '; form.variants[2].weight = 0;
  const issues = groupIssues(validateDraftForm(form, [], topology()));
  assert.ok(issues.some(issue => issue.variantId === 'group-c' && issue.field === 'variant-name'));
  assert.ok(issues.some(issue => issue.variantId === 'group-c' && issue.field === 'variant-weight'));
});

test('a second control group is localized rather than only producing an unlinked summary', () => {
  const form = draft(); form.variants[2].role = 'control';
  const issues = groupIssues(validateDraftForm(form, [], topology()));
  assert.ok(issues.length);
  for (const id of ['group-b', 'group-c']) assert.ok(issues.some(issue => issue.variantId === id && /对照/.test(issue.message)), id);
});

test('duplicate and escaped nested keys in hidden groups cannot pass submission validation', () => {
  for (const raw of [
    '{"ranking.model":"one","ranking.model":"two"}',
    '{"ranking.model":{"route":1,"\\u0072oute":2}}',
  ]) {
    const form = draft(); form.variants[2].value = raw;
    const before = structuredClone(form);
    const issues = validateDraftForm(form, [], topology());
    assert.ok(issues.some(issue => issue.variantId === 'group-c' && issue.field === 'variant-value' && issue.parameterKey === 'ranking.model' && /重复/.test(issue.message)), raw);
    assert.deepEqual(form, before);
  }
});

test('draft key inventory never derives accepted keys by silently collapsing invalid JSON', () => {
  const form = draft({ variants: [group('a', 'control', 50, '{"ranking.model":"valid"}'), group('b', 'treatment', 50, '{"ui.layout":1,"ui.layout":2}')] });
  assert.deepEqual(draftParameterKeys(form), ['ranking.model']);
  assert.ok(validateDraftForm(form, [], topology()).some(issue => issue.variantId === 'b' && /重复/.test(issue.message)));
});

test('nonfinite and excessive depth retain finite JSON wording and exact draft source', () => {
  const deepValue = '{"nested":'.repeat(33) + '0' + '}'.repeat(33);
  for (const raw of ['{"ranking.model":1e309}', `{"ranking.model":${deepValue}}`]) {
    const form = draft(); form.variants[1].value = raw;
    const before = structuredClone(form);
    const issues = validateDraftForm(form, [], topology());
    assert.ok(issues.some(issue => issue.variantId === 'group-b' && issue.field === 'variant-value' && /有限 JSON/.test(issue.message)));
    assert.deepEqual(form, before);
  }
});
