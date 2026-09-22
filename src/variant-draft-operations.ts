import { isJsonValue } from './parameter-definitions.ts';
import { analyzeParameterJson } from './json-parameter-analysis.ts';

export type DraftExperimentVariant = { id: string; name: string; role: 'control' | 'treatment'; weight: number; value: string };

/** Explicit editor action only: existing published assignments are never rebalanced. */
export function equalVariantWeights(count: number): number[] {
  if (!Number.isInteger(count) || count < 2 || count > 20) throw new Error('实验需有 2–20 个分组。');
  const base = Math.floor(10000 / count), remainder = 10000 % count;
  return Array.from({ length: count }, (_, index) => (base + (index < remainder ? 1 : 0)) / 100);
}

/** Prepare every group's payload before applying a bulk addition, preserving existing values. */
export function addParametersToVariants<T extends { value: string }>(variants: T[], defaults: Record<string, unknown>): T[] {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || !isJsonValue(defaults)) throw new Error('新增参数默认值必须是有效的有限 JSON 对象。');
  return variants.map(variant => {
    const analysis = analyzeParameterJson(variant.value);
    if (!analysis.valid || !analysis.value) {
      const diagnostic = analysis.diagnostics.find(item => item.severity === 'error');
      throw new Error(`请先修正所有分组的有限 JSON 对象，再添加参数。${diagnostic?.message ?? ''}`);
    }
    return { ...variant, value: JSON.stringify({ ...defaults, ...analysis.value }, null, 2) };
  });
}
