import { useEffect, useRef, useState } from 'react';
import { Copy, Equal, Plus, Trash2 } from 'lucide-react';
import { equalVariantWeights, type DraftExperimentVariant } from '../variant-draft-operations';
import { formatPercent } from '../format-percent';
import JsonParameterWorkbench from './JsonParameterWorkbench';
import './experiment-groups-editor.css';

export type ExperimentGroupFocusTarget = { variantId: string; field?: string; parameterKey?: string; nonce: number };
type Props = { variants: DraftExperimentVariant[]; onChange: (variants: DraftExperimentVariant[]) => void; traffic: number; globalTraffic: number; errors: Record<string, string>; selectedVariantId?: string; onSelectedVariantChange?: (id: string) => void; focusTarget?: ExperimentGroupFocusTarget; active?: boolean; saveState?: 'saved' | 'dirty' | 'error'; saveError?: string };

export default function ExperimentGroupsEditor({ variants, onChange, traffic, globalTraffic, errors, selectedVariantId, onSelectedVariantChange, focusTarget, active = true, saveState, saveError }: Props) {
  const [internalSelectedId, setInternalSelectedId] = useState(variants[0]?.id ?? '');
  const [notice, setNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false), [editorOpened, setEditorOpened] = useState(active);
  useEffect(() => { if (active) setEditorOpened(true); }, [active]);
  const [pendingFocus, setPendingFocus] = useState<ExperimentGroupFocusTarget | null>(null);
  const lastFocusRequest = useRef('');
  const nameInput = useRef<HTMLInputElement>(null), weightInput = useRef<HTMLInputElement>(null);
  const roleRegion = useRef<HTMLDivElement>(null), roleButton = useRef<HTMLButtonElement>(null);
  const selectedId = selectedVariantId ?? internalSelectedId;
  const selected = variants.find(variant => variant.id === selectedId) ?? variants[0];
  const focusRequest = focusTarget ? JSON.stringify([focusTarget.variantId, focusTarget.field, focusTarget.parameterKey, focusTarget.nonce]) : '';
  const selectGroup = (id: string) => { setInternalSelectedId(id); onSelectedVariantChange?.(id); setPendingFocus(null); };
  useEffect(() => {
    if (!selected || selectedId === selected.id) return;
    setInternalSelectedId(selected.id); onSelectedVariantChange?.(selected.id);
  }, [selected?.id, selectedId, onSelectedVariantChange]);
  useEffect(() => {
    if (!focusTarget || !focusRequest || lastFocusRequest.current === focusRequest) return;
    lastFocusRequest.current = focusRequest;
    if (!variants.some(variant => variant.id === focusTarget.variantId)) { setPendingFocus(null); setNotice('需要定位的分组已不存在，请重新检查当前草稿。'); return; }
    setInternalSelectedId(focusTarget.variantId); onSelectedVariantChange?.(focusTarget.variantId); setPendingFocus(focusTarget);
  }, [focusRequest, focusTarget, variants, onSelectedVariantChange]);
  useEffect(() => {
    if (!pendingFocus || selected?.id !== pendingFocus.variantId) return;
    const field = pendingFocus.field;
    const metadata = !pendingFocus.parameterKey && ['variant-name', 'name', 'variant-weight', 'weight', 'variant-role', 'role'].includes(field ?? '');
    if (!metadata) { setPendingFocus(null); return; }
    setSettingsOpen(true);
    const frame = requestAnimationFrame(() => {
      const input = field === 'variant-name' || field === 'name' ? nameInput.current : field === 'variant-weight' || field === 'weight' ? weightInput.current : roleButton.current ?? roleRegion.current;
      if (!input) return;
      input.focus({ preventScroll: true }); input.scrollIntoView({ block: 'center', behavior: 'instant' });
      if (input === nameInput.current) nameInput.current?.select();
      setPendingFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingFocus, selected?.id]);
  if (!selected) return <section className="eg-editor eg-empty" role="alert">当前草稿没有可编辑的分组，请恢复有效草稿。</section>;
  const index = variants.indexOf(selected), letter = String.fromCharCode(65 + index);
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  const update = (patch: Partial<DraftExperimentVariant>) => { setNotice(''); onChange(variants.map(variant => variant.id === selected.id ? { ...variant, ...patch } : variant)); };
  const append = (source: DraftExperimentVariant, copied: boolean) => {
    if (variants.length >= 20) return;
    let suffix = variants.length + 1;
    let name = `实验组 ${String.fromCharCode(64 + suffix)}`;
    while (variants.some(variant => variant.name.trim() === name)) name = `实验组 ${++suffix}`;
    const next: DraftExperimentVariant = { id: `group-${crypto.randomUUID()}`, name, role: 'treatment', weight: 0, value: source.value };
    onChange([...variants, next]); selectGroup(next.id);
    setNotice(`${copied ? '已复制当前组参数' : '已从对照组复制参数'}。新组流量待填写，也可点击「均分流量」；其他分组的比例保持。`);
  };
  const remove = () => {
    if (selected.role === 'control' || variants.length <= 2) return;
    const remaining = variants.filter(variant => variant.id !== selected.id);
    onChange(remaining); selectGroup(remaining[Math.min(index, remaining.length - 1)].id);
    setNotice('已删除分组，请重新检查流量合计；其他分组比例保持。');
  };
  return <section className="eg-editor" aria-label="实验分组配置" tabIndex={-1}>
    <div className="eg-heading"><div><h3>实验分组 <span>{variants.length} / 20</span></h3><p>一个对照组与多个实验组，每组保存完整参数配置。</p></div><strong className={Math.abs(total - 100) < 1e-9 ? 'ef-green' : 'ef-error'}>流量合计 {formatPercent(total)}%</strong></div>
    <div className="eg-toolbar"><button type="button" className="btn btn-small" disabled={variants.length >= 20} onClick={() => append(variants.find(variant => variant.role === 'control') ?? variants[0], false)}><Plus size={14} />新增实验组</button><button type="button" className="btn btn-small" onClick={() => { const weights = equalVariantWeights(variants.length); onChange(variants.map((variant, i) => ({ ...variant, weight: weights[i] }))); setNotice('已均分当前草稿的组内流量，尾差按顺序分配至 0.01%。'); }}><Equal size={14} />均分流量</button><span>分组比例以本实验流量为 100%</span></div>
    {notice && <p className="eg-notice" role="status">{notice}</p>}
    {errors.variants && <p className="ef-error eg-error" role="alert" id="experiment-groups-error" tabIndex={-1}>{errors.variants}</p>}
    <div className="eg-layout"><div className="eg-group-list" aria-label="选择要编辑的实验分组">{variants.map((variant, i) => <button type="button" key={variant.id} className={variant.id === selected.id ? 'selected' : ''} aria-pressed={variant.id === selected.id} onClick={() => selectGroup(variant.id)}><span className={`ef-variant-token ${variant.role === 'control' ? 'variant-a' : 'variant-b'}`}>{String.fromCharCode(65 + i)}</span><span className="eg-group-label"><strong>{variant.name || '未命名分组'}</strong><small>{variant.role === 'control' ? '对照组' : '实验组'}{errors[`value-${variant.id}`] || errors[`name-${variant.id}`] || errors[`weight-${variant.id}`] || errors[`role-${variant.id}`] ? ' · 待修正' : ''}</small></span><span className={variant.weight > 0 ? '' : 'ef-error'}>{variant.weight > 0 ? `${formatPercent(variant.weight)}%` : '待分配'}</span></button>)}</div>
      <div className="eg-group-detail"><div className="eg-selected-heading"><strong>分组 {letter}</strong><div><button type="button" className="btn btn-small" disabled={variants.length >= 20} onClick={() => append(selected, true)}><Copy size={13} />复制此组</button><button type="button" className="eg-delete" aria-label={`删除分组 ${letter}`} disabled={selected.role === 'control' || variants.length <= 2} title={selected.role === 'control' ? '请先将其他组设为对照组' : variants.length <= 2 ? '至少保留两个分组' : '删除当前草稿分组'} onClick={remove}><Trash2 size={14} /></button></div></div>
        <details className="eg-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}><summary>分组设置<span>{selected.role === 'control' ? '对照组' : '实验组'} · 组内流量 {formatPercent(selected.weight)}% · 名称与角色</span></summary><div className="eg-meta"><label className="ef-field">分组名称<input ref={nameInput} name="variant-name" className="input" aria-label={`分组 ${letter} 名称`} maxLength={60} value={selected.name} onChange={event => update({ name: event.target.value })} aria-invalid={!!errors[`name-${selected.id}`]} aria-describedby={errors[`name-${selected.id}`] ? `group-name-error-${selected.id}` : undefined} />{errors[`name-${selected.id}`] && <span id={`group-name-error-${selected.id}`} className="ef-error" role="alert">{errors[`name-${selected.id}`]}</span>}</label><label className="ef-field">组内流量 %<input ref={weightInput} name="variant-weight" className="input" aria-label={`分组 ${letter} 流量权重`} type="number" min={0.01} max={99.99} step={0.01} value={selected.weight} onChange={event => update({ weight: Number(event.target.value) })} aria-invalid={!!errors[`weight-${selected.id}`]} aria-describedby={errors[`weight-${selected.id}`] ? `group-weight-error-${selected.id}` : undefined} />{errors[`weight-${selected.id}`] && <span id={`group-weight-error-${selected.id}`} className="ef-error" role="alert">{errors[`weight-${selected.id}`]}</span>}</label></div>
        <div ref={roleRegion} className="eg-role" tabIndex={-1} role="group" aria-label={`分组 ${letter} 角色`} aria-invalid={!!errors[`role-${selected.id}`]} aria-describedby={errors[`role-${selected.id}`] ? `group-role-error-${selected.id}` : undefined}><span>{selected.role === 'control' ? '当前对照组' : '当前实验组'}</span>{(selected.role !== 'control' || variants.filter(v => v.role === 'control').length !== 1) && <button ref={roleButton} type="button" onClick={() => { onChange(variants.map(variant => ({ ...variant, role: variant.id === selected.id ? 'control' : 'treatment' }))); setNotice('已更新对照组；分组名称、参数、顺序与流量保持。'); }}>{selected.role === 'control' ? '保留此组为唯一对照' : '设为对照组'}</button>}{errors[`role-${selected.id}`] && <span id={`group-role-error-${selected.id}`} className="ef-error" role="alert">{errors[`role-${selected.id}`]}</span>}<small>占本域 {formatPercent(traffic * selected.weight / 100)}% · 全局名义 {formatPercent(globalTraffic * selected.weight / 100)}%</small></div>
        </details>
        {editorOpened && <JsonParameterWorkbench variants={variants} selectedVariantId={selected.id} onSelect={selectGroup} onChange={value => update({ value })} focusTarget={focusTarget} error={errors[`value-${selected.id}`]} saveState={saveState} saveError={saveError} />}

      </div></div>
  </section>;
}
