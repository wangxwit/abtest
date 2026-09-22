import type { Topology } from './traffic';

/** Operational metadata only: these fields never change allocation eligibility. */
export type ResourceManagement = {
  owner: string;
  usageType: 'long-term' | 'temporary';
  expectedEndDate?: string;
};
export type ResourceDueStatus = 'unmanaged' | 'long-term' | 'scheduled' | 'due-today' | 'overdue';

export function defaultResourceManagement(owner = '陈思远'): ResourceManagement {
  return { owner: owner.trim(), usageType: 'long-term' };
}

/** Use the browser's local calendar day, rather than a UTC ISO timestamp. */
export function localDateString(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError('日期无效。');
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function validateResourceManagement(value: unknown): string | null {
  // Existing resources remain valid without inventing an owner or an end date.
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '资源管理信息格式无效。';
  const management = value as Record<string, unknown>;
  if (typeof management.owner !== 'string' || !management.owner.trim()) return '请填写负责人。';
  if (management.owner.trim().length > 40) return '负责人不能超过 40 个字符。';
  if (management.usageType !== 'long-term' && management.usageType !== 'temporary') return '请选择长期或临时资源。';
  if (management.usageType === 'temporary' && !isCalendarDate(management.expectedEndDate)) return '临时资源需填写有效的预计结束日期（YYYY-MM-DD）。';
  if (management.usageType === 'long-term' && management.expectedEndDate !== undefined) return '长期资源不应设置预计结束日期。';
  return null;
}

export function resourceDueStatus(management: ResourceManagement | undefined, today = localDateString()): ResourceDueStatus {
  if (!management || validateResourceManagement(management)) return 'unmanaged';
  if (management.usageType === 'long-term') return 'long-term';
  if (!isCalendarDate(today)) throw new RangeError('当前日期无效。');
  return management.expectedEndDate! < today ? 'overdue' : management.expectedEndDate === today ? 'due-today' : 'scheduled';
}

/** Clone one snapshot and update one node. Child metadata does not inherit later edits. */
export function planResourceManagementUpdate(kind: 'domain' | 'layer', id: string, management: ResourceManagement, topology: Topology): { topology: Topology | null; error: string | null } {
  const reject = (error: string) => ({ topology: null, error });
  const invalid = validateResourceManagement(management);
  if (invalid) return reject(invalid);
  if (management === undefined) return reject('请填写资源管理信息。');
  if (!topology || !Array.isArray(topology.domains) || !Array.isArray(topology.layers)) return reject('层域配置格式无效。');
  if (kind !== 'domain' && kind !== 'layer') return reject('资源类型无效。');
  const nodes = kind === 'domain' ? topology.domains : topology.layers;
  if (!nodes.some(node => node?.id === id)) return reject('所选层域资源不存在，请重新选择。');
  const next = structuredClone(topology);
  const target = (kind === 'domain' ? next.domains : next.layers).find(node => node.id === id)!;
  target.management = { owner: management.owner.trim(), usageType: management.usageType, ...(management.usageType === 'temporary' ? { expectedEndDate: management.expectedEndDate } : {}) };
  return { topology: next, error: null };
}
