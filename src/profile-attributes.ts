import type { Topology } from './traffic';

export type ProfileAttribute = { key: string; label: string; type: 'enum' | 'number' | 'boolean' | 'string'; values?: string[]; description: string; serviceId?: string | null; unit?: string; integer?: boolean; createdAt: string };
export type NewProfileAttributeInput = Omit<ProfileAttribute, 'createdAt' | 'serviceId'>;
const createdAt = '2026-09-12T00:00:00.000Z';
const builtin = (key: string, label: string, type: ProfileAttribute['type'], extra: Partial<ProfileAttribute> = {}): ProfileAttribute => ({ key, label, type, description: '固定入组画像属性；内置枚举保留旧规则的开放取值兼容。', serviceId: null, createdAt, ...extra });
export const defaultProfileAttributes: ProfileAttribute[] = [
  builtin('country', '国家 / 地区代码', 'enum', { values: ['CN', 'US', 'JP', 'SG', 'GB'] }),
  builtin('platform', '入组平台', 'enum', { values: ['iOS', 'Android', 'Web'] }),
  builtin('is_member', '入组时是否会员', 'boolean'),
  builtin('registration_days', '入组时注册天数', 'number', { unit: '天', integer: true }),
  builtin('spend_30d', '入组前 30 天消费', 'number', { unit: '元', integer: false }),
  builtin('last_active_days', '入组时距上次活跃天数', 'number', { unit: '天', integer: true }),
];
export const isBuiltinProfileAttribute = (key: string): boolean => defaultProfileAttributes.some(attribute => attribute.key === key);
export const getProfileAttributes = (t: Topology): ProfileAttribute[] => t.profileAttributes ?? structuredClone(defaultProfileAttributes);
export const getProfileAttribute = (key: string, t: Topology) => getProfileAttributes(t).find(attribute => attribute.key === key);
export const isSafeProfileKey = (key: unknown): key is string => typeof key === 'string' && key.length <= 100 && /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(key) && !key.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function validateProfileAttributeCatalog(t: Topology): string | null {
  if (t.profileAttributes !== undefined && !Array.isArray(t.profileAttributes)) return '画像属性目录格式无效。';
  const attrs = getProfileAttributes(t), seen = new Set<string>();
  for (const attribute of attrs) {
    if (!attribute || typeof attribute !== 'object' || !isSafeProfileKey(attribute.key) || seen.has(attribute.key)) return '画像属性 Key 必须安全、有效且唯一。';
    seen.add(attribute.key);
    if (typeof attribute.label !== 'string' || !attribute.label.trim() || attribute.label.length > 60 || typeof attribute.description !== 'string' || attribute.description.length > 300 || !['enum', 'number', 'boolean', 'string'].includes(attribute.type) || typeof attribute.createdAt !== 'string' || !Number.isFinite(Date.parse(attribute.createdAt))) return '画像属性名称、类型、说明或创建时间无效。';
    const seed = defaultProfileAttributes.find(item => item.key === attribute.key);
    if (seed && !same(seed, attribute)) return '内置画像属性不能修改。';
    if (!seed && !attribute.description.trim()) return '自定义画像属性必须填写统计口径说明。';
    if (attribute.serviceId !== undefined && attribute.serviceId !== null && typeof attribute.serviceId !== 'string') return '历史画像属性元数据格式无效。';
    if (attribute.type === 'enum') {
      if (!Array.isArray(attribute.values) || !attribute.values.length || attribute.values.length > 100 || attribute.values.some(value => typeof value !== 'string' || !value.trim() || value.trim() !== value) || new Set(attribute.values).size !== attribute.values.length) return '枚举画像属性需要 1–100 个不重复的非空取值。';
    } else if (attribute.values !== undefined) return '只有枚举画像属性可以定义取值集合。';
    if (attribute.integer !== undefined && (attribute.type !== 'number' || typeof attribute.integer !== 'boolean')) return '整数约束仅适用于数值画像属性。';
    if (attribute.unit !== undefined && (attribute.type !== 'number' || typeof attribute.unit !== 'string' || !attribute.unit.trim() || attribute.unit.length > 20)) return '计量单位仅适用于数值画像属性，且最多 20 字。';
  }
  if (t.profileAttributes !== undefined && defaultProfileAttributes.some(seed => !attrs.some(attribute => same(attribute, seed)))) return '保存时必须保留全部内置画像属性。';
  return null;
}
export function validateProfileAttributeTransition(previous: Topology, next: Topology): string | null {
  if (previous.profileAttributes !== undefined && next.profileAttributes === undefined) return '保存时必须保留已有画像属性目录。';
  for (const attribute of getProfileAttributes(previous)) if (!same(getProfileAttribute(attribute.key, next), attribute)) return '已登记画像属性的定义及历史元数据不能修改或删除，请登记新属性。';
  return null;
}
export function planProfileAttributeRegistration(input: NewProfileAttributeInput, t: Topology): { topology: Topology | null; error: string | null } {
  const reject = (error: string) => ({ topology: null, error });
  const oldError = validateProfileAttributeCatalog(t); if (oldError) return reject(oldError);
  if (!input) return reject('画像属性登记格式无效。');
  if (!isSafeProfileKey(input.key) || getProfileAttribute(input.key, t)) return reject('画像属性 Key 不合法或已存在。');
  const { serviceId: _legacySource, ...definition } = input as NewProfileAttributeInput & { serviceId?: unknown };
  const attribute: ProfileAttribute = { ...structuredClone(definition), label: input.label?.trim(), createdAt: new Date().toISOString() };
  for (const key of ['values', 'integer', 'unit'] as const) if (attribute[key] === undefined) delete attribute[key];
  const next: Topology = { ...structuredClone(t), profileAttributes: [...structuredClone(getProfileAttributes(t)), attribute] };
  const error = validateProfileAttributeCatalog(next); return error ? reject(error) : { topology: next, error: null };
}
/** Own values only: inherited object properties are not observed user attributes. */
export function profileValueIsValid(attribute: ProfileAttribute, value: unknown): value is string | number | boolean {
  if (!['enum', 'number', 'boolean', 'string'].includes(attribute.type)) return false;
  if (attribute.type === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!attribute.integer || Number.isInteger(value));
  if (attribute.type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'string' || !value.trim()) return false;
  return attribute.type !== 'enum' || isBuiltinProfileAttribute(attribute.key) || (Array.isArray(attribute.values) && attribute.values.includes(value));
}
