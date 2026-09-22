import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, CircleAlert, Copy, Eye, Info, Layers3, ShieldCheck, Users, X } from 'lucide-react';
import type { Experiment } from '../data';
import { bucketCount, formatBucketRanges } from '../bucket-ranges';
import { audienceSummary, describeExpression, evaluateAudience, getAudienceExpression, getAudiences, planAudienceRegistration, type AudienceDefinition, type AudienceExpression, type EffectiveAudience } from '../audiences';
import { audiencePreflight, type AudienceAllocationContext } from '../audience-preflight';
import { getProfileAttributes } from '../profile-attributes';
import { getTopology, saveTopology } from '../traffic';
import AudienceRuleBuilder, { emptyAudienceRule, expressionFields, parseProfileInputs, ProfileInputs, rulePathId, type ProfileInputDraft } from './AudienceRuleBuilder';
import './audience-editor.css';

export type AudienceEditorProps = { source?: AudienceDefinition; experiments: Experiment[]; onClose: () => void; onSaved: (id: string) => void; inheritedCondition?: EffectiveAudience; allocation?: AudienceAllocationContext };
function initialExpression(source?: AudienceDefinition): AudienceExpression {
  if (!source) return { kind: 'group', operator: 'and', children: [emptyAudienceRule()] };
  const expression = structuredClone(getAudienceExpression(source));
  return expression.kind === 'group' ? expression : { kind: 'group', operator: 'and', children: [expression] };
}
function focusIssue(path: string) {
  let cursor = path;
  let target: HTMLElement | null = null;
  while (cursor) { target = document.getElementById(rulePathId(cursor)); if (target) break; cursor = cursor.slice(0, cursor.lastIndexOf('.')); }
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  (target?.querySelector<HTMLElement>('input, select, button') ?? target)?.focus({ preventScroll: true });
}

export default function AudienceEditor({ source, experiments, onClose, onSaved, inheritedCondition, allocation }: AudienceEditorProps) {
  const [name, setName] = useState(source?.name ?? '');
  const [owner, setOwner] = useState(source?.owner ?? '陈思远');
  const [description, setDescription] = useState(source?.description ?? '');
  const [draftExpression, setDraftExpression] = useState<AudienceExpression>(() => initialExpression(source));
  const [allowUniversal, setAllowUniversal] = useState(() => { const expression = initialExpression(source); return expression.kind === 'group' && expression.operator === 'and' && expression.children.length === 0; });
  const [profileDraft, setProfileDraft] = useState<ProfileInputDraft>({});
  const [previewRequested, setPreviewRequested] = useState(false);
  const [error, setError] = useState('');
  const [metadataErrors, setMetadataErrors] = useState<Record<string, string>>({});
  const [newId] = useState(() => `audience-${crypto.randomUUID().slice(0, 12)}`);
  const drawer = useRef<HTMLFormElement>(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  const topology = getTopology();
  const expression: AudienceExpression = allowUniversal ? { kind: 'group', operator: 'and', children: [] } : draftExpression;
  const version = source ? Math.max(...getAudiences(topology).filter(item => item.familyId === source.familyId).map(item => item.version), source.version) + 1 : 1;
  const preflight = audiencePreflight({ definition: { rules: [], expression, name: name.trim() || '未命名受众', version }, topology, experiments, allowUniversal, inheritedCondition, allocation });
  const validation = preflight.validation;
  const currentInherited = preflight.inheritedCondition;
  const displayIssues = validation.issues.map(issue => {
    let node: AudienceExpression | undefined = expression;
    for (const index of issue.path.matchAll(/\.children\.(\d+)/g)) node = node?.kind === 'group' ? node.children[Number(index[1])] : undefined;
    if (issue.code !== 'rule' || node?.kind !== 'rule') return issue;
    if (node.rule.field === '') return { ...issue, message: '请选择画像属性。' };
    if (getProfileAttributes(topology).some(attribute => attribute.key === node.rule.field) && (node.rule.value === '' || (Array.isArray(node.rule.value) && !node.rule.value.length))) return { ...issue, message: '请填写条件值。' };
    return issue;
  });
  const effective = preflight.effectiveCondition;
  const usedFields = new Set([...expressionFields(expression), ...(currentInherited?.rules.map(rule => rule.field) ?? []), ...(currentInherited?.expression ? expressionFields(currentInherited.expression) : [])]);
  const previewAttributes = getProfileAttributes(topology).filter(attribute => usedFields.has(attribute.key));
  const parsedProfile = parseProfileInputs(profileDraft, previewAttributes);
  const preview = previewRequested && effective && !parsedProfile.error ? evaluateAudience(effective, parsedProfile.profile) : null;
  const summary = validation.valid ? describeExpression(expression, topology) : '条件尚未完成；请根据下方提示补齐属性、运算符和条件值。';
  const contextErrors = preflight.errors.filter(error => error.code !== 'own-expression');
  const allocationCheck = preflight.allocation;
  const comparisonLabels = { disjoint: '可证明互斥', 'potential-overlap': '可能重叠', unproven: '无法证明' };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const overlay = drawer.current?.closest('[data-audience-editor-overlay]');
    const background = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay).map(element => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
    background.forEach(({ element }) => { element.inert = true; element.setAttribute('aria-hidden', 'true'); });
    drawer.current?.querySelector<HTMLElement>('#audience-editor-name')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return;
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        const pickerClose = drawer.current?.querySelector<HTMLButtonElement>('[data-audience-attribute-picker="open"] [data-close-attribute-picker]');
        if (pickerClose) pickerClose.click(); else closeRef.current();
        return;
      }
      const controls = Array.from(drawer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]') ?? []).filter(element => element.getClientRects().length && !element.closest('[inert]'));
      const first = controls[0], last = controls.at(-1);
      if (!drawer.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      background.forEach(({ element, inert, ariaHidden }) => { element.inert = inert; if (ariaHidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', ariaHidden); });
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); event.stopPropagation();
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = '请填写受众名称。';
    if (!owner.trim()) errors.owner = '请填写负责人。';
    setMetadataErrors(errors); setError('');
    if (Object.keys(errors).length) { drawer.current?.querySelector<HTMLElement>(`#audience-editor-${Object.keys(errors)[0]}`)?.focus(); return; }
    const latest = getTopology();
    const nextVersion = source ? Math.max(...getAudiences(latest).filter(item => item.familyId === source.familyId).map(item => item.version), source.version) + 1 : 1;
    const checked = audiencePreflight({ definition: { rules: [], expression, name: name.trim(), version: nextVersion }, topology: latest, experiments, allowUniversal, inheritedCondition, allocation });
    if (!checked.validation.valid) { focusIssue(checked.validation.issues.find(issue => issue.severity === 'error')?.path ?? 'root'); return; }
    if (!checked.valid) { setError(checked.errors[0]?.message ?? '创建前检查未通过，请调整当前配置。'); drawer.current?.querySelector<HTMLElement>('#audience-preflight')?.focus(); return; }
    const plan = planAudienceRegistration({ id: newId, familyId: source?.familyId ?? newId, name: name.trim(), owner: owner.trim(), description: description.trim(), version: nextVersion, rules: [], expression, ...(allowUniversal ? { allowUniversal: true } : {}) }, latest);
    if (plan.error || !plan.topology) { setError(plan.error ?? '受众版本无法保存，请检查配置。'); return; }
    const invalid = saveTopology(plan.topology, experiments);
    if (invalid) { setError(invalid); return; }
    onSaved(newId);
  }

  return createPortal(<div className="ae-overlay" data-audience-editor-overlay onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form ref={drawer} className="ae-drawer" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="audience-editor-title" aria-describedby="audience-editor-subtitle" noValidate>
    <header className="ae-header"><div className="ae-heading-symbol">{source ? <Copy size={23}/> : <Users size={23}/>}</div><div><span className="ae-overline">AUDIENCE DEFINITION</span><h2 id="audience-editor-title">{source ? '创建受众新版本' : '新建受众'}</h2><p id="audience-editor-subtitle">组合固定入组属性，为实验定义可复用的准入条件。</p></div><button type="button" className="ae-close" aria-label="关闭受众编辑器" onClick={onClose}><X size={20}/></button></header>
    <div className="ae-body"><div className="ae-main">
      <section className="ae-section"><div className="ae-section-heading"><h3><span>01</span>基本信息</h3><span className="ae-version">{source ? `基于 v${source.version} → ` : ''}v{version}</span></div>{source && <p className="ae-source-note"><ShieldCheck size={14}/>从「{source.name}」复制；保存为新版本，已有引用继续使用原版本。</p>}<div className="ae-metadata-grid"><label>受众名称<span className="ae-required">*</span><input id="audience-editor-name" aria-invalid={!!metadataErrors.name} value={name} maxLength={60} placeholder="例如：国内移动端新会员" onChange={event => { setName(event.target.value); setMetadataErrors(old => ({ ...old, name: '' })); setError(''); }}/>{metadataErrors.name && <small className="ae-error">{metadataErrors.name}</small>}</label><label>负责人<span className="ae-required">*</span><input id="audience-editor-owner" aria-invalid={!!metadataErrors.owner} value={owner} maxLength={60} onChange={event => { setOwner(event.target.value); setMetadataErrors(old => ({ ...old, owner: '' })); setError(''); }}/>{metadataErrors.owner && <small className="ae-error">{metadataErrors.owner}</small>}</label><label className="ae-full-width">受众说明<textarea rows={2} value={description} maxLength={300} placeholder="说明使用场景和入组资格口径" onChange={event => { setDescription(event.target.value); setError(''); }}/></label></div></section>
      <section className="ae-section"><div className="ae-section-heading"><h3><span>02</span>组合受众条件</h3><span>{validation.ruleCount} / 30 条</span></div><label className="ae-universal"><input type="checkbox" checked={allowUniversal} onChange={event => { setAllowUniversal(event.target.checked); setError(''); }}/><span>所有符合上级条件的用户<small>明确不追加条件，仍受祖先域资格限制。</small></span></label>{allowUniversal ? <div className="ae-universal-note"><Users size={20}/><div><strong>不追加受众限制</strong><p>保存为显式的全体版本，祖先域约束继续生效。</p></div></div> : <AudienceRuleBuilder value={draftExpression} onChange={expression => { setDraftExpression(expression); setError(''); }} issues={displayIssues}/>}</section>
      <section className="ae-section ae-preflight" id="audience-preflight" tabIndex={-1} aria-label="创建前受众检查"><div className="ae-section-heading"><h3><span>03</span>创建前检查</h3><span>随条件自动更新</span></div>{!validation.valid ? <p className="ae-preflight-empty">补齐上方受众条件后，自动检查继承范围、已登记受众关系{allocation ? '与当前层可用流量' : ''}。</p> : <>
        <div className={`ae-preflight-status ${preflight.valid ? 'is-valid' : 'is-blocked'}`}>{preflight.valid ? <ShieldCheck size={17}/> : <CircleAlert size={17}/>}<div><strong>{preflight.valid ? '受众条件检查通过' : '当前配置无法保存'}</strong><p>{allocation ? '按当前层及父表单流量检查，保存前会再次读取最新配置。' : '中央登记不绑定流量桶；普通受众之间存在重叠可以正常登记。'}</p></div></div>
        {contextErrors.map(error => <p key={error.code} className="ae-preflight-error" role="alert">{error.message}</p>)}
        {effective && <div className="ae-effective-condition"><span>{currentInherited ? '与祖先取交集后的有效条件' : '本受众完整条件'}</span><p>{audienceSummary(effective)}</p></div>}
        {allocationCheck && <div className="ae-allocation-check"><div className="ae-check-subheading"><h4>当前配置的流量检查</h4><span>{allocationCheck.domainName} / {allocationCheck.layerName}</span></div><div className="ae-allocation-metrics"><div><span>父表单请求流量</span><strong>{allocationCheck.traffic}%</strong></div><div><span>当前受众可用</span><strong>{allocationCheck.capacity.available}%</strong></div><div><span>可用桶 / 10,000</span><strong>{Math.round(allocationCheck.capacity.available * 100).toLocaleString()}</strong></div></div><div className={`ae-available-range ${allocationCheck.bucketRanges === null ? 'unavailable' : ''}`}><span>自动组合分配</span><strong>{allocationCheck.bucketRanges === null ? (contextErrors.some(error=>error.code==='allocation-capacity')?'可用桶总量不足':'当前配置无法分配') : `${bucketCount(allocationCheck.bucketRanges).toLocaleString()} 个桶 · ${allocationCheck.bucketRanges.length} 段`}</strong></div>{allocationCheck.bucketRanges && <details className="ae-bucket-ranges"><summary>查看拟分配桶段（右端点不包含）</summary><code>{formatBucketRanges(allocationCheck.bucketRanges)}</code></details>}<p className="ae-caption">{allocationCheck.bucketRanges === null ? '本次内联登记必须能用于当前配置；可取消后调整父表单流量或修改受众条件。' : '已组合当前受众下可用的桶，并避开可能同时匹配的配置；保存受众不会预占流量，父表单提交时重新检查。'}</p>{allocationCheck.conflicts.length > 0 && <div className="ae-allocation-conflicts"><h4>同层需避开的 {allocationCheck.conflicts.length} 个配置</h4>{allocationCheck.conflicts.map(conflict => <article key={`${conflict.kind}:${conflict.id}`}><header><strong>{conflict.kind === 'domain' ? '子域' : '实验'} · {conflict.name}</strong><code>{formatBucketRanges(conflict.bucketRanges ?? [{start:Math.round(conflict.start*100),end:Math.round(conflict.end*100)}])}</code></header><p className="ae-compared-condition">{conflict.conditionSummary}</p><p>{conflict.reason}{conflict.unknown ? ' · 保守保留独立桶' : ''}</p>{conflict.witness && <details><summary>共同满足条件的画像示例</summary><pre>{JSON.stringify(conflict.witness, null, 2)}</pre></details>}</article>)}</div>}</div>}
        {!contextErrors.some(error => error.code === 'inheritance-empty') && <div className="ae-catalog-comparisons"><div className="ae-check-subheading"><h4>与已登记受众的关系</h4><span>{preflight.catalogComparisons.length} 个固定版本</span></div><p className="ae-caption">将当前有效条件与各版本自身的完整条件比较。普通重叠不全局阻止登记，实际桶冲突按使用位置判断。</p><div className="ae-comparison-counts">{(['disjoint', 'potential-overlap', 'unproven'] as const).map(relation => <span key={relation} className={relation}>{comparisonLabels[relation]} <strong>{preflight.catalogComparisons.filter(item => item.relation === relation).length}</strong></span>)}</div><div className="ae-comparison-items">{preflight.catalogComparisons.map(item => <article key={item.definition.id}><header><div><strong>{item.definition.name}</strong><small>v{item.definition.version}{source?.familyId === item.definition.familyId ? ' · 同系列旧版本，引用固定' : ' · 已登记固定版本'}</small></div><span className={`ae-comparison-relation ${item.relation}`}>{comparisonLabels[item.relation]}</span></header><p className="ae-compared-condition">{audienceSummary(item.condition)}</p><p>{item.comparison.reason}</p>{item.comparison.witness && <details><summary>共同满足条件的画像示例</summary><pre>{JSON.stringify(item.comparison.witness, null, 2)}</pre></details>}</article>)}</div></div>}
      </>}</section>
    </div><aside className="ae-review">
      <section className="ae-summary-card"><div className="ae-side-heading"><Layers3 size={16}/><h3>整体条件</h3></div>{currentInherited && <div className="ae-inherited"><span>祖先域固定条件</span><p>{audienceSummary(currentInherited)}</p><strong>AND</strong></div>}<p className={`ae-expression-summary ${!validation.valid ? 'is-incomplete' : ''}`}>{summary}</p><p className="ae-caption">AND 要求全部满足，OR 允许任一满足；条件组保留完整括号关系。</p></section>
      {displayIssues.length > 0 && <section className="ae-validation" aria-label="条件校验结果"><h3><CircleAlert size={15}/>{validation.valid ? '配置提示' : '需要完善的条件'}</h3>{displayIssues.map((issue, index) => <button type="button" key={`${issue.path}:${issue.code}:${index}`} className={issue.severity} onClick={() => focusIssue(issue.path)}><span>{issue.message}</span><small>{issue.path.replaceAll('.children.', ' › ')}<ArrowRight size={11}/></small></button>)}</section>}
      <section className="ae-preview-card"><div className="ae-side-heading"><Eye size={16}/><h3>画像资格预览</h3></div><p className="ae-caption">手动填写一个入组前画像，只判断资格；未提供的属性保持未知。</p>{previewAttributes.length ? <ProfileInputs attributes={previewAttributes} value={profileDraft} onChange={setProfileDraft} idPrefix="audience-preview"/> : <p className="ae-preview-empty">当前条件不需要画像属性。</p>}<button type="button" className="btn ae-preview-button" disabled={!validation.valid} onClick={() => setPreviewRequested(true)}><Eye size={14}/>验证当前画像</button>{previewRequested && parsedProfile.error && <p className="ae-error" role="alert">{parsedProfile.error}</p>}{preview && <div className={`ae-preview-result ${preview.status}`} role="status"><strong>{preview.status === 'match' ? '符合有效受众条件' : preview.status === 'not-match' ? '不符合有效受众条件' : '资格未知'}</strong><p>{preview.reason}</p></div>}<small className="ae-caption">这是临时条件预览，不记录用户、不推测实际人数。</small></section>
    </aside></div>
    <footer className="ae-footer"><div>{error ? <p role="alert" className="ae-error"><CircleAlert size={15}/>{error}</p> : <p><Info size={14}/>{!preflight.valid ? '请完成创建前检查后再保存。' : source ? '仅新增版本，旧版本及其引用保持不变。' : '保存后可被实验或子域按版本引用。'}</p>}</div><button type="button" className="btn" onClick={onClose}>取消</button><button type="submit" className="btn btn-primary" disabled={!preflight.valid}><Check size={15}/>{allocation ? '保存并选用' : source ? '保存新版本' : '保存受众'}</button></footer>
  </form></div>, document.body);
}
