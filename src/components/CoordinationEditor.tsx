import { ArrowRight, Braces, Code2, GitBranch, Link2, Monitor, Plus, Trash2 } from 'lucide-react';
import type { Coordination, ExecutionBinding, ParameterRule } from '../coordination';
import { parameterHref } from '../application-routes';
import './coordination.css';

const targetLabels: Record<ExecutionBinding['target'], string> = { frontend: '前端', backend: '后端', strategy: '算法 / 策略' };
const targetIcons = { frontend: Monitor, backend: Code2, strategy: Braces };
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
function ParameterSelect({ value, onChange, parameterKeys, label }: { value: string; onChange: (value: string) => void; parameterKeys: string[]; label: string }) {
  return <select className="select" aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
    <option value="">选择参数</option>
    {value && !parameterKeys.includes(value) && <option value={value}>{value}（已不在实验中）</option>}
    {parameterKeys.map(key => <option key={key} value={key}>{key}</option>)}
  </select>;
}

export function CoordinationSummary({ coordination, variantNames }: { coordination: Coordination; variantNames: string[] }) {
  return <section className="co-summary card">
    <div className="co-summary-heading"><div><h3><Link2 size={17} />历史联动契约</h3><p>保留旧配置中的执行绑定与实现标识。新实验从参数归属推导涉及服务。</p></div><span>历史兼容 · {coordination.bindings.length} 个执行端</span></div>
    <div className="co-summary-bindings">{coordination.bindings.map((binding, index) => {
      const Icon = targetIcons[binding.target];
      return <div className="co-summary-binding" key={binding.id}>
        <div className="co-summary-binding-title"><span className="co-target-icon"><Icon size={17} /></span><div><strong>{binding.system || `执行端 ${index + 1}`}</strong><small>{targetLabels[binding.target]} · 负责人：{binding.owner || '未填写'}</small></div></div>
        <div className="co-summary-keys">{binding.parameterKeys.length ? binding.parameterKeys.map(key => <a key={key} href={parameterHref(key)}><code>{key}</code></a>) : <span>未分配参数</span>}</div>
        <dl className="co-summary-artifacts">{variantNames.map((name, variantIndex) => <div key={`${variantIndex}-${name}`}><dt>{name}</dt><dd><code>{binding.artifactRefs[variantIndex] || '未填写实现标识'}</code></dd></div>)}</dl>
      </div>;
    })}</div>
    <div className="co-summary-rules"><h4>参数依赖规则 <span>{coordination.rules.length} 条</span></h4>{coordination.rules.length ? <ol>{coordination.rules.map(rule => <li key={rule.id}><span>当 <code>{rule.ifKey}</code> = <code>{rule.ifValue}</code></span><ArrowRight size={13} /><span><code>{rule.thenKey}</code> 必须 = <code>{rule.thenValue}</code></span></li>)}</ol> : <p>未配置额外依赖规则，仍校验各版本参数和执行端引用的一致性。</p>}</div>
    <p className="co-scope-note">配置检查不代表各端已部署。工件可用性、版本透传和真实执行情况需要接入发布系统与 SDK 后验证。</p>
  </section>;
}

export function ParameterRulesEditor({ value, onChange, parameterKeys }: { value: ParameterRule[]; onChange: (value: ParameterRule[]) => void; parameterKeys: string[] }) {
  const updateRule = (id: string, patch: Partial<ParameterRule>) => onChange(value.map(rule => rule.id === id ? { ...rule, ...patch } : rule));
  return <section className="co-editor co-parameter-rules" aria-label="参数组合约束">
    <div className="co-subheading"><div><h4>参数组合约束<span className="co-optional">选填</span></h4><p>每组保存完整参数组合，跨服务也只分配一次。用条件规则约束参数之间的搭配。</p></div><span>{value.length} / 12</span></div>
    {value.length === 0 ? <div className="co-empty-rule"><GitBranch size={17} /><span>例如：前端参数启用新版布局时，接口参数必须使用对应版本。</span></div> : <div className="co-rules">{value.map((rule, index) => <fieldset className="co-rule" key={rule.id}>
      <legend>组合规则 {index + 1}</legend>
      <button type="button" className="co-remove" aria-label={`移除组合规则 ${index + 1}`} onClick={() => onChange(value.filter(item => item.id !== rule.id))}><Trash2 size={14} /><span>移除</span></button>
      <div className="co-rule-line"><span>当</span><ParameterSelect value={rule.ifKey} onChange={ifKey => updateRule(rule.id, { ifKey })} parameterKeys={parameterKeys} label={`组合规则 ${index + 1} 条件参数`} /><span>等于</span><input className="input ef-code" aria-label={`组合规则 ${index + 1} 条件值`} placeholder={'例如 "v2" 或 true'} value={rule.ifValue} onChange={event => updateRule(rule.id, { ifValue: event.target.value })} /></div>
      <div className="co-rule-line"><span>则</span><ParameterSelect value={rule.thenKey} onChange={thenKey => updateRule(rule.id, { thenKey })} parameterKeys={parameterKeys} label={`组合规则 ${index + 1} 约束参数`} /><span>必须等于</span><input className="input ef-code" aria-label={`组合规则 ${index + 1} 要求值`} placeholder={'例如 "api_v2" 或 true'} value={rule.thenValue} onChange={event => updateRule(rule.id, { thenValue: event.target.value })} /></div>
    </fieldset>)}</div>}
    <button type="button" className="btn btn-secondary" disabled={value.length >= 12} onClick={() => onChange([...value, { id: newId('rule'), ifKey: parameterKeys[0] ?? '', ifValue: '', thenKey: parameterKeys[1] ?? parameterKeys[0] ?? '', thenValue: '' }])}><Plus size={14} />添加组合规则</button>
    <p className="co-help co-rule-help">值使用 JSON 格式，字符串需双引号。逐组检查：条件命中时，要求值必须相等；未命中则不触发该规则。规则只引用当前实验的具体参数。</p>
  </section>;
}

export function ParameterRulesSummary({ rules }: { rules: ParameterRule[] }) {
  return <section className="co-summary card"><div className="co-summary-heading"><div><h3><GitBranch size={17} />参数组合约束</h3><p>对每个实验版本检查条件规则，确保同一组合内的参数搭配一致。</p></div><span>{rules.length} 条规则</span></div><div className="co-summary-rules">{rules.length ? <ol>{rules.map(rule => <li key={rule.id}><span>当 <code>{rule.ifKey}</code> = <code>{rule.ifValue}</code></span><ArrowRight size={13} /><span><code>{rule.thenKey}</code> 必须 = <code>{rule.thenValue}</code></span></li>)}</ol> : <p>未配置额外组合约束，仍校验参数作用域、类型及 A/B 参数集合一致。</p>}</div></section>;
}
