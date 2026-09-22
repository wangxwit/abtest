export const parameterTypes = ['string', 'number', 'boolean', 'object', 'array'] as const;
export type ParameterType = typeof parameterTypes[number];
export type ParameterDefinition = { key: string; name: string; type: ParameterType; defaultValue: unknown; owner: string; description: string; createdAt: string };
export type NewParameterInput = Omit<ParameterDefinition, 'createdAt'>;

export function isJsonValue(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  const seen = new Set(ancestors).add(value);
  if (Array.isArray(value)) return Array.from(value).every(item => isJsonValue(item, seen, depth + 1));
  return Object.values(value).every(item => isJsonValue(item, seen, depth + 1));
}

/** Top-level types are explicit; object and array contents must be finite JSON values. */
export function validateParameterValue(definition: Pick<ParameterDefinition, 'key' | 'type'>, value: unknown): string | null {
  const type = definition.type;
  if (!parameterTypes.includes(type)) return '参数类型无效。';
  const matches = type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : typeof value === type;
  if (!matches) return `参数 ${definition.key} 的值必须是 ${type} 类型。`;
  if (!isJsonValue(value)) return `参数 ${definition.key} 的值必须是有限、可序列化的 JSON（最多 32 层）。`;
  return null;
}

export function validateParameterDefinition(input: NewParameterInput): string | null {
  if (!input || typeof input.key !== 'string' || input.key.length > 80 || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(input.key)
    || input.key.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) {
    return '参数 Key 须为 3–80 位小写字母、数字、下划线及点号，使用业务前缀（如 ranking.result_limit）；不能使用保留名称。';
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) return '请填写 1–60 字的参数名称。';
  if (typeof input.owner !== 'string' || !input.owner.trim() || input.owner.length > 60) return '请填写 1–60 字的负责人。';
  if (typeof input.description !== 'string' || input.description.length > 300) return '参数说明不能超过 300 字。';
  return validateParameterValue(input, input.defaultValue);
}
