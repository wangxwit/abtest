import { isJsonValue } from './parameter-definitions.ts';

export type ExecutionBinding = {
  id: string; target: 'frontend' | 'backend' | 'strategy'; system: string; owner: string;
  parameterKeys: string[]; artifactRefs: string[];
};
export type ParameterRule = { id: string; ifKey: string; ifValue: string; thenKey: string; thenValue: string };
export type Coordination = { bindings: ExecutionBinding[]; rules: ParameterRule[] };
type Candidate = { coordination?: Coordination; parameterKeys: string[]; variants: { name: string; value: string }[] };
const present = (value: unknown, max = 80): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
const targets = ['frontend', 'backend', 'strategy'];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Checks a single variant bundle. Bindings are consumers, never separate randomization units. */
export function validateCoordination(experiment: Candidate): string | null {
  const contract = experiment.coordination;
  if (contract === undefined) return null;
  if (!contract || !Array.isArray(contract.bindings) || !Array.isArray(contract.rules)) return '联动契约格式无效。';
  if (contract.bindings.length < 2 || contract.bindings.length > 8) return '联动实验需配置 2–8 个执行绑定。';
  if (!Array.isArray(experiment.parameterKeys) || !experiment.parameterKeys.length || experiment.parameterKeys.some(key => !present(key)) || new Set(experiment.parameterKeys).size !== experiment.parameterKeys.length) return '联动实验必须声明非空且不重复的参数集合。';
  if (!Array.isArray(experiment.variants) || !experiment.variants.length) return '联动实验缺少版本配置。';
  const bindingIds = new Set<string>(), systems = new Set<string>(), usedTargets = new Set<string>(), covered = new Set<string>();
  for (const binding of contract.bindings) {
    if (!binding || !present(binding.id) || bindingIds.has(binding.id)) return '执行绑定标识不能为空或重复。';
    bindingIds.add(binding.id);
    if (!targets.includes(binding.target)) return '执行端须为前端、后端或算法。';
    usedTargets.add(binding.target);
    if (!present(binding.system) || !present(binding.owner, 60)) return '每个执行绑定都需填写系统名称与负责人。';
    const systemKey = `${binding.target}:${binding.system.trim().toLowerCase()}`;
    if (systems.has(systemKey)) return '同一执行端的系统不能重复绑定。';
    systems.add(systemKey);
    if (!Array.isArray(binding.parameterKeys) || !binding.parameterKeys.length || new Set(binding.parameterKeys).size !== binding.parameterKeys.length || binding.parameterKeys.some(key => !experiment.parameterKeys.includes(key))) return `「${binding.system}」需选择不重复的参数，且只能消费本实验声明的参数。`;
    binding.parameterKeys.forEach(key => covered.add(key));
    if (!Array.isArray(binding.artifactRefs) || binding.artifactRefs.length !== experiment.variants.length || binding.artifactRefs.some(ref => !present(ref, 200))) return `「${binding.system}」必须为每个实验版本填写实现标识。`;
  }
  if (usedTargets.size < 2) return '多端联动契约至少包含两类执行端。';
  const missing = experiment.parameterKeys.filter(key => !covered.has(key));
  if (missing.length) return `以下实验参数尚未绑定消费端：${missing.join('、')}。`;
  for (const variant of experiment.variants) {
    try {
      const payload = JSON.parse(variant?.value);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !isJsonValue(payload)) throw new Error();
      if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify([...experiment.parameterKeys].sort())) return `「${variant.name}」必须完整配置已声明的参数，不能遗漏或增加参数。`;
    } catch { return `「${variant?.name ?? '版本'}」的联动参数必须是有效 JSON 对象。`; }
  }
  return validateParameterRules({ ...experiment, parameterRules: contract.rules });
}

/** Business value constraints are independent of services, tags and execution bindings. */
export function validateParameterRules(experiment: {
  parameterRules?: ParameterRule[]; parameterKeys: string[]; variants: { name: string; value: string }[];
}): string | null {
  if (experiment.parameterRules === undefined) return null;
  if (!Array.isArray(experiment.parameterRules)) return '参数组合约束格式无效。';
  if (experiment.parameterRules.length === 0) return null;
  if (!Array.isArray(experiment.parameterKeys) || !experiment.parameterKeys.length || experiment.parameterKeys.some(key => !present(key)) || new Set(experiment.parameterKeys).size !== experiment.parameterKeys.length) return '参数组合约束需要非空且不重复的参数集合。';
  if (!Array.isArray(experiment.variants) || !experiment.variants.length) return '参数组合约束缺少版本配置。';
  if (experiment.parameterRules.length > 12) return '当前最多支持 12 条参数依赖规则。';
  const ruleIds = new Set<string>();
  const rules: { rule: ParameterRule; expectedIf: string; expectedThen: string }[] = [];
  for (const rule of experiment.parameterRules) {
    if (!rule || !present(rule.id) || ruleIds.has(rule.id)) return '参数依赖规则标识不能为空或重复。';
    ruleIds.add(rule.id);
    if (!experiment.parameterKeys.includes(rule.ifKey) || !experiment.parameterKeys.includes(rule.thenKey)) return '依赖规则只能引用本实验声明的参数。';
    try {
      if (typeof rule.ifValue !== 'string' || typeof rule.thenValue !== 'string') throw new Error();
      const a = JSON.parse(rule.ifValue), b = JSON.parse(rule.thenValue);
      if (!isJsonValue(a) || !isJsonValue(b)) throw new Error();
      rules.push({ rule, expectedIf: canonical(a), expectedThen: canonical(b) });
    } catch { return '依赖规则的条件值和要求值必须是有效的有限 JSON。'; }
  }
  for (const variant of experiment.variants) {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(variant?.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !isJsonValue(parsed)) throw new Error();
      payload = parsed;
    } catch { return `「${variant?.name ?? '版本'}」的联动参数必须是有效 JSON 对象。`; }
    if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify([...experiment.parameterKeys].sort())) return `「${variant.name}」必须完整配置已声明的参数，不能遗漏或增加参数。`;
    for (const { rule, expectedIf, expectedThen } of rules) {
      if (canonical(payload[rule.ifKey]) === expectedIf && canonical(payload[rule.thenKey]) !== expectedThen) return `「${variant.name}」违反联动规则：当 ${rule.ifKey} = ${rule.ifValue} 时，${rule.thenKey} 必须 = ${rule.thenValue}。`;
    }
  }
  return null;
}
