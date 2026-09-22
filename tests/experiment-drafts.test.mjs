import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_PREFIX, createExperimentDraft, saveExperimentDraft, loadExperimentDraft,
  listExperimentDrafts, markExperimentDraftSubmitted, setDraftLeaveGuard, canLeaveExperimentDraft,
} from '../src/experiment-drafts.ts';
import { parseExperimentDraftRoute, experimentDraftHref, newExperimentHref } from '../src/experiment-draft-routes.ts';
import { initialDraftForm } from '../src/experiment-draft-initial.ts';
import { defaultTopology } from '../src/traffic.ts';
import { initialExperiments } from '../src/data.ts';
import { selectionAudience } from '../src/audiences.ts';

function memoryStorage(entries = []) {
  const values = new Map(entries), writes = [];
  let denyReads = false, denyWrites = false, denyEnumeration = false;
  return {
    values, writes,
    get length() { if (denyEnumeration) throw new Error('blocked enumeration'); return values.size; },
    key(index) { if (denyEnumeration) throw new Error('blocked enumeration'); return [...values.keys()][index] ?? null; },
    getItem(key) { if (denyReads) throw new Error('blocked read'); return values.get(key) ?? null; },
    setItem(key, value) { if (denyWrites) throw new Error('QuotaExceededError'); writes.push([key, value]); values.set(key, value); },
    blockReads(value = true) { denyReads = value; },
    blockWrites(value = true) { denyWrites = value; },
    blockEnumeration(value = true) { denyEnumeration = value; },
  };
}
const form = (changes = {}) => ({
  name: '', key: '', description: '', hypothesis: '', traffic: 0, domainId: '', layerId: '', audienceId: '', metric: '', guardrails: [],
  variants: [
    { id: 'draft-group-a', role: 'control', name: '', weight: 0, value: '{ invalid JSON\n   keep exactly' },
    { id: 'draft-group-b', role: 'treatment', name: '', weight: -5, value: '' },
  ], ...changes,
});
function success(result) { assert.equal(result.ok, true, result.error); return result; }
function failure(result, code) { assert.equal(result.ok, false); assert.ok(result.error); if (code) assert.equal(result.code, code); return result; }
function create(storage, id = 'draft-test-0001', changes = {}) { return success(createExperimentDraft({ id, form: form(changes), section: 'groups', selectedVariantId: 'draft-group-b' }, storage)).draft; }
const keyFor = id => DRAFT_PREFIX + id;

test('draft persistence retains incomplete fields and invalid JSON source exactly across refresh-like reads', () => {
  const storage = memoryStorage(), draft = create(storage), before = structuredClone(draft);
  assert.equal(draft.revision, 1);
  assert.equal(draft.section, 'groups');
  assert.equal(draft.selectedVariantId, 'draft-group-b');
  assert.ok(Number.isFinite(Date.parse(draft.createdAt)));
  const reloaded = success(loadExperimentDraft(draft.id, storage)).draft;
  assert.deepEqual(reloaded, before);
  reloaded.form.variants[0].value = 'mutated reader';
  assert.deepEqual(success(loadExperimentDraft(draft.id, storage)).draft, before, 'Loaded objects must not share writable state with storage');
  assert.equal([...storage.values.keys()].every(key => key.startsWith(DRAFT_PREFIX)), true, 'Draft saves must not write topology, experiments or snapshots');
});

test('create and save isolate caller objects and preserve stable draft identity with increasing revisions', () => {
  const storage = memoryStorage(), original = form(), created = success(createExperimentDraft({ id: 'draft-clone-0001', form: original }, storage)).draft;
  original.variants[0].value = 'later caller mutation';
  assert.notEqual(created.form.variants[0].value, original.variants[0].value);
  const input = { ...created, form: form({ name: '草稿名称', key: 'unfinished_' }), section: 'review', selectedVariantId: 'draft-group-a' };
  const saved = success(saveExperimentDraft(input, storage)).draft;
  assert.equal(saved.id, created.id);
  assert.equal(saved.revision, 2);
  assert.equal(saved.createdAt, created.createdAt);
  assert.equal(saved.section, 'review');
  assert.equal(saved.selectedVariantId, 'draft-group-a');
  input.form.variants[0].value = 'mutated after save';
  assert.notEqual(saved.form.variants[0].value, input.form.variants[0].value);
  assert.deepEqual(success(loadExperimentDraft(saved.id, storage)).draft, saved);
});

test('the list contains multiple drafts, ignores unrelated storage and does not expose submitted tombstones', () => {
  const storage = memoryStorage([['exp-lab-experiments-v3', 'real-experiments-untouched']]);
  const first = create(storage, 'draft-list-first', { name: '一' }), second = create(storage, 'draft-list-second', { name: '二' });
  assert.deepEqual(success(listExperimentDrafts(storage)).drafts.map(draft => draft.id).sort(), [first.id, second.id].sort());
  success(markExperimentDraftSubmitted(first.id, 'EXP-DRAFT-ONE', first.revision, storage));
  assert.deepEqual(success(listExperimentDrafts(storage)).drafts.map(draft => draft.id), [second.id]);
  assert.equal(success(loadExperimentDraft(first.id, storage)).draft.submittedExperimentId, 'EXP-DRAFT-ONE');
  assert.equal(storage.values.get('exp-lab-experiments-v3'), 'real-experiments-untouched');
});

test('stale revisions cannot overwrite newer content while another draft remains independently editable', () => {
  const storage = memoryStorage(), first = create(storage), second = create(storage, 'draft-test-0002');
  const tabA = success(loadExperimentDraft(first.id, storage)).draft, tabB = success(loadExperimentDraft(first.id, storage)).draft;
  const updated = success(saveExperimentDraft({ ...tabA, form: { ...tabA.form, name: '最新内容' } }, storage)).draft;
  const currentBytes = storage.values.get(keyFor(first.id));
  const conflict = failure(saveExperimentDraft({ ...tabB, form: { ...tabB.form, name: '另页旧稿' } }, storage), 'conflict');
  assert.deepEqual(conflict.currentDraft, updated);
  assert.equal(storage.values.get(keyFor(first.id)), currentBytes);
  success(saveExperimentDraft({ ...second, form: { ...second.form, name: '独立草稿更新' } }, storage));
  assert.equal(storage.values.get(keyFor(first.id)), currentBytes, 'Different drafts must not rewrite one shared envelope');
});

test('create refuses an existing identity and save refuses a missing identity instead of creating a replacement', () => {
  const storage = memoryStorage(), draft = create(storage), before = [...storage.values.entries()];
  failure(createExperimentDraft({ id: draft.id, form: form({ name: '覆盖尝试' }) }, storage), 'conflict');
  failure(saveExperimentDraft({ ...draft, id: 'draft-missing-0001' }, storage), 'missing');
  assert.deepEqual([...storage.values.entries()], before);
  assert.deepEqual(success(loadExperimentDraft('draft-missing-0001', storage)), { ok: true, draft: null });
});

test('malformed JSON, schema versions and record identities are reported without replacing original bytes', () => {
  const storage = memoryStorage(), valid = create(storage), normal = JSON.parse(storage.values.get(keyFor(valid.id)));
  const corruptions = ['{broken json', JSON.stringify({ ...normal, schemaVersion: 2 }), JSON.stringify({ ...normal, draft: { ...normal.draft, id: 'draft-different-id' } }), JSON.stringify({ ...normal, draft: { ...normal.draft, form: { ...normal.draft.form, traffic: null } } })];
  for (const raw of corruptions) {
    storage.values.set(keyFor(valid.id), raw);
    failure(loadExperimentDraft(valid.id, storage));
    failure(saveExperimentDraft(valid, storage));
    assert.equal(storage.values.get(keyFor(valid.id)), raw);
    const listing = success(listExperimentDrafts(storage));
    assert.equal(listing.drafts.length, 0);
    assert.ok(listing.warnings.length > 0);
  }
});

test('read denial, quota exhaustion and enumeration failure are explicit and never claim successful persistence', () => {
  const storage = memoryStorage(), draft = create(storage), before = storage.values.get(keyFor(draft.id));
  storage.blockReads();
  failure(loadExperimentDraft(draft.id, storage), 'storage');
  failure(saveExperimentDraft(draft, storage), 'storage');
  storage.blockReads(false); storage.blockWrites();
  failure(saveExperimentDraft({ ...draft, form: form({ name: '仍在内存中的更改' }) }, storage), 'storage');
  failure(createExperimentDraft({ id: 'draft-quota-0001', form: form() }, storage), 'storage');
  failure(markExperimentDraftSubmitted(draft.id, 'EXP-QUOTA', draft.revision, storage), 'storage');
  assert.equal(storage.values.get(keyFor(draft.id)), before);
  assert.equal(storage.values.has(keyFor('draft-quota-0001')), false);
  storage.blockEnumeration();
  failure(listExperimentDrafts(storage), 'storage');
});

test('submission records are idempotent for one experiment and cannot be edited or rebound afterward', () => {
  const storage = memoryStorage(), draft = create(storage);
  failure(markExperimentDraftSubmitted(draft.id, 'EXP-ONE', draft.revision + 1, storage), 'conflict');
  const marked = success(markExperimentDraftSubmitted(draft.id, 'EXP-ONE', draft.revision, storage)).draft;
  assert.equal(marked.revision, draft.revision + 1);
  const raw = storage.values.get(keyFor(draft.id)), count = storage.writes.length;
  assert.deepEqual(success(markExperimentDraftSubmitted(draft.id, 'EXP-ONE', draft.revision, storage)).draft, marked);
  assert.equal(storage.writes.length, count, 'Idempotent repeat must not create another revision');
  failure(markExperimentDraftSubmitted(draft.id, 'EXP-TWO', marked.revision, storage), 'submitted');
  failure(saveExperimentDraft({ ...marked, form: form({ name: '已提交后修改' }) }, storage), 'submitted');
  assert.equal(storage.values.get(keyFor(draft.id)), raw);
});

test('untrusted record timestamps and unsafe revision numbers are rejected before optimistic locking', () => {
  const storage = memoryStorage(), draft = create(storage), envelope = JSON.parse(storage.values.get(keyFor(draft.id)));
  for (const change of [{ createdAt: 'not-a-date' }, { updatedAt: '' }, { revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    const raw = JSON.stringify({ ...envelope, draft: { ...draft, ...change } });
    storage.values.set(keyFor(draft.id), raw);
    failure(loadExperimentDraft(draft.id, storage), 'invalid');
    failure(saveExperimentDraft({ ...draft, ...change }, storage));
    assert.equal(storage.values.get(keyFor(draft.id)), raw);
  }
});

test('revision overflow and invalid experiment identities cannot produce successful no-op submission markers', () => {
  const storage = memoryStorage(), draft = create(storage);
  for (const experimentId of ['', '   ', undefined, null]) failure(markExperimentDraftSubmitted(draft.id, experimentId, draft.revision, storage), 'invalid');
  const raw = JSON.stringify({ schemaVersion: 1, draft: { ...draft, revision: Number.MAX_SAFE_INTEGER } });
  storage.values.set(keyFor(draft.id), raw);
  failure(saveExperimentDraft({ ...draft, revision: Number.MAX_SAFE_INTEGER }, storage));
  assert.equal(storage.values.get(keyFor(draft.id)), raw);
});

test('draft URLs preserve encoded source context and exact draft identity across parsing', () => {
  const id = 'draft-route-0001';
  assert.deepEqual(parseExperimentDraftRoute(experimentDraftHref(id)), { kind: 'draft', draftId: id });
  assert.deepEqual(parseExperimentDraftRoute('#experiments/drafts/draft%2Droute%2D0001'), { kind: 'draft', draftId: id });
  assert.deepEqual(parseExperimentDraftRoute(newExperimentHref()), { kind: 'new' });
  assert.deepEqual(parseExperimentDraftRoute(newExperimentHref({ layerId: '层/with ?#&%' })), { kind: 'new', initialLayerId: '层/with ?#&%' });
  assert.deepEqual(parseExperimentDraftRoute(newExperimentHref({ copyExperimentId: 'EXP A/?&%' })), { kind: 'new', copyExperimentId: 'EXP A/?&%' });
  for (const hash of ['#experiments', '#experiments?audience=new-users-v1', '#experiments/EXP-1028', '#traffic/validation']) assert.equal(parseExperimentDraftRoute(hash).kind, 'none');
});

test('invalid draft URLs cannot silently become a fresh draft or discard conflicting query context', () => {
  for (const hash of [
    '#experiments/drafts', '#experiments/drafts/', '#experiments/drafts/not-a-draft', '#experiments/drafts/draft-route-0001/extra',
    '#experiments/drafts/draft-route-0001?layer=ranking', '#experiments/drafts/%zz',
    '#experiments/new?layer=', '#experiments/new?copy=', '#experiments/new?layer=%20', '#experiments/new?layer=%zz',
    '#experiments/new?layer=ranking&layer=transaction', '#experiments/new?copy=a&copy=b', '#experiments/new?layer=ranking&copy=EXP-1',
    '#experiments/new?unknown=x', '#experiments/new?layer=ranking?copy=EXP-1',
  ]) assert.equal(parseExperimentDraftRoute(hash).kind, 'invalid', hash);
});

test('blank and layer-scoped initial forms require deliberate configuration and never allocate traffic', () => {
  const topology = structuredClone(defaultTopology), before = structuredClone(topology);
  const blank = initialDraftForm(topology), scoped = initialDraftForm(topology, { layerId: 'ranking' });
  assert.equal(blank.name, ''); assert.equal(blank.key, ''); assert.equal(blank.metric, '');
  assert.equal(blank.layerId, ''); assert.equal(blank.domainId, '');
  assert.equal(scoped.layerId, 'ranking'); assert.equal(scoped.domainId, 'overlap');
  assert.equal(scoped.variants.length, 2);
  assert.deepEqual(scoped.variants.map(variant => variant.role), ['control', 'treatment']);
  assert.deepEqual(scoped.variants.map(variant => variant.value), ['{}', '{}']);
  assert.equal(new Set(scoped.variants.map(variant => variant.id)).size, 2);
  assert.equal('bucketRanges' in scoped, false); assert.equal('bucketStart' in scoped, false);
  assert.deepEqual(topology, before);
});

test('copying an experiment preserves values and explicit roles but creates fresh group identity without old allocation or submission fields', () => {
  const source = structuredClone(initialExperiments.find(experiment => experiment.layerId === 'ranking'));
  source.variants = [
    { id: 'source-treatment', role: 'treatment', name: '方案一', weight: 40, value: '{unfinished but retained' },
    { id: 'source-control', role: 'control', name: '基准', weight: 60, value: '{"ranking.model":"control"}' },
  ];
  source.audienceId = 'new-users-v1'; source.guardrails = ['支付成功率'];
  const before = structuredClone(source), copied = initialDraftForm(defaultTopology, { source });
  assert.equal(copied.name, `${source.name} 副本`); assert.equal(copied.key, '');
  assert.equal(copied.layerId, source.layerId); assert.equal(copied.domainId, source.domainId);
  assert.equal(copied.audienceId, source.audienceId);
  assert.deepEqual(copied.variants.map(({ id, ...variant }) => variant), source.variants.map(({ id, ...variant }) => variant));
  assert.ok(copied.variants.every(variant => !source.variants.some(old => old.id === variant.id)));
  for (const key of ['id', 'sourceDraftId', 'submittedExperimentId', 'status', 'participants', 'bucketStart', 'bucketRanges', 'parameterRules', 'coordination']) assert.equal(key in copied, false, key);
  copied.guardrails.push('changed');
  assert.deepEqual(source, before);
});

test('copying recognized legacy audience labels preserves the fixed qualification version', () => {
  const source = structuredClone(initialExperiments.find(experiment => experiment.layerId === 'ranking'));
  delete source.audienceId;
  for (const [audience, id] of [['新注册用户', 'new-users-v1'], ['老用户', 'returning-users-v1'], ['移动端用户', 'mobile-users-v1']]) {
    source.audience = audience;
    const copied = initialDraftForm(defaultTopology, { source });
    assert.equal(copied.audienceId, id, 'Copying a legacy condition must not broaden the draft to universal qualification');
    assert.deepEqual(selectionAudience({ audienceId: copied.audienceId }, defaultTopology), selectionAudience(source, defaultTopology));
  }
});

test('unknown legacy audience conditions remain blocked or explicitly reject copying instead of becoming universal', () => {
  const source = { ...structuredClone(initialExperiments.find(experiment => experiment.layerId === 'ranking')), audience: 'legacy-unresolvable-condition' };
  delete source.audienceId;
  let copied;
  try { copied = initialDraftForm(defaultTopology, { source }); }
  catch (error) { assert.ok(error instanceof Error); return; }
  assert.ok(copied.audienceId, 'An opaque previous condition must not silently become empty audience selection');
  assert.equal(selectionAudience({ audienceId: copied.audienceId }, defaultTopology).unknown, true);
});

test('the navigation guard blocks leaving on failed save and can be reliably removed', t => {
  t.after(() => setDraftLeaveGuard(null));
  assert.equal(canLeaveExperimentDraft(), true);
  setDraftLeaveGuard(() => false);
  assert.equal(canLeaveExperimentDraft(), false);
  setDraftLeaveGuard(() => true);
  assert.equal(canLeaveExperimentDraft(), true);
  setDraftLeaveGuard(null);
  assert.equal(canLeaveExperimentDraft(), true);
});
