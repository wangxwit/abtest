import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { initialExperiments } from '../src/data.ts';
import { defaultTopology, validateTopology, validateAllocation, findAvailableStart, layerUsage, layerAudienceCapacity, simulateAllocation, candidateLayerAudience } from '../src/traffic.ts';
import { defaultAudiences, getAudienceCatalog, getAudience, planAudienceRegistration, validateAudienceRules, evaluateAudience, selectionAudience, compareAudienceConditions, domainEffectiveAudience, experimentEffectiveAudience } from '../src/audiences.ts';

const base = () => structuredClone(defaultTopology);
const rule = (field, op, value) => ({ field, op, value });
const input = (changes = {}) => ({ id: 'country-cn-v1', familyId: 'country-cn', name: '中国用户', description: '固定入组画像', owner: '增长组', version: 1, rules: [rule('country', 'eq', 'CN')], ...changes });
function ok(plan) { assert.equal(plan.error, null); assert.ok(plan.topology); return plan.topology; }
function rejected(plan, regex) { assert.equal(plan.topology, null); assert.ok(plan.error); if (regex) assert.match(plan.error, regex); }
function experiment(id, audienceId, changes = {}) {
  const source = initialExperiments.find(item => item.layerId === 'ranking' && item.status === 'running');
  return { ...structuredClone(source), id, name: id, key: id, domainId: 'overlap', layerId: 'ranking', traffic: 100, bucketStart: 0, audience: '全部活跃用户', ...(audienceId ? { audienceId } : {}), ...changes };
}
function addChild(t, id, audienceId, changes = {}) {
  t.domains.push({ id, name: id, parentLayerId: 'ranking', mode: 'overlapping', start: 0, traffic: 100, unit: 'user_id', description: '', audienceId, ...changes });
  t.layers.push({ id: `${id}-layer`, name: `${id}-layer`, domainId: id, parameterKeys: ['*'], description: '' });
  return t;
}
function browserProcess(script, input = {}) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const values = new Map(Object.entries(input.entries ?? {}));
    let failStorage = false;
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (failStorage) throw new Error('Quota exceeded'); values.set(key, value); } }, configurable: true });
    const traffic = await import('./src/traffic.ts');
    const audiences = await import('./src/audiences.ts');
    ${script}
  `], { cwd: new URL('..', import.meta.url), input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('audience evaluation uses a three-valued AND over a fixed admission profile', () => {
  const t = ok(planAudienceRegistration(input({ rules: [rule('country', 'in', ['CN', 'SG']), rule('registration_days', 'lte', 7), rule('is_member', 'eq', false)] }), base()));
  const condition = selectionAudience({ audienceId: 'country-cn-v1' }, t);
  assert.equal(evaluateAudience(condition, { country: 'CN', registration_days: 7, is_member: false }).status, 'match');
  assert.equal(evaluateAudience(condition, { country: 'CN', registration_days: 8, is_member: false }).status, 'not-match');
  assert.equal(evaluateAudience(condition, { country: 'CN', registration_days: 7 }).status, 'unknown');
  assert.equal(evaluateAudience(condition, { country: 'US' }).status, 'not-match', 'A known false AND condition wins over missing attributes');
  for (const registration_days of [NaN, Infinity, -1, 0.5, '7']) assert.equal(evaluateAudience(condition, { country: 'CN', registration_days, is_member: false }).status, 'unknown');
  assert.equal(evaluateAudience(selectionAudience({}, t)).status, 'match');
  assert.equal(evaluateAudience(selectionAudience({ audience: '无法解析的旧受众' }, t), {}).status, 'unknown');
});

test('rules reject unsupported fields, malformed values and contradictory empty audiences', () => {
  for (const rules of [
    null, {}, [rule('unknown', 'eq', 'CN')], [rule('country', 'in', [])], [rule('country', 'in', ['CN', 'CN'])],
    [rule('country', 'in', [true])], [rule('country', 'gte', 1)], [rule('is_member', 'eq', 'true')],
    [rule('registration_days', 'lte', NaN)], [rule('registration_days', 'gte', -1)], [rule('registration_days', 'eq', 0.5)],
    [rule('spend_30d', 'gte', Infinity)], [rule('country', 'eq', 'CN'), rule('country', 'eq', 'US')],
    [rule('registration_days', 'gte', 8), rule('registration_days', 'lte', 7)],
    [rule('is_member', 'eq', true), rule('is_member', 'eq', false)],
  ]) {
    assert.ok(validateAudienceRules(rules), JSON.stringify(rules));
    rejected(planAudienceRegistration(input({ rules }), base()));
  }
  assert.equal(validateAudienceRules([]), null, 'An empty AND list denotes inherited universal eligibility, not an empty audience');
  assert.equal(validateAudienceRules([rule('spend_30d', 'gte', 0.01)]), null);
});

test('only a proved same-field contradiction permits overlap of bucket ranges', () => {
  const t = base();
  const newUsers = selectionAudience({ audienceId: 'new-users-v1' }, t), oldUsers = selectionAudience({ audienceId: 'returning-users-v1' }, t);
  assert.equal(compareAudienceConditions(newUsers, oldUsers).relation, 'disjoint');
  assert.equal(compareAudienceConditions(newUsers, selectionAudience({ audienceId: 'high-value-members-v1' }, t)).relation, 'potential-overlap');
  assert.equal(compareAudienceConditions(newUsers, selectionAudience({ audience: '未知业务人群' }, t)).relation, 'potential-overlap');
  const cn = { rules: [rule('country', 'in', ['CN', 'SG'])], unknown: false, labels: [] };
  assert.equal(compareAudienceConditions(cn, { ...cn, rules: [rule('country', 'eq', 'US')] }).relation, 'disjoint');
  assert.equal(compareAudienceConditions(cn, { ...cn, rules: [rule('country', 'eq', 'SG')] }).relation, 'potential-overlap');
  const boundary = { rules: [rule('spend_30d', 'lte', 500)], unknown: false, labels: [] };
  assert.equal(compareAudienceConditions(boundary, { ...boundary, rules: [rule('spend_30d', 'gte', 500)] }).relation, 'potential-overlap', 'Inclusive endpoints overlap');
});

test('disjoint experiments share the same entire bucket range; overlapping or opaque audiences remain blocked', () => {
  const t = base(), a = experiment('audience-A', 'new-users-v1'), b = experiment('audience-B', 'returning-users-v1');
  assert.equal(validateTopology(t, [a, b]), null);
  assert.equal(validateAllocation(a, [a, b], t), null);
  assert.equal(validateAllocation(b, [a, b], t), null);
  assert.equal(findAvailableStart('ranking', 100, [a], undefined, t, b), 0);
  assert.equal(findAvailableStart('ranking', 1, [a], undefined, t), null, 'Without a candidate audience the conservative universal request cannot reuse occupied buckets');
  for (const other of [experiment('same', 'new-users-v1'), experiment('different-field', 'high-value-members-v1'), experiment('opaque', undefined, { audience: '未解析受众' })]) {
    assert.match(validateAllocation(other, [a], t), /受众可能重叠/);
    assert.match(validateTopology(t, [a, other]), /受众可能重叠/);
  }
});

test('conflict validation checks every overlapping pair, not merely adjacent sorted intervals', () => {
  const t = base();
  const a = experiment('outer-new', 'new-users-v1');
  const b = experiment('inner-old', 'returning-users-v1', { bucketStart: 1, traffic: 1 });
  const c = experiment('inner-new', 'new-users-v1', { bucketStart: 3, traffic: 1 });
  assert.match(validateTopology(t, [a, b, c]), /受众可能重叠/);
  assert.match(validateTopology(t, [c, b, a]), /受众可能重叠/);
});

test('union usage never exceeds 100 while candidate capacity and first-fit account for relevant overlapping populations', () => {
  const t = base();
  const a = experiment('new-range', 'new-users-v1', { traffic: 60 });
  const b = experiment('old-range', 'returning-users-v1', { traffic: 60 });
  assert.equal(layerUsage('ranking', [a, b], t), 60);
  assert.deepEqual(layerAudienceCapacity('ranking', [a], t, b), { occupied: 0, available: 100, largestFree: 100, reusable: 60, nominalOccupied: 60 });
  assert.deepEqual(layerAudienceCapacity('ranking', [a, b], t, b), { occupied: 60, available: 40, largestFree: 40, reusable: 0, nominalOccupied: 60 });
  assert.equal(findAvailableStart('ranking', 40, [a, b], undefined, t, b), 60);
  assert.equal(findAvailableStart('ranking', 41, [a, b], undefined, t, b), null);
  assert.equal(layerUsage('ranking', [experiment('a', 'new-users-v1'), experiment('b', 'returning-users-v1')], t), 100);
});

test('domain eligibility is inherited through every layer and experiment narrowing cannot widen or contradict it', () => {
  const t = ok(planAudienceRegistration(input(), base()));
  t.domains.find(domain => domain.id === 'overlap').audienceId = 'country-cn-v1';
  t.domains.find(domain => domain.id === 'ui-mobile').audienceId = 'new-users-v1';
  const inherited = domainEffectiveAudience('card-depth', t);
  assert.deepEqual(inherited.rules, [rule('country', 'eq', 'CN'), rule('registration_days', 'lte', 7)]);
  const e = experiment('deep-member', 'high-value-members-v1', { domainId: 'card-depth', layerId: 'card-layout', traffic: 10, parameterKeys: ['ui.content_card'], variants: [{ name: 'A', weight: 50, value: '{"ui.content_card":"a"}' }, { name: 'B', weight: 50, value: '{"ui.content_card":"b"}' }] });
  assert.equal(experimentEffectiveAudience(e, t).rules.length, 4);
  assert.equal(validateAllocation(e, [], t), null);
  assert.match(validateAllocation({ ...e, audienceId: 'returning-users-v1' }, [], t), /交集为空/);
  t.domains.find(domain => domain.id === 'card-depth').audienceId = 'returning-users-v1';
  assert.match(validateTopology(t, []), /交集为空/);
});

test('sibling subdomains and direct experiments may reuse buckets only under disjoint effective audiences', () => {
  const t = addChild(addChild(base(), 'new-child', 'new-users-v1'), 'old-child', 'returning-users-v1');
  assert.equal(validateTopology(t, []), null);
  assert.equal(layerUsage('ranking', [], t), 100);
  assert.match(validateAllocation(experiment('conflicting-parent', 'new-users-v1'), [], t), /包括子域/);
  const onlyOld = addChild(base(), 'old-child', 'returning-users-v1');
  const direct = experiment('direct-new', 'new-users-v1');
  assert.equal(validateTopology(onlyOld, [direct]), null);
  assert.equal(validateAllocation(direct, [], onlyOld), null);
  assert.equal(findAvailableStart('ranking', 100, [], undefined, onlyOld, direct), 0);
  assert.equal(candidateLayerAudience('ranking', direct, onlyOld).unknown, false);
  const invalid = structuredClone(t); invalid.domains.find(domain => domain.id === 'old-child').audienceId = 'high-value-members-v1';
  assert.match(validateTopology(invalid, []), /受众可能重叠/);
});

test('simulation evaluates all same-bucket candidates then returns one match with the original variant hash', () => {
  const t = base(), a = experiment('simulation-new', 'new-users-v1'), b = experiment('simulation-old', 'returning-users-v1');
  for (let index = 0; index < 150; index++) {
    const user = `audience_${index}`;
    for (const [profile, expected, other] of [[{ registration_days: 0 }, a, b], [{ registration_days: 8 }, b, a]]) {
      const result = simulateAllocation(user, [a, b], t, profile);
      assert.equal(result.error, undefined);
      const ranking = result.decisions.find(decision => decision.layerId === 'ranking');
      if (!ranking) continue;
      assert.equal(ranking.experimentId, expected.id);
      assert.ok(!result.decisions.some(decision => decision.experimentId === other.id));
      assert.equal(ranking.audienceStatus, 'match');
      const trace = result.trace.find(item => item.kind === 'layer' && item.id === 'ranking');
      assert.ok(trace.reason.includes(`「${expected.name}」匹配`));
      assert.ok(trace.reason.includes(`「${other.name}」不匹配`));
      const alone = simulateAllocation(user, [expected], t, profile).decisions.find(decision => decision.layerId === 'ranking');
      assert.equal(ranking.bucket, alone.bucket);
      assert.equal(ranking.variant, alone.variant);
      assert.deepEqual(ranking.parameters, alone.parameters);
      assert.deepEqual(simulateAllocation(user, [b, a], t, profile), result, 'Candidate list order must not become a priority policy');
    }
  }
});

test('missing attributes do not execute a candidate or backfill another bucket; a known rejection also stays in its original bucket', () => {
  const t = base(), a = experiment('missing-new', 'new-users-v1', { traffic: 50 }), b = experiment('later-old', 'returning-users-v1', { traffic: 50, bucketStart: 50 });
  let samples = 0;
  for (let index = 0; index < 150; index++) {
    const user = `missing_${index}`, missing = simulateAllocation(user, [a, b], t, {});
    const ranking = missing.decisions.find(decision => decision.layerId === 'ranking');
    if (!ranking) continue;
    samples++;
    assert.equal(ranking.experimentId, null);
    assert.equal(ranking.audienceStatus, 'unknown');
    assert.match(ranking.reason, /资格未验证/);
    const opposite = ranking.bucket < 50 ? { registration_days: 100 } : { registration_days: 0 };
    const filtered = simulateAllocation(user, [a, b], t, opposite).decisions.find(decision => decision.layerId === 'ranking');
    assert.equal(filtered.experimentId, null);
    assert.equal(filtered.bucket, ranking.bucket);
    assert.equal(filtered.audienceStatus, 'not-match');
  }
  assert.ok(samples > 50);
});

test('shared sibling subdomains route uniquely before a child experiment executes and do not fall through to a parent experiment', () => {
  const t = addChild(addChild(base(), 'new-child', 'new-users-v1'), 'old-child', 'returning-users-v1');
  const childExperiments = ['new-child', 'old-child'].map(id => experiment(`inside-${id}`, undefined, { domainId: id, layerId: `${id}-layer` }));
  for (let index = 0; index < 80; index++) {
    const user = `children_${index}`;
    for (const [days, selected, skipped] of [[3, 'new-child', 'old-child'], [30, 'old-child', 'new-child']]) {
      const result = simulateAllocation(user, childExperiments, t, { registration_days: days });
      assert.equal(result.error, undefined);
      if (!result.enteredDomains.includes('overlap')) continue;
      assert.ok(result.enteredDomains.includes(selected));
      assert.ok(!result.enteredDomains.includes(skipped));
      assert.equal(result.decisions.filter(decision => decision.experimentId?.startsWith('inside-')).length, 1);
    }
    const missing = simulateAllocation(user, childExperiments, t);
    assert.ok(!missing.enteredDomains.includes('new-child') && !missing.enteredDomains.includes('old-child'));
  }
  const mixed = addChild(base(), 'old-child', 'returning-users-v1');
  const parent = experiment('direct-new', 'new-users-v1'), child = experiment('inside-old', undefined, { domainId: 'old-child', layerId: 'old-child-layer' });
  for (let index = 0; index < 30; index++) {
    const result = simulateAllocation(`mixed-child_${index}`, [parent, child], mixed, { registration_days: 40 });
    assert.ok(!result.decisions.some(decision => decision.experimentId === parent.id));
  }
});

test('audience catalog registration creates immutable versions and rejects unknown references without changing old experiments', () => {
  const t = base(), before = structuredClone(t), history = structuredClone(initialExperiments);
  const v1 = ok(planAudienceRegistration(input(), t));
  const v2 = ok(planAudienceRegistration(input({ id: 'country-cn-v2', version: 2, rules: [rule('country', 'in', ['CN', 'SG'])] }), v1));
  assert.deepEqual(t, before);
  assert.deepEqual(initialExperiments, history);
  assert.equal(getAudience('country-cn-v1', v2).rules[0].value, 'CN');
  assert.deepEqual(getAudience('country-cn-v2', v2).rules[0].value, ['CN', 'SG']);
  rejected(planAudienceRegistration(input(), v2), /已存在/);
  rejected(planAudienceRegistration(input({ id: 'new-id', version: 1 }), v2), /版本号/);
  const domainInvalid = structuredClone(v2); domainInvalid.domains.find(domain => domain.id === 'overlap').audienceId = 'unknown';
  assert.match(validateTopology(domainInvalid), /未知受众版本/);
  assert.match(validateAllocation(experiment('unknown-reference', 'unknown'), [], v2), /未知受众版本/);
  assert.equal(evaluateAudience(selectionAudience({ audienceId: 'unknown' }, v2)).status, 'unknown');
});

test('legacy topology and default audience behavior load unchanged; rule catalogs and conditional reservations survive refresh', () => {
  const old = browserProcess(`process.stdout.write(JSON.stringify({ topology: traffic.getTopology(), audiences: audiences.getAudienceCatalog(traffic.getTopology()), error: traffic.getTopologyLoadError() }));`, { entries: { 'exp-lab-topology-v1': JSON.stringify(defaultTopology) } });
  assert.equal(old.error, null);
  assert.deepEqual(old.topology, defaultTopology);
  assert.deepEqual(old.audiences, defaultAudiences);
  const t = ok(planAudienceRegistration(input(), base()));
  const experiments = [experiment('new', 'new-users-v1'), experiment('old', 'returning-users-v1')];
  const saved = browserProcess(`
    const error = traffic.saveTopology(input.topology, input.experiments);
    process.stdout.write(JSON.stringify({ error, topology: traffic.getTopology(), entries: Object.fromEntries(values) }));
  `, { topology: t, experiments });
  assert.equal(saved.error, null);
  const loaded = browserProcess(`process.stdout.write(JSON.stringify({ topology: traffic.getTopology(), error: traffic.getTopologyLoadError(), simulation: traffic.simulateAllocation('stable-user', input.experiments, traffic.getTopology(), {registration_days: 3}) }));`, { entries: saved.entries, experiments });
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.topology, saved.topology);
  assert.deepEqual(loaded.simulation, simulateAllocation('stable-user', experiments, saved.topology, { registration_days: 3 }));
});

test('direct saves cannot change or omit audience versions or mutate an existing domain audience binding', () => {
  const t = ok(planAudienceRegistration(input(), base()));
  t.domains.find(domain => domain.id === 'overlap').audienceId = 'country-cn-v1';
  const result = browserProcess(`
    const before = structuredClone(traffic.getTopology()), bytes = values.get('exp-lab-topology-v1');
    let notifications = 0; traffic.subscribeTopology(() => notifications++);
    const changed = structuredClone(before); changed.audiences.find(item=>item.id==='country-cn-v1').rules=[{field:'country',op:'eq',value:'US'}];
    const omitted = structuredClone(before); delete omitted.audiences;
    const removed = structuredClone(before); removed.audiences=removed.audiences.filter(item=>item.id!=='country-cn-v1'); delete removed.domains.find(item=>item.id==='overlap').audienceId;
    const rebound = structuredClone(before); rebound.domains.find(item=>item.id==='overlap').audienceId='new-users-v1';
    const errors = [changed,omitted,removed,rebound].map(candidate=>traffic.saveTopology(candidate, []));
    process.stdout.write(JSON.stringify({ errors, before, after: traffic.getTopology(), bytes, stored: values.get('exp-lab-topology-v1'), notifications }));
  `, { entries: { 'exp-lab-topology-v1': JSON.stringify(t) } });
  assert.ok(result.errors.every(error => typeof error === 'string' && error.length));
  assert.deepEqual(result.after, result.before);
  assert.equal(result.stored, result.bytes);
  assert.equal(result.notifications, 0);
});

test('storage failure cannot partially publish a new audience version or change deterministic assignments', () => {
  const t = ok(planAudienceRegistration(input(), base()));
  const result = browserProcess(`
    const before = structuredClone(traffic.getTopology()), bytes = values.get('exp-lab-topology-v1');
    let notifications = 0; traffic.subscribeTopology(() => notifications++);
    failStorage = true;
    const error = traffic.saveTopology(input.topology, input.experiments);
    process.stdout.write(JSON.stringify({ error, before, after: traffic.getTopology(), bytes, stored: values.get('exp-lab-topology-v1'), notifications }));
  `, { topology: t, experiments: initialExperiments, entries: { 'exp-lab-topology-v1': JSON.stringify(defaultTopology) } });
  assert.match(result.error, /存储失败/);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.stored, result.bytes);
  assert.equal(result.notifications, 0);
  for (let index = 0; index < 50; index++) assert.deepEqual(simulateAllocation(`legacy-stability_${index}`, initialExperiments, t), simulateAllocation(`legacy-stability_${index}`, initialExperiments, defaultTopology));
});

test('audience names identify a single family while successive immutable versions may retain that name', () => {
  const t = ok(planAudienceRegistration(input({ name: 'Country CN' }), base()));
  rejected(planAudienceRegistration(input({ id: 'another-v1', familyId: 'another', name: '  country   cn ' }), t), /同名/);
  assert.equal(planAudienceRegistration(input({ id: 'country-cn-v2', name: 'Country CN', version: 2 }), t).error, null);
  rejected(planAudienceRegistration(input({ name: 'x'.repeat(61) }), base()), /最多 60/);
  rejected(planAudienceRegistration(input({ description: 'x'.repeat(301) }), base()), /最多 300/);
});

test('changing a domain or layer parent cannot bypass audience immutability through inherited qualification', () => {
  let t = ok(planAudienceRegistration(input({ id: 'member-v1', familyId: 'members', name: '会员', rules: [rule('is_member', 'eq', true)] }), base()));
  t = ok(planAudienceRegistration(input({ id: 'nonmember-v1', familyId: 'nonmembers', name: '非会员', rules: [rule('is_member', 'eq', false)] }), t));
  t.domains = t.domains.filter(domain => domain.id === 'root');
  t.layers = t.layers.filter(layer => layer.id === 'root-layer');
  addChild(t, 'members', 'member-v1', { parentLayerId: 'root-layer', mode: 'non-overlapping' });
  addChild(t, 'nonmembers', 'nonmember-v1', { parentLayerId: 'root-layer', mode: 'non-overlapping' });
  addChild(t, 'nested', undefined, { parentLayerId: 'members-layer' });
  assert.equal(validateTopology(t), null);
  const moved = structuredClone(t); moved.domains.find(domain => domain.id === 'nested').parentLayerId = 'nonmembers-layer';
  assert.equal(validateTopology(moved), null);
  assert.notDeepEqual(domainEffectiveAudience('nested', moved).rules, domainEffectiveAudience('nested', t).rules);
  const result = browserProcess(`
    const before = structuredClone(traffic.getTopology()), bytes = values.get('exp-lab-topology-v1');
    const error = traffic.saveTopology(input.moved, []);
    const swapped = structuredClone(before);
    swapped.layers.find(layer => layer.id === 'members-layer').domainId = 'nonmembers';
    swapped.layers.find(layer => layer.id === 'nonmembers-layer').domainId = 'members';
    const structuralError = traffic.validateTopology(swapped, []);
    const layerError = traffic.saveTopology(swapped, []);
    process.stdout.write(JSON.stringify({ error, structuralError, layerError, before, after: traffic.getTopology(), bytes, stored: values.get('exp-lab-topology-v1') }));
  `, { moved, entries: { 'exp-lab-topology-v1': JSON.stringify(t) } });
  assert.match(result.error, /更换父层/);
  assert.equal(result.structuralError, null);
  assert.match(result.layerError, /更换所属域/);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.stored, result.bytes);
});
