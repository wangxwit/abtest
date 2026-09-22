import type { Variant, VariantRole } from './data';
import { BUCKET_COUNT, trafficToBucketCount } from './bucket-ranges.ts';

export const MAX_EXPERIMENT_VARIANTS = 20;
const hasMetadata = (variant: Variant): boolean => Boolean(variant && (Object.prototype.hasOwnProperty.call(variant, 'id') || Object.prototype.hasOwnProperty.call(variant, 'role')));
export const hasExplicitVariantMetadata = (variants: Variant[]): boolean => variants.some(hasMetadata);

/** Legacy fallback identity is for reading only; no metadata is written into old records. */
export const getVariantId = (variant: Variant, index: number): string => variant.id ?? `legacy-${index + 1}`;
export const getVariantRole = (variant: Variant, index: number): VariantRole => variant.role ?? (index === 0 ? 'control' : 'treatment');
export const getVariantLabel = (variant: Variant, index: number): string => getVariantRole(variant, index) === 'control' ? '对照组' : '实验组';
export const variantLabel = getVariantLabel;
export const getControlVariant = (variants: Variant[]): Variant | undefined => variants.find((variant, index) => getVariantRole(variant, index) === 'control');

export function validateExperimentVariants(variants: Variant[]): string | null {
  if (!Array.isArray(variants) || !variants.length || variants.some(variant => !variant || typeof variant !== 'object' || Array.isArray(variant))) return '实验缺少有效的分组配置。';
  const modern = hasExplicitVariantMetadata(variants);
  if (!modern) {
    // Keep the exact validation and cumulative-percent behavior used by historical records.
    if (variants.some(variant => !Number.isFinite(variant.weight) || variant.weight <= 0) || Math.abs(variants.reduce((sum, variant) => sum + variant.weight, 0) - 100) > 0.00001) return '实验分组权重须大于 0 且合计为 100%。';
    return null;
  }
  if (variants.length < 2 || variants.length > MAX_EXPERIMENT_VARIANTS) return '新实验须配置 2–20 个分组，包含一个对照组和至少一个实验组。';
  const ids = new Set<string>(), names = new Set<string>();
  let controlCount = 0, total = 0;
  for (const variant of variants) {
    if (typeof variant.id !== 'string' || !variant.id || variant.id !== variant.id.trim() || variant.id.length > 80 || ids.has(variant.id)) return '每个新分组必须有非空且不重复的稳定标识，不能混用旧分组格式。';
    ids.add(variant.id);
    if (variant.role !== 'control' && variant.role !== 'treatment') return '每个新分组必须明确指定为对照组或实验组。';
    if (variant.role === 'control') controlCount++;
    if (typeof variant.name !== 'string' || !variant.name.trim() || variant.name.length > 60) return '分组名称不能为空，且不能超过 60 个字符。';
    const normalizedName = variant.name.trim().toLowerCase();
    if (names.has(normalizedName)) return '同一实验内的分组名称不能重复。';
    names.add(normalizedName);
    const count = trafficToBucketCount(variant.weight);
    if (count === null) return '每个分组权重须为 0.01–100%，最多保留两位小数。';
    total += count;
  }
  if (controlCount !== 1) return '每个实验必须且只能有一个对照组，其余为实验组。';
  if (total !== BUCKET_COUNT) return '所有分组的权重合计必须恰好为 100%。';
  return null;
}

/** Selection uses the existing experiment hash and persisted array order, never a role or variant ID hash. */
export function selectExperimentVariant(variants: Variant[], bucket: number): Variant | undefined {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket >= BUCKET_COUNT || validateExperimentVariants(variants)) return undefined;
  const modern = hasExplicitVariantMetadata(variants);
  let cumulative = 0;
  return variants.find(variant => {
    cumulative += modern ? trafficToBucketCount(variant.weight)! : variant.weight;
    return (modern ? bucket : bucket / 100) < cumulative;
  });
}
