import { useRef, useState } from 'react';
import { Braces, ChevronDown, Info, Plus, Search, Trash2, X } from 'lucide-react';
import type { AudienceExpression, AudienceProfile, AudienceRule } from '../audiences';
import { getProfileAttributes, isBuiltinProfileAttribute, profileValueIsValid, type ProfileAttribute } from '../profile-attributes';
import { getTopology } from '../traffic';
import './audience-editor.css';

export type AudienceRuleIssue = { path: string; message: string; severity: 'error' | 'warning'; code: string };
export const rulePathId = (path: string) => `audience-node-${path.replaceAll('.', '-')}`;
export const emptyAudienceRule = (): AudienceExpression => ({ kind: 'rule', rule: { field: '', op: 'eq', value: '' } });
const typeLabels: Record<ProfileAttribute['type'], string> = { enum: '枚举', number: '数值', boolean: '布尔', string: '文本' };
const operatorLabels: Record<AudienceRule['op'], string> = { eq: '等于', in: '属于任一', gte: '大于等于', lte: '小于等于' };
const operators = (attribute?: ProfileAttribute): AudienceRule['op'][] => attribute?.type === 'number' ? ['eq', 'gte', 'lte'] : attribute?.type === 'boolean' ? ['eq'] : ['eq', 'in'];
const initialValue = (attribute?: ProfileAttribute): AudienceRule['value'] => attribute?.type === 'boolean' ? false : '';
export function expressionFields(expression: AudienceExpression): string[] {
  return expression.kind === 'rule' ? [expression.rule.field].filter(Boolean) : [...new Set(expression.children.flatMap(expressionFields))];
}
function ruleCount(expression: AudienceExpression): number { return expression.kind === 'rule' ? 1 : expression.children.reduce((sum, child) => sum + ruleCount(child), 0); }
function nodeCount(expression: AudienceExpression): number { return expression.kind === 'rule' ? 1 : 1 + expression.children.reduce((sum, child) => sum + nodeCount(child), 0); }

function AttributePicker({ value, onChange, path }: { value: string; onChange: (attribute: ProfileAttribute) => void; path: string }) {
  const attributes = getProfileAttributes(getTopology());
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = attributes.find(attribute => attribute.key === value);
  const matching = attributes.filter(attribute => `${attribute.label} ${attribute.key} ${attribute.description}`.toLowerCase().includes(query.toLowerCase().trim()));
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div className="arb-attribute" data-audience-attribute-picker={open ? 'open' : undefined}>
    <button ref={trigger} type="button" className={`arb-attribute-trigger ${!selected ? 'is-placeholder' : ''}`} aria-label={`选择属性 ${path}`} aria-expanded={open} onClick={() => { setOpen(value => !value); setQuery(''); }}><span>{selected?.label ?? (value || '选择画像属性')}<small>{selected?.key ?? '搜索名称、Key 或定义'}</small></span><ChevronDown size={14}/></button>
    {open && <div className="arb-attribute-menu"><div className="arb-attribute-search"><Search size={14}/><input autoFocus aria-label="搜索画像属性" placeholder="搜索名称、Key 或口径" value={query} onChange={event => setQuery(event.target.value)}/><button data-close-attribute-picker type="button" aria-label="关闭属性选择" onClick={close}><X size={14}/></button></div><div className="arb-attribute-options">{matching.map(attribute => <button type="button" key={attribute.key} aria-pressed={value === attribute.key} onClick={() => { onChange(attribute); close(); }}><span><strong>{attribute.label}</strong><small>{attribute.key}</small></span><span><em>{typeLabels[attribute.type]}</em></span><p>{attribute.description}</p></button>)}{!matching.length && <p className="arb-attribute-empty">没有符合条件的属性，请调整搜索词。</p>}</div></div>}
    {selected && <details className="arb-attribute-meta"><summary><Info size={11}/>属性定义与口径</summary><dl><div><dt>类型</dt><dd>{typeLabels[selected.type]}{selected.integer ? ' · 整数' : ''}{selected.unit ? ` · ${selected.unit}` : ''}</dd></div><div><dt>口径</dt><dd>{selected.description}</dd></div>{selected.values?.length ? <div><dt>{isBuiltinProfileAttribute(selected.key) ? '建议' : '允许'}</dt><dd>{selected.values.join('、')}{isBuiltinProfileAttribute(selected.key) ? ' · 常用取值，可填写其他值' : ' · 仅允许这些取值'}</dd></div> : null}</dl></details>}
  </div>;
}

function RuleValue({ rule, attribute, onChange, path }: { rule: AudienceRule; attribute?: ProfileAttribute; onChange: (value: AudienceRule['value']) => void; path: string }) {
  if (attribute?.type === 'boolean') return <select aria-label={`条件值 ${path}`} value={typeof rule.value === 'boolean' ? String(rule.value) : ''} onChange={event => onChange(event.target.value === 'true')}><option value="true">是 · true</option><option value="false">否 · false</option></select>;
  if (rule.op === 'in' && attribute?.type === 'enum' && !isBuiltinProfileAttribute(attribute.key) && attribute.values?.length) {
    const selected = Array.isArray(rule.value) ? rule.value : [];
    return <div className="arb-enum-values" role="group" aria-label={`条件值 ${path}`}>{attribute.values.map(value => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={event => onChange(event.target.checked ? [...selected, value] : selected.filter(item => item !== value))}/>{value}</label>)}</div>;
  }
  if (attribute?.type === 'enum' && !isBuiltinProfileAttribute(attribute.key) && attribute.values?.length && rule.op === 'eq') return <select aria-label={`条件值 ${path}`} value={typeof rule.value === 'string' ? rule.value : ''} onChange={event => onChange(event.target.value)}><option value="">选择一个值</option>{typeof rule.value === 'string' && rule.value && !attribute.values.includes(rule.value) && <option value={rule.value}>{rule.value} · 不在允许值内</option>}{attribute.values.map(value => <option key={value} value={value}>{value}</option>)}</select>;
  if (rule.op === 'in') return <input aria-label={`条件值 ${path}`} placeholder="多个值以逗号分隔" value={Array.isArray(rule.value) ? rule.value.join(', ') : ''} onChange={event => onChange(event.target.value.split(/[,，]/).map(value => value.trim()))}/>;
  return <div className="arb-number-value"><input aria-label={`条件值 ${path}`} list={attribute?.type === 'enum' ? `rule-values-${path}` : undefined} type={attribute?.type === 'number' ? 'number' : 'text'} min={attribute?.type === 'number' ? 0 : undefined} step={attribute?.integer ? 1 : 'any'} placeholder={attribute?.type === 'number' ? '输入数值' : '输入匹配值'} value={typeof rule.value === 'number' || typeof rule.value === 'string' ? rule.value : ''} onChange={event => onChange(attribute?.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)}/>{attribute?.type === 'enum' && <datalist id={`rule-values-${path}`}>{attribute.values?.map(value => <option value={value} key={value}/>)}</datalist>}{attribute?.unit && <span>{attribute.unit}</span>}</div>;
}

function RuleNode({ node, path, depth, onUpdate, onRemove, count, nodes, issues }: { node: AudienceExpression; path: string; depth: number; onUpdate: (value: AudienceExpression) => void; onRemove?: () => void; count: number; nodes: number; issues: AudienceRuleIssue[] }) {
    const localIssues = issues.filter(issue => issue.path === path || (node.kind === 'rule' && issue.path.startsWith(`${path}.`)));
    if (node.kind === 'rule') {
      const attribute = getProfileAttributes(getTopology()).find(attribute => attribute.key === node.rule.field);
      return <div id={rulePathId(path)} className={`arb-rule ${localIssues.some(issue => issue.severity === 'error') ? 'has-error' : ''}`} tabIndex={-1}><div className="arb-rule-grid"><div><label>画像属性</label><AttributePicker value={node.rule.field} path={path} onChange={attribute => onUpdate({ kind: 'rule', rule: { field: attribute.key, op: 'eq', value: initialValue(attribute) } })}/></div><div><label>运算符</label><select aria-label={`运算符 ${path}`} value={node.rule.op} onChange={event => { const op = event.target.value as AudienceRule['op']; onUpdate({ kind: 'rule', rule: { ...node.rule, op, value: op === 'in' ? typeof node.rule.value === 'string' && node.rule.value ? [node.rule.value] : [] : Array.isArray(node.rule.value) ? node.rule.value[0] ?? '' : node.rule.value } }); }}>{operators(attribute).map(op => <option key={op} value={op}>{operatorLabels[op]}</option>)}</select></div><div><label>条件值</label><RuleValue rule={node.rule} attribute={attribute} path={path} onChange={value => onUpdate({ kind: 'rule', rule: { ...node.rule, value } })}/></div>{onRemove && <button type="button" className="arb-remove" aria-label={`删除条件 ${path}`} onClick={onRemove}><Trash2 size={14}/></button>}</div>{localIssues.map(issue => <p key={`${issue.path}:${issue.code}`} className={`arb-issue ${issue.severity}`}>{issue.message}</p>)}</div>;
    }
    const updateChild = (index: number, child: AudienceExpression) => onUpdate({ ...node, children: node.children.map((item, position) => position === index ? child : item) });
    return <fieldset id={rulePathId(path)} tabIndex={-1} className={`arb-group arb-depth-${depth}`}><legend><Braces size={13}/>{depth === 1 ? '全部受众条件' : `条件组 · 第 ${depth} 层`}</legend><div className="arb-group-toolbar"><div className="arb-operator" role="group" aria-label={`条件组关系 ${path}`}>{(['and', 'or'] as const).map(operator => <button key={operator} type="button" className={node.operator === operator ? 'active' : ''} aria-pressed={node.operator === operator} onClick={() => onUpdate({ ...node, operator })}>{operator === 'and' ? '全部满足 AND' : '任一满足 OR'}</button>)}</div>{onRemove && <button className="arb-group-remove" type="button" onClick={onRemove}><Trash2 size={12}/>删除组</button>}</div><div className="arb-children">{node.children.map((child, index) => <RuleNode count={count} nodes={nodes} issues={issues} key={index} node={child} path={`${path}.children.${index}`} depth={child.kind === 'group' ? depth + 1 : depth} onUpdate={updated => updateChild(index, updated)} onRemove={() => onUpdate({ ...node, children: node.children.filter((_, position) => position !== index) })}/>)}{!node.children.length && <div className="arb-group-empty">此组尚无条件。添加条件，或删除这个空组。</div>}</div>{localIssues.map(issue => <p key={`${issue.path}:${issue.code}`} className={`arb-issue ${issue.severity}`}>{issue.message}</p>)}<div className="arb-group-actions"><button type="button" disabled={count >= 30} onClick={() => onUpdate({ ...node, children: [...node.children, emptyAudienceRule()] })}><Plus size={13}/>添加条件</button><button type="button" disabled={depth >= 3 || count >= 30 || nodes >= 60} onClick={() => onUpdate({ ...node, children: [...node.children, { kind: 'group', operator: 'and', children: [emptyAudienceRule()] }] })}><Braces size={13}/>添加条件组</button>{depth >= 3 && <span>已达 3 层分组上限</span>}</div></fieldset>;
  }

export default function AudienceRuleBuilder({ value, onChange, issues = [] }: { value: AudienceExpression; onChange: (value: AudienceExpression) => void; issues?: AudienceRuleIssue[] }) {
  const count = ruleCount(value), nodes = nodeCount(value);

  return <div className="arb-builder"><RuleNode count={count} nodes={nodes} issues={issues} node={value} path="root" depth={1} onUpdate={onChange}/><p className="arb-builder-note">根组计为第 1 层，最多 3 层、30 条条件。同组按 AND / OR 组合，祖先域约束始终与本受众取交集。</p></div>;
}

export type ProfileInputDraft = Record<string, string>;
export function parseProfileInputs(draft: ProfileInputDraft, attributes: ProfileAttribute[]): { profile: AudienceProfile; error?: string } {
  const profile: AudienceProfile = {};
  for (const attribute of attributes) {
    const raw = (draft[attribute.key] ?? '').trim(); if (!raw) continue;
    if (attribute.type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || (attribute.integer && !Number.isInteger(value))) return { profile, error: `${attribute.label}须为非负${attribute.integer ? '整数' : '数值'}。` };
      profile[attribute.key] = value;
    } else if (attribute.type === 'boolean') {
      if (!['true', 'false'].includes(raw)) return { profile, error: `${attribute.label}须为 true 或 false。` };
      profile[attribute.key] = raw === 'true';
    } else {
      if (!profileValueIsValid(attribute, raw)) return { profile, error: `${attribute.label}不在已登记允许值内。` };
      profile[attribute.key] = raw;
    }
  }
  return { profile };
}
export function ProfileInputs({ attributes, value, onChange, locked = false, idPrefix }: { attributes: ProfileAttribute[]; value: ProfileInputDraft; onChange: (value: ProfileInputDraft) => void; locked?: boolean; idPrefix: string }) {
  return <div className="ae-profile-inputs">{attributes.map(attribute => <label key={attribute.key} htmlFor={`${idPrefix}-${attribute.key}`}><span>{attribute.label}{attribute.unit ? `（${attribute.unit}）` : ''}</span>{attribute.type === 'boolean' ? <select id={`${idPrefix}-${attribute.key}`} aria-label={attribute.label} disabled={locked} value={value[attribute.key] ?? ''} onChange={event => onChange({ ...value, [attribute.key]: event.target.value })}><option value="">未提供</option><option value="true">是 · true</option><option value="false">否 · false</option></select> : attribute.type === 'enum' && !isBuiltinProfileAttribute(attribute.key) && attribute.values?.length ? <select id={`${idPrefix}-${attribute.key}`} aria-label={attribute.label} disabled={locked} value={value[attribute.key] ?? ''} onChange={event => onChange({ ...value, [attribute.key]: event.target.value })}><option value="">未提供</option>{value[attribute.key] && !attribute.values.includes(value[attribute.key]) && <option value={value[attribute.key]}>{value[attribute.key]} · 历史值</option>}{attribute.values.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input id={`${idPrefix}-${attribute.key}`} list={attribute.type === 'enum' ? `${idPrefix}-values-${attribute.key}` : undefined} aria-label={attribute.label} type={attribute.type === 'number' ? 'number' : 'text'} min={attribute.type === 'number' ? 0 : undefined} step={attribute.integer ? 1 : 'any'} readOnly={locked} placeholder="未提供" value={value[attribute.key] ?? ''} onChange={event => onChange({ ...value, [attribute.key]: event.target.value })}/>}{attribute.type === 'enum' && isBuiltinProfileAttribute(attribute.key) && <datalist id={`${idPrefix}-values-${attribute.key}`}>{attribute.values?.map(option => <option key={option} value={option}/>)}</datalist>}<small>{attribute.key}</small></label>)}</div>;
}
