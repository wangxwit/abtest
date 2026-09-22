export const BUCKET_COUNT = 10000;
export type BucketRange = { start: number; end: number };
export type BucketAllocation = { traffic: number; start?: number; bucketStart?: number; bucketRanges?: BucketRange[] };
const explicitRanges = (allocation: BucketAllocation) => Object.prototype.hasOwnProperty.call(allocation, 'bucketRanges');

export function trafficToBucketCount(traffic: number): number | null {
  if (typeof traffic !== 'number' || !Number.isFinite(traffic) || traffic < 0.01 || traffic > 100) return null;
  const count = Math.round(traffic * 100);
  return Math.abs(count - traffic * 100) <= 1e-9 ? count : null;
}

/** Legacy comparisons used bucket / 100; preserve even their floating-point boundary behavior. */
function legacyBoundary(percent: number): number {
  let low = 0, high = BUCKET_COUNT;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (mid / 100 < percent) low = mid + 1; else high = mid;
  }
  return low;
}

export const bucketCount = (ranges: BucketRange[]): number => ranges.reduce((count, range) => count + range.end - range.start, 0);
export const formatBucketRanges = (ranges: BucketRange[]): string => ranges.length ? ranges.map(range => `[${range.start}, ${range.end})`).join(' ∪ ') : '无桶段';

export function validateBucketAllocation(allocation: BucketAllocation): string | null {
  if (!allocation || typeof allocation !== 'object') return '桶配置格式无效。';
  const start = allocation.bucketStart ?? allocation.start;
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start >= 100) return '桶范围的首段起点无效。';
  if (!explicitRanges(allocation)) {
    if (!Number.isFinite(allocation.traffic) || allocation.traffic <= 0 || allocation.traffic > 100 || start + allocation.traffic > 100) return '连续桶范围超出当前层容量。';
    return null;
  }
  const expected = trafficToBucketCount(allocation.traffic);
  if (expected === null) return '流量须为 0.01–100%，最多保留两位小数。';
  const ranges = allocation.bucketRanges;
  if (!Array.isArray(ranges) || !ranges.length) return '显式桶段必须是非空数组，不能回退到旧连续配置。';
  let previousEnd = -1;
  for (const range of ranges) {
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end > BUCKET_COUNT || range.start >= range.end) return '桶段须为 0–10000 内的整数右开区间。';
    if (range.start < previousEnd) return '桶段必须按起点升序排列，且不能重复或相互重叠。';
    previousEnd = range.end;
  }
  if (bucketCount(ranges) !== expected) return '桶段总数必须与声明的流量比例一致。';
  if (start !== ranges[0].start / 100) return '旧起点字段必须与第一个桶段的起点一致。';
  if (allocation.start !== undefined && allocation.start !== start) return '桶起点字段相互矛盾。';
  return null;
}

/** Invalid explicit data deliberately returns no ranges; allocation validation must reject it. */
export function getBucketRanges(allocation: BucketAllocation): BucketRange[] {
  if (validateBucketAllocation(allocation)) return [];
  if (explicitRanges(allocation)) return allocation.bucketRanges!.map(range => ({ start: range.start, end: range.end }));
  const start = allocation.bucketStart ?? allocation.start!;
  const first = legacyBoundary(start), end = legacyBoundary(start + allocation.traffic);
  return end > first ? [{ start: first, end }] : [];
}

export function unionBucketRanges(ranges: BucketRange[]): BucketRange[] {
  const result: BucketRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

export function intersectBucketRanges(left: BucketRange[], right: BucketRange[]): BucketRange[] {
  const intersections: BucketRange[] = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i].start, right[j].start), end = Math.min(left[i].end, right[j].end);
    if (start < end) intersections.push({ start, end });
    if (left[i].end < right[j].end) i++; else j++;
  }
  return unionBucketRanges(intersections);
}

export const bucketInRanges = (bucket: number, ranges: BucketRange[]): boolean => ranges.some(range => bucket >= range.start && bucket < range.end);
