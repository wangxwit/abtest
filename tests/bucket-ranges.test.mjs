import test from 'node:test';
import assert from 'node:assert/strict';

let implementation;
try { implementation = await import('../src/bucket-ranges.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
function api() { assert.ok(implementation, 'Fixed bucket range helpers are not implemented'); return implementation; }

test('traffic is represented by 1 to 10000 integer buckets with at most two percentage decimals', () => {
  const { BUCKET_COUNT, trafficToBucketCount } = api();
  assert.equal(BUCKET_COUNT, 10000);
  for (const [traffic, count] of [[0.01, 1], [0.29, 29], [1.01, 101], [33.33, 3333], [100, 10000]]) assert.equal(trafficToBucketCount(traffic), count);
  for (const traffic of [0, -1, 100.01, 0.001, 1.001, NaN, Infinity, '1', null]) assert.equal(trafficToBucketCount(traffic), null);
});

test('legacy percent intervals preserve the exact old discrete membership predicate', () => {
  const { getBucketRanges } = api();
  for (const [start, traffic] of [[0, 100], [60, 20], [0.1 + 0.2, 1], [49.995, 0.01], [99.99, 0.01]]) {
    const ranges = getBucketRanges({ start, traffic });
    for (let bucket = 0; bucket < 10000; bucket++) assert.equal(ranges.some(range => bucket >= range.start && bucket < range.end), bucket / 100 >= start && bucket / 100 < start + traffic, `${start}, ${traffic}, bucket ${bucket}`);
    assert.deepEqual(getBucketRanges({ bucketStart: start, traffic }), ranges);
  }
  assert.deepEqual(getBucketRanges({ bucketStart: 0, traffic: 0 }), []);
});

test('explicit ranges retain holes, are detached from source, and report integer half-open coordinates', () => {
  const { getBucketRanges, bucketCount, formatBucketRanges, validateBucketAllocation } = api();
  const allocation = { bucketStart: 10, traffic: 15, bucketRanges: [{ start: 1000, end: 2000 }, { start: 8000, end: 8500 }] };
  const ranges = getBucketRanges(allocation);
  assert.deepEqual(ranges, allocation.bucketRanges);
  assert.equal(bucketCount(ranges), 1500);
  assert.equal(formatBucketRanges(ranges), '[1000, 2000) ∪ [8000, 8500)');
  assert.equal(validateBucketAllocation(allocation), null);
  ranges[0].end = 1001;
  assert.equal(allocation.bucketRanges[0].end, 2000);
});

test('invalid explicit ranges never fall back to an otherwise valid legacy interval', () => {
  const { getBucketRanges, validateBucketAllocation } = api();
  const invalidRanges = [undefined, null, [], '0:1000', [{ start: 0, end: 1000.1 }], [{ start: -1, end: 999 }], [{ start: 0, end: 10001 }], [{ start: 0, end: 0 }], [{ start: 0, end: 500 }, { start: 0, end: 500 }], [{ start: 0, end: 600 }, { start: 500, end: 900 }], [{ start: 500, end: 1000 }, { start: 0, end: 500 }], [{ start: 0, end: 999 }], [{ start: 1, end: 1001 }], [null]];
  for (const bucketRanges of invalidRanges) {
    const allocation = { traffic: 10, bucketStart: 0, bucketRanges };
    assert.ok(validateBucketAllocation(allocation), JSON.stringify(bucketRanges));
    assert.deepEqual(getBucketRanges(allocation), [], 'Invalid modern data must not fall back');
  }
});
