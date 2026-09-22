import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as traffic from '../src/traffic.ts';
import { initialExperiments } from '../src/data.ts';
import { getBucketRanges, bucketInRanges } from '../src/bucket-ranges.ts';

const base = () => structuredClone(traffic.defaultTopology);
function experiment(id, changes = {}) {
  return { ...structuredClone(initialExperiments.find(item => item.layerId === 'ranking' && item.status === 'running')), id, key: id, name: id, traffic: 30, bucketStart: 0, audience: '全部活跃用户', ...changes };
}
function allocate(...args) { assert.equal(typeof traffic.findAvailableBucketRanges, 'function', 'Multi-range allocator is not implemented'); return traffic.findAvailableBucketRanges(...args); }
function addChild(t, ranges = [{ start: 1000, end: 2000 }, { start: 6000, end: 7000 }]) {
  t.domains.push({ id: 'segmented-child', name: '离散子域', mode: 'overlapping', parentLayerId: 'ranking', traffic: 20, start: 10, bucketRanges: ranges, unit: 'user_id', description: '' });
  t.layers.push({ id: 'segmented-layer', name: '初始参数层', domainId: 'segmented-child', parameterKeys: ['*'], role: 'normal', description: '' });
  return t;
}

test('fragmented capacity is combined deterministically without moving existing reservations', () => {
  const t = base(), existing = [experiment('first'), experiment('middle', { bucketStart: 40 }), experiment('last', { bucketStart: 80, traffic: 10, status: 'paused' })];
  const before = JSON.stringify({ t, existing });
  assert.deepEqual(allocate('ranking', 25, existing, undefined, t), [{ start: 3000, end: 4000 }, { start: 7000, end: 8000 }, { start: 9000, end: 9500 }]);
  assert.deepEqual(allocate('ranking', 30, [...existing].reverse(), undefined, t), [{ start: 3000, end: 4000 }, { start: 7000, end: 8000 }, { start: 9000, end: 10000 }]);
  assert.equal(allocate('ranking', 30.01, existing, undefined, t), null);
  assert.equal(traffic.findAvailableStart('ranking', 15, existing, undefined, t), null, 'Legacy helper still requests one contiguous range');
  assert.equal(JSON.stringify({ t, existing }), before);
});

test('one bucket and full capacity are supported while empty layers and invalid precision are refused', () => {
  const t = base();
  assert.deepEqual(allocate('ranking', 0.01, [], undefined, t), [{ start: 0, end: 1 }]);
  assert.deepEqual(allocate('ranking', 100, [], undefined, t), [{ start: 0, end: 10000 }]);
  const tiny = experiment('tiny', { traffic: 0.01, bucketRanges: [{ start: 0, end: 1 }] });
  assert.equal(traffic.validateAllocation(tiny, [], t), null);
  assert.deepEqual(allocate('ranking', 0.01, [tiny], undefined, t), [{ start: 1, end: 2 }]);
  assert.equal(allocate('ranking', 0.001, [], undefined, t), null);
  t.layers.push({ id: 'empty-v19', name: '空层', domainId: 'overlap', parameterKeys: [], description: '' });
  assert.equal(allocate('empty-v19', 0.01, [], undefined, t), null);
});

test('parent-layer experiments and child domains conflict only on actual shared ranges, including later segments', () => {
  const t = addChild(base()), hole = experiment('hole', { bucketStart: 30, traffic: 10 });
  assert.equal(traffic.validateTopology(t, [hole]), null);
  assert.equal(traffic.validateAllocation(hole, [], t), null);
  assert.equal(traffic.layerUsage('ranking', [hole], t), 30);
  assert.deepEqual(traffic.layerAudienceCapacity('ranking', [hole], t), { occupied: 30, available: 70, largestFree: 30, reusable: 0, nominalOccupied: 30 });
  const collision = experiment('second-segment', { bucketStart: 65, traffic: 1 });
  assert.match(traffic.validateTopology(t, [collision]), /重叠/);
  assert.match(traffic.validateAllocation(collision, [], t), /包括子域/);
  const both = experiment('both-segments', { bucketStart: 15, traffic: 10, bucketRanges: [{ start: 1500, end: 2000 }, { start: 6500, end: 7000 }] });
  const conflicts = traffic.explainAllocationConflicts(both, [], t);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].bucketRanges, both.bucketRanges);
});

test('disjoint fixed audiences can reuse all ranges; uncertain or matching audiences cannot', () => {
  const t = base(), a = experiment('new-users', { audienceId: 'new-users-v1', traffic: 60, bucketRanges: [{ start: 0, end: 3000 }, { start: 7000, end: 10000 }] });
  assert.deepEqual(allocate('ranking', 100, [a], undefined, t, { audienceId: 'returning-users-v1' }), [{ start: 0, end: 10000 }]);
  assert.deepEqual(allocate('ranking', 40, [a], undefined, t, { audienceId: 'new-users-v1' }), [{ start: 3000, end: 7000 }]);
  assert.equal(allocate('ranking', 40.01, [a], undefined, t), null);
  assert.equal(allocate('ranking', 100, [a], undefined, t, { audienceId: 'unknown-version' }), null);
  assert.equal(traffic.layerUsage('ranking', [a, experiment('old-users', { audienceId: 'returning-users-v1', traffic: 100 })], t), 100);
});

test('simulation respects multi-range holes and keeps independent experiment variant hashes', () => {
  const t = base(), ranges = [{ start: 1000, end: 2000 }, { start: 6000, end: 7000 }];
  const segmented = experiment('stable-variants', { bucketStart: 10, traffic: 20, bucketRanges: ranges });
  const full = { ...segmented, bucketStart: 0, traffic: 100 }; delete full.bucketRanges;
  const seen = new Set();
  for (let i = 0; i < 160; i++) {
    const unit = `v19_variant_${i}`, result = traffic.simulateAllocation(unit, [segmented], t);
    assert.equal(result.error, undefined);
    const decision = result.decisions.find(item => item.layerId === 'ranking');
    if (!decision) continue;
    const bucket = Math.round(decision.bucket * 100), expected = bucketInRanges(bucket, ranges);
    assert.equal(decision.experimentId === segmented.id, expected, `bucket ${bucket}`);
    if (expected) {
      seen.add(bucket < 2000 ? 'first' : 'second');
      const baseline = traffic.simulateAllocation(unit, [full], t).decisions.find(item => item.layerId === 'ranking');
      assert.equal(decision.variant, baseline.variant);
      assert.deepEqual(decision.parameters, baseline.parameters);
    } else if (bucket >= 2000 && bucket < 6000) seen.add('hole');
  }
  assert.deepEqual([...seen].sort(), ['first', 'hole', 'second']);
});

test('recursive simulation enters both child segments but skips the hole without trying another parent bucket', () => {
  const t = addChild(base()), child = experiment('child-hit', { domainId: 'segmented-child', layerId: 'segmented-layer', traffic: 100 });
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const result = traffic.simulateAllocation(`v19_child_${i}`, [child], t);
    assert.equal(result.error, undefined);
    const parent = result.decisions.find(item => item.layerId === 'ranking');
    if (!parent) continue;
    const bucket = Math.round(parent.bucket * 100), entered = bucketInRanges(bucket, getBucketRanges(t.domains.at(-1)));
    assert.equal(result.enteredDomains.includes('segmented-child'), entered);
    assert.equal(result.decisions.some(item => item.experimentId === child.id), entered);
    if (entered) {
      assert.equal(parent.childDomainId, 'segmented-child');
      assert.equal(parent.experimentId, null);
      seen.add(bucket < 2000 ? 'first' : 'second');
    } else if (bucket >= 2000 && bucket < 6000) seen.add('hole');
  }
  assert.deepEqual([...seen].sort(), ['first', 'hole', 'second']);
});

test('adding explicit legacy ranges does not change old root, nested, experiment or version assignments', () => {
  const old = base(), modern = structuredClone(old);
  for (const domain of modern.domains) domain.bucketRanges = getBucketRanges(domain);
  const experiments = structuredClone(initialExperiments), modernExperiments = experiments.map(item => item.traffic ? { ...item, bucketRanges: getBucketRanges(item) } : item);
  const signature = result => ({ error: result.error, entered: result.enteredDomains, decisions: result.decisions.map(({ layerId, bucket, childDomainId, experimentId, variant, parameters }) => ({ layerId, bucket, childDomainId, experimentId, variant, parameters })), parameters: result.mergedParameters });
  for (let i = 0; i < 150; i++) assert.deepEqual(signature(traffic.simulateAllocation(`v19_legacy_${i}`, modernExperiments, modern)), signature(traffic.simulateAllocation(`v19_legacy_${i}`, experiments, old)));
  assert.ok(old.domains.every(domain => !('bucketRanges' in domain)));
});

test('legacy continuous traffic with more than two decimals keeps its exact bucket membership while new requests reject that precision', () => {
  const t = base(), legacy = experiment('legacy-fractional-traffic', { traffic: 1.001 });
  assert.deepEqual(getBucketRanges(legacy), [{ start: 0, end: 101 }]);
  assert.equal(traffic.validateTopology(t, [legacy]), null);
  assert.equal(traffic.validateAllocation(legacy, [legacy], t), null);
  assert.equal(allocate('ranking', 1.001, [], undefined, t), null);
  assert.deepEqual(allocate('ranking', 0.01, [legacy], undefined, t), [{ start: 101, end: 102 }]);
  assert.ok(traffic.validateAllocation({ ...legacy, bucketRanges: [{ start: 0, end: 101 }] }, [], t), 'Explicit modern records must still enforce two-decimal traffic');
  const equivalent = { ...legacy, traffic: 1.01, bucketRanges: [{ start: 0, end: 101 }] };
  let hits = 0;
  for (let i = 0; i < 300; i++) {
    const unit = `legacy_precision_${i}`, before = traffic.simulateAllocation(unit, [legacy], t), after = traffic.simulateAllocation(unit, [equivalent], t);
    assert.equal(before.error, undefined);
    assert.equal(after.error, undefined);
    assert.deepEqual(before.decisions, after.decisions);
    assert.deepEqual(before.mergedParameters, after.mergedParameters);
    if (before.decisions.some(decision => decision.experimentId === legacy.id)) hits++;
  }
  assert.ok(hits > 0, 'The equivalence check must include actual experiment and variant assignments');
});

test('malformed modern ranges fail closed in topology, allocation, planning and simulation', () => {
  const badValues = [[], null, undefined, [{ start: 0, end: 500 }, { start: 0, end: 500 }], [{ start: 0, end: 1000.5 }], [{ start: 0, end: 999 }], [{ start: 1, end: 1001 }]];
  for (const bucketRanges of badValues) {
    const t = base(), e = experiment('malformed', { traffic: 10, bucketRanges });
    assert.ok(traffic.validateAllocation(e, [], t));
    assert.ok(traffic.validateTopology(t, [e]));
    assert.equal(allocate('ranking', 1, [e], undefined, t), null);
    assert.ok(traffic.simulateAllocation('bad', [e], t).error);
    t.domains.find(domain => domain.id === 'overlap').bucketRanges = bucketRanges;
    assert.ok(traffic.validateTopology(t));
  }
});

test('save and reload retain explicit child ranges, and invalid changes leave persisted bytes intact', () => {
  const script = `
    import { readFileSync } from 'node:fs';
    const values = new Map();
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) } });
    const core = await import('./src/traffic.ts');
    const topology = JSON.parse(readFileSync(0, 'utf8'));
    const error = core.saveTopology(topology, []);
    const before = values.get('exp-lab-topology-v1');
    const invalid = structuredClone(core.getTopology());
    invalid.domains.find(d => d.id === 'segmented-child').bucketRanges = [];
    const bad = core.saveTopology(invalid, []);
    const omitted = structuredClone(core.getTopology());
    delete omitted.domains.find(d => d.id === 'segmented-child').bucketRanges;
    const dropped = core.saveTopology(omitted, []);
    const moved = structuredClone(core.getTopology());
    moved.domains.find(d => d.id === 'segmented-child').bucketRanges = [{ start: 1000, end: 2000 }, { start: 8000, end: 9000 }];
    const relocated = core.saveTopology(moved, []);
    const after = values.get('exp-lab-topology-v1');
    const reloaded = await import('./src/traffic.ts?v19-refresh');
    process.stdout.write(JSON.stringify({ error, bad, dropped, relocated, unchanged: before === after, reloaded: reloaded.getTopology().domains.find(d => d.id === 'segmented-child') }));
  `;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), input: JSON.stringify(addChild(base())), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.error, null);
  assert.ok(result.bad);
  assert.ok(result.dropped);
  assert.ok(result.relocated);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.reloaded.bucketRanges, [{ start: 1000, end: 2000 }, { start: 6000, end: 7000 }]);
});

test('explicit experiment records are never silently re-normalized when their old fields are malformed', () => {
  const malformed = experiment('explicit-record', { bucketStart: undefined, bucketRanges: [{ start: 8000, end: 9000 }], traffic: 10 });
  const before = structuredClone(malformed);
  assert.deepEqual(traffic.normalizeExperiments([malformed], base()), [before]);
  assert.ok(traffic.validateTopology(base(), [malformed]));
});

test('capacity differences stay precise at one-bucket granularity and malformed reservations expose no free capacity', () => {
  const t = base(), reservation = experiment('almost-full', { traffic: 99.97, bucketRanges: [{ start: 0, end: 9997 }] });
  assert.equal(traffic.layerAudienceCapacity('ranking', [reservation], t).available, 0.03);
  reservation.bucketRanges = [];
  assert.equal(traffic.layerAudienceCapacity('ranking', [reservation], t).available, 0);
  assert.equal(traffic.findAvailableStart('ranking', 1, [reservation], undefined, t), null);
});
