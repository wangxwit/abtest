import test from 'node:test';
import assert from 'node:assert/strict';
import { initialExperiments } from '../src/data.ts';
import { defaultTopology, planLayerCreation } from '../src/traffic.ts';
import { getParameterRelationships } from '../src/parameter-relations.ts';

const cloneTopology = () => structuredClone(defaultTopology);
const copyExperiment = id => structuredClone(initialExperiments.find(e => e.id === id));
const referenceFor = (result, id) => result.references.find(r => r.experiment.id === id);
const ownerFor = (result, layerId) => result.owners.find(o => o.layerId === layerId);

test('relationship owners resolve inherited parameters and preserve mutually exclusive domain ownership', () => {
 const result = getParameterRelationships('ui.content_card', initialExperiments, defaultTopology);
 assert.equal(result.key, 'ui.content_card');
 assert.deepEqual(result.owners.map(o => o.layerId).sort(), [
  'root-layer', 'presentation', 'full', 'ui-content', 'ui-full', 'card-layout',
 ].sort());
 assert.deepEqual(result.issues, [], 'The same parameter in different domains is not duplicate ownership');
 assert.equal(ownerFor(result, 'ui-content').globalTraffic, 16);
 assert.equal(ownerFor(result, 'card-layout').globalTraffic, 8);
 assert.equal(ownerFor(result, 'ui-full').mode, 'non-overlapping');
 assert.ok(ownerFor(result, 'card-layout').path.length > ownerFor(result, 'presentation').path.length);
 const ranking = getParameterRelationships('ranking.model', initialExperiments, defaultTopology);
 assert.equal(ownerFor(ranking, 'ui-full'), undefined, 'A nested wildcard only inherits its parent scope');
 assert.ok(ownerFor(ranking, 'full'), 'The root-isolated wildcard inherits the complete parameter catalog');
});

test('references are exact declarations, while owner usage contains only directly attached experiments', () => {
 const result = getParameterRelationships('ui.content_card', initialExperiments, defaultTopology);
 const expected = initialExperiments.filter(e => e.parameterKeys.includes('ui.content_card')).map(e => e.id).sort();
 assert.deepEqual(result.references.map(r => r.experiment.id).sort(), expected);
 assert.deepEqual(ownerFor(result, 'root-layer').referenceExperimentIds, []);
 assert.deepEqual(ownerFor(result, 'card-layout').referenceExperimentIds, ['EXP-1204']);
 assert.ok(!ownerFor(result, 'presentation').referenceExperimentIds.includes('EXP-1204'));
 assert.ok(result.references.every(r => r.currentOwner === true));

 const undeclared = copyExperiment('EXP-1028');
 undeclared.variants[0].value = JSON.stringify({ 'ranking.model': 'baseline', 'ui.content_card': 'incidental payload key' });
 const exact = getParameterRelationships('ui.content_card', [undeclared], defaultTopology);
 assert.deepEqual(exact.references, [], 'Payload coincidence must not create a declared parameter relationship');
});

test('transfer restrictions reflect root routing, child inheritance, active use, and available parameters', () => {
 const layout = getParameterRelationships('ui.layout', initialExperiments, defaultTopology);
 assert.ok(ownerFor(layout, 'root-layer').transferBlockedReason);
 assert.ok(ownerFor(layout, 'full').transferBlockedReason);
 assert.ok(ownerFor(layout, 'presentation').transferBlockedReason);
 assert.ok(ownerFor(layout, 'ui-navigation').transferBlockedReason);
 const recall = getParameterRelationships('ranking.recall', initialExperiments, defaultTopology);
 assert.equal(ownerFor(recall, 'ranking').transferBlockedReason, null, 'Only completed experiments reference this transferable parameter');
});

test('a duplicate parameter owner in the same domain is reported without throwing', () => {
 const topology = cloneTopology();
 topology.layers.push({ id: 'invalid-second-ranking', domainId: 'overlap', name: '重复排序层', parameterKeys: ['ranking.model'], description: '' });
 const result = getParameterRelationships('ranking.model', initialExperiments, topology);
 assert.equal(result.owners.filter(o => o.domainId === 'overlap').length, 2);
 assert.ok(result.issues.length > 0, 'A duplicate owner must be visible to the operator');
});

test('unfinished dangling, wrong-domain, and out-of-scope references are reported', () => {
 for (const changes of [
  { layerId: 'removed-layer' },
  { domainId: 'exclusive' },
  { layerId: 'transaction' },
 ]) {
  const broken = { ...copyExperiment('EXP-1028'), ...changes };
  const result = getParameterRelationships('ranking.model', [broken], defaultTopology);
  assert.equal(referenceFor(result, broken.id).currentOwner, false);
  assert.ok(result.issues.length > 0, JSON.stringify(changes));
 }
});

test('completed historical references survive a valid parameter transfer without being marked invalid', () => {
 const completed = initialExperiments.find(e => e.parameterKeys.includes('ranking.recall'));
 assert.equal(completed.status, 'completed');
 const transfer = planLayerCreation({ id: 'recall-owner', domainId: 'overlap', name: '召回参数层', description: '', parameterKeys: ['ranking.recall'] }, initialExperiments, defaultTopology);
 assert.equal(transfer.error, null);
 const before = getParameterRelationships('ranking.recall', initialExperiments, defaultTopology);
 const after = getParameterRelationships('ranking.recall', initialExperiments, transfer.topology);
 assert.equal(referenceFor(before, completed.id).currentOwner, true);
 assert.equal(referenceFor(after, completed.id).currentOwner, false);
 assert.ok(ownerFor(after, 'recall-owner'));
 assert.equal(ownerFor(after, 'ranking'), undefined);
 assert.deepEqual(after.issues, [], 'A historical completed experiment is not an active dangling reference');
 assert.deepEqual(ownerFor(after, 'recall-owner').referenceExperimentIds, []);
});

test('variant values retain falsy and structured JSON values instead of treating them as missing', () => {
 const experiment = copyExperiment('EXP-1101');
 experiment.variants = [false, 0, '', null, { enabled: true, weights: [1, 2] }].map((value, index) => ({
  name: `版本 ${index}`, weight: 20,
  value: JSON.stringify({ 'ui.layout': 'classic', 'ranking.model': 'baseline', 'checkout.parallel': value }),
 }));
 const result = getParameterRelationships('checkout.parallel', [experiment], defaultTopology);
 const values = referenceFor(result, experiment.id).values;
 assert.equal(values.length, 5);
 assert.deepEqual(values.map(v => v.variant), experiment.variants.map(v => v.name));
 assert.deepEqual(result.issues, [], 'The relationship reader does not invent a parameter value schema');
 assert.deepEqual(values.map(v => v.value), [false, 0, '', null, { enabled: true, weights: [1, 2] }]);
 assert.ok(values.every(v => !v.error));
});

test('malformed JSON and non-object payloads are reported per reference without breaking other values', () => {
 for (const invalid of ['{broken', 'null', '[1,2]', '42', '"scalar"']) {
  const experiment = copyExperiment('EXP-1028');
  experiment.variants[1].value = invalid;
  let result;
  assert.doesNotThrow(() => { result = getParameterRelationships('ranking.model', [experiment], defaultTopology); });
  const reference = referenceFor(result, experiment.id);
  assert.equal(reference.values.length, 2);
  assert.ok(result.issues.length > 0, `Invalid payload was accepted: ${invalid}`);
  assert.equal(reference.values[0].error, undefined);
  assert.ok(reference.values[1].error);
  assert.equal(reference.values[1].value, null);
 }
});

test('a missing declared parameter in one variant is visible while a JSON null remains configured', () => {
 const experiment = copyExperiment('EXP-1028');
 experiment.variants[0].value = JSON.stringify({ 'ranking.model': null });
 experiment.variants[1].value = '{}';
 const result = getParameterRelationships('ranking.model', [experiment], defaultTopology);
 const reference = referenceFor(result, experiment.id);
 assert.equal(reference.values.length, 2);
 assert.ok(result.issues.length > 0);
 assert.equal(reference.values[0].value, null);
 assert.equal(reference.values[0].error, undefined);
 assert.equal(reference.values[1].value, null);
 assert.ok(reference.values[1].error);
});
