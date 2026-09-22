import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Check, CircleAlert, Info, Layers3, X } from 'lucide-react';
import type { Experiment } from '../data';
import { domainGlobalTraffic, domains, layerCreationBlock, layerParameterOptions, newLayerRegistrationAssignments, nodePath, planLayerCreation, saveTopology } from '../traffic';
import { defaultResourceManagement, validateResourceManagement } from '../resource-management';
import ParameterLayerAssignments from './ParameterLayerAssignments';
import ApplicationParameterBrowser from './ApplicationParameterBrowser';
import ResourceManagementFields from './ResourceManagementFields';
import './experiment-flow.css';
import './create-layer.css';

type Props = { domainId: string; experiments: Experiment[]; onClose: () => void; onCreated: (layerId: string) => void };
const percent = (value: number) => `${Number(value.toFixed(4))}%`;

export default function CreateLayer({ domainId, experiments, onClose, onCreated }: Props) {
  const domain = domains.find(item => item.id === domainId);
  const path = nodePath('domain', domainId);
  const blocked = layerCreationBlock(domainId);
  const options = layerParameterOptions(domainId, experiments).sort((a, b) => Number(Boolean(b.pending)) - Number(Boolean(a.pending)));
  const available = blocked ? [] : options.filter(option => !option.blockedReason);
  const optionsByKey = new Map(options.map(option => [option.key, option]));
  const parameterDisabledReason = (key: string) => blocked || optionsByKey.get(key)?.blockedReason || (!optionsByKey.has(key) ? '参数不在当前域的可分配范围内。' : null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [management, setManagement] = useState(defaultResourceManagement);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [pendingSelections, setPendingSelections] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState(false);
  const [newId] = useState(() => `layer-${crypto.randomUUID().slice(0, 8)}`);
  const dialog = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const selectedOptions = options.filter(option => selectedKeys.includes(option.key));
  const activeOptions = selectedOptions.filter(option => !option.pending);
  const pendingKeys = selectedOptions.filter(option => option.pending).map(option => option.key);
  const sources = Array.from(new Set(activeOptions.map(option => option.sourceLayerId))).map(id => ({
    id,
    name: selectedOptions.find(option => option.sourceLayerId === id)!.sourceLayerName,
    keys: selectedOptions.filter(option => option.sourceLayerId === id).map(option => option.key),
  }));
  const input = { id: newId, domainId, name: name.trim() || '新参数层', description: description.trim(), parameterKeys: selectedKeys, pendingSelections, management };
  const assignments = pendingKeys.length ? newLayerRegistrationAssignments(input) : [];
  const assignmentsComplete = assignments.every(row => row.layerId);
  const preview = assignmentsComplete ? planLayerCreation(input, experiments) : null;
  const visibleError = error || preview?.error;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLInputElement>('#create-layer-name')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!name.trim()) { setNameError(true); dialog.current?.querySelector<HTMLInputElement>('#create-layer-name')?.focus(); return; }
    const planned = planLayerCreation({ ...input, name: name.trim() }, experiments);
    if (planned.error || !planned.topology) { setError(planned.error ?? '无法生成层配置，请检查参数选择。'); return; }
    const invalid = saveTopology(planned.topology, experiments);
    if (invalid) { setError(invalid); return; }
    onCreated(newId);
  }

  return <div className="ef-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="ef-modal cl-modal" ref={dialog} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="create-layer-title" aria-describedby="create-layer-subtitle" noValidate>
      <div className="ef-modal-head"><span className="ef-heading-icon"><Layers3 size={22} /></span><div><h2 id="create-layer-title">在域下新建层</h2><p id="create-layer-subtitle">划分独立参数，复用当前域的流量</p></div><button type="button" className="ef-icon-button" aria-label="关闭新建层" onClick={onClose}><X size={19} /></button></div>
      <div className="ef-modal-body">
        <div className="ef-recursive-breadcrumb" aria-label="新层所属域路径">{path.map((node, index) => <span key={`${node.kind}-${node.id}`}><small>{node.kind === 'domain' ? '域' : '层'}</small>{node.name}{index < path.length - 1 && <ArrowRight size={11} />}</span>)}</div>
        {blocked && <p className="cl-warning" role="alert"><CircleAlert size={16} /><span>{blocked}</span></p>}
        <label className="ef-field" htmlFor="create-layer-name">层名称 <span className="ef-required">*</span><input id="create-layer-name" className="input" value={name} maxLength={40} required aria-invalid={nameError || undefined} aria-describedby={nameError ? 'create-layer-name-error' : undefined} onChange={event => { setName(event.target.value); setNameError(false); setError(''); }} placeholder="例如：召回参数层" />{nameError && <span id="create-layer-name-error" className="ef-error" role="alert">请填写层名称。</span>}</label>
        <label className="ef-field" htmlFor="create-layer-description">层说明 <span className="ef-optional">选填</span><textarea id="create-layer-description" className="input" rows={2} maxLength={200} value={description} onChange={event => { setDescription(event.target.value); setError(''); }} placeholder="说明这一层负责的业务参数与实验范围" /></label>
        <ResourceManagementFields value={management} onChange={value => { setManagement(value); setError(''); }} idPrefix="create-layer-management" showErrors />
        <div className="cl-traffic-note"><Layers3 size={17} /><div><strong>继承「{domain?.name ?? domainId}」100% 域内流量</strong><p>对应全局名义流量 {percent(domainGlobalTraffic(domainId))}。完成参数配置后，新层独立分流，与域内其他参数层并行。</p></div></div>
        <fieldset className="cl-parameters"><legend>为新层选择参数 <span>选填 · 已选 {selectedKeys.length} 项 / 可选 {available.length} 项</span></legend><p id="create-layer-parameter-hint" className="cl-hint">可先创建空层，后续从应用下的参数详情分配。也可选择待归层参数完成首次归层，或转移同域内未被实验和子域依赖的参数；来源层须保留至少一个参数。</p>
          <ApplicationParameterBrowser parameterKeys={options.map(option => option.key)} label="新层可分配参数" selection={{ selectedKeys, disabledReason: parameterDisabledReason, onChange: (key, checked) => { if (parameterDisabledReason(key)) return; setSelectedKeys(previous => checked ? previous.includes(key) ? previous : [...previous, key] : previous.filter(item => item !== key)); setError(''); } }} renderState={key => {
            const option = optionsByKey.get(key);
            if (!option) return null;
            const reason = parameterDisabledReason(key);
            return <div className="cl-parameter-source"><strong>{option.sourceLayerName}</strong>{!reason && <small><Check size={11}/>{option.pending ? '可首次分配到新层' : '可转移'}</small>}</div>;
          }} emptyMessage="当前域暂无可分配参数，可先创建待配置层。" />
          {!selectedKeys.length && <div className="cl-empty"><Info size={18} /><div><strong>将创建一个待配置层</strong><p>可以直接保存。分配参数前，本层不参与实验分流，也不能创建实验或子域。</p></div></div>}
        </fieldset>
        {pendingKeys.length > 0 && <section className="rp-assignments cl-assignment-section" aria-label="待归层参数分配"><div className="rp-section-heading"><h3>首次归层 · {pendingKeys.length} 个参数</h3><small>{assignments.filter(row => row.layerId).length} / {assignments.length} 个域已选择</small></div><p className="rp-assignment-hint">{pendingKeys.join('、')} 将归入新层。目标域及祖先路径已固定，请补齐其他继承分支的归属；创建与归层会一次保存。</p><ParameterLayerAssignments rows={assignments} idPrefix="create-layer-assignment" onChange={(id, layerId) => { const updated = { ...pendingSelections, [id]: layerId }; const rows = newLayerRegistrationAssignments({ ...input, pendingSelections: updated }); const editable = new Set(rows.filter(row => !row.forced && !row.automatic).map(row => row.domainId)); setPendingSelections(Object.fromEntries(Object.entries(updated).filter(([key]) => editable.has(key)))); setError(''); }} /></section>}
        {sources.length > 0 && <section className="cl-transfer-preview" aria-label="参数转移预览"><div className="cl-preview-heading"><strong>参数划分预览</strong><span>{sources.length} 个来源层 → 1 个新层</span></div>{sources.map(source => <div key={source.id} className="cl-transfer-row"><div><strong>{source.name}</strong><small>{source.keys.join('、')}</small></div><ArrowRight size={15} /><div><strong>{name.trim() || '新参数层'}</strong><small>转入 {source.keys.length} 个参数</small></div></div>)}</section>}
        {visibleError && visibleError !== validateResourceManagement(management) && <p className="cl-warning" role="alert"><CircleAlert size={16} /><span>{visibleError}</span></p>}
        <div className="ef-inline-note cl-final-note"><Info size={16} /><span>{selectedKeys.length ? '保存后新层将包含所选参数，可以继续创建实验和子域。' : '先建层与先注册参数均可，完成归层后才开放实验与子域。'}已有实验的桶位置及流量比例保持不变。</span></div>
      </div>
      <div className="ef-modal-footer cl-footer"><span>{pendingKeys.length && !assignmentsComplete ? '请补齐各继承分支的归属层' : '本地演示配置 · 保存到当前浏览器'}</span><div><button type="button" className="btn" onClick={onClose}>取消</button><button type="submit" className="btn btn-primary" disabled={Boolean(blocked) || !assignmentsComplete || Boolean(preview?.error)}>{!selectedKeys.length ? '创建待配置层' : pendingKeys.length ? '创建层并归层' : '创建层'} <ArrowRight size={14} /></button></div></div>
    </form>
  </div>;
}
