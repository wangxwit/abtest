import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, CircleAlert, Code2, Info, X } from 'lucide-react';
import type { Experiment } from '../data';
import type { ParameterType } from '../parameter-definitions';
import { planParameterRegistration } from '../parameter-registration';
import { getTopology, saveTopology } from '../traffic';
import { getCatalog, planServiceRegistration } from '../service-catalog';
import ParameterTags from './ParameterTags';
import type { ServiceDefinition } from '../service-catalog';
import './experiment-flow.css';
import './register-parameter.css';

type Props = { experiments: Experiment[]; onClose: () => void; onRegistered: (key: string) => void; initialServiceId?: string; lockedServiceId?: string };
type RequiredField = 'serviceId' | 'key' | 'name' | 'owner' | 'defaultValue';
const typeOptions: { value: ParameterType; label: string; example: string }[] = [
  { value: 'string', label: 'String · 字符串', example: '"default"' },
  { value: 'number', label: 'Number · 数字', example: '20' },
  { value: 'boolean', label: 'Boolean · 布尔值', example: 'false' },
  { value: 'object', label: 'Object · 对象', example: '{}' },
  { value: 'array', label: 'Array · 数组', example: '[]' },
];

export default function RegisterParameter({ experiments, onClose, onRegistered, initialServiceId, lockedServiceId }: Props) {
  const services = getCatalog(getTopology()).services;
  const initialOwnerService = lockedServiceId ?? initialServiceId;
  const [serviceId, setServiceId] = useState(initialOwnerService ?? '');
  const locked = lockedServiceId !== undefined;
  const effectiveServiceId = lockedServiceId ?? serviceId;
  const currentService = services.find(service => service.id === effectiveServiceId);
  const [addingService, setAddingService] = useState(false);
  const [serviceDraft, setServiceDraft] = useState({id:'',name:'',owner:'',type:'backend' as ServiceDefinition['type']});
  const [serviceError,setServiceError] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [owner, setOwner] = useState(services.find(s => s.id === initialOwnerService)?.owner ?? '');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ParameterType>('string');
  const [defaultText, setDefaultText] = useState('"default"');
  const [errors, setErrors] = useState<Partial<Record<RequiredField, string>>>({});
  const [error, setError] = useState('');
  const dialog = useRef<HTMLFormElement>(null);
  const errorBox = useRef<HTMLParagraphElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const chosenType = typeOptions.find(option => option.value === type)!;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLInputElement>(initialOwnerService ? '#register-parameter-key' : '#register-parameter-serviceId')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
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

  useEffect(() => { if (error) errorBox.current?.focus(); }, [error]);

  function clearError(field?: RequiredField) {
    setError('');
    if (field) setErrors(previous => ({ ...previous, [field]: undefined }));
  }

  function createService() {
    if (locked) { setServiceError('当前注册流程已固定所属服务。'); return; }
    const plan = planServiceRegistration({...serviceDraft,description:''},getTopology());
    if(plan.error||!plan.topology){setServiceError(plan.error??'服务登记失败');return;}
    const invalid=saveTopology(plan.topology,experiments);
    if(invalid){setServiceError(invalid);return;}
    setServiceId(serviceDraft.id.trim());setTagIds([]);setOwner(serviceDraft.owner.trim());setAddingService(false);setServiceError('');clearError('serviceId');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const nextErrors: Partial<Record<RequiredField, string>> = {};
    const latestServices = getCatalog(getTopology()).services;
    if (!latestServices.some(service => service.id === effectiveServiceId)) nextErrors.serviceId = locked ? '当前服务不存在，无法在此服务下注册参数。' : '请选择已登记的所属应用 / 服务。';
    if (locked && serviceId !== lockedServiceId) nextErrors.serviceId = '当前注册流程已固定所属服务，请关闭后从目标服务重新打开。';
    if (!key.trim()) nextErrors.key = '请填写参数 Key。';
    if (!name.trim()) nextErrors.name = '请填写显示名称。';
    if (!owner.trim()) nextErrors.owner = '请填写负责人。';
    let defaultValue: unknown;
    try { defaultValue = JSON.parse(defaultText); }
    catch { nextErrors.defaultValue = '请输入合法 JSON；字符串需要使用双引号，例如 "default"。'; }
    setErrors(nextErrors);
    const firstInvalid = (['serviceId', 'key', 'name', 'owner', 'defaultValue'] as const).find(field => nextErrors[field]);
    if (firstInvalid) { dialog.current?.querySelector<HTMLElement>(`#register-parameter-${firstInvalid}`)?.focus(); return; }
    const plan = planParameterRegistration({ serviceId: effectiveServiceId, tagIds, key: key.trim(), name: name.trim(), type, defaultValue, owner: owner.trim(), description: description.trim() }, experiments, getTopology());
    if (plan.error || !plan.topology) { setError(plan.error ?? '无法登记参数，请检查参数定义。'); return; }
    const invalid = saveTopology(plan.topology, experiments);
    if (invalid) { setError(invalid); return; }
    onRegistered(key.trim());
  }

  const fieldError = (field: RequiredField) => errors[field] && <span id={`register-parameter-${field}-error`} className="ef-error" role="alert">{errors[field]}</span>;

  return <div className="ef-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={dialog} className="ef-modal rp-modal" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="register-parameter-title" aria-describedby="register-parameter-subtitle" noValidate>
      <div className="ef-modal-head"><span className="ef-heading-icon"><Code2 size={22} /></span><div><h2 id="register-parameter-title">注册参数</h2><p id="register-parameter-subtitle">{locked ? `在「${currentService?.name ?? '当前服务'}」下登记参数定义与私有标签` : '登记所属服务、参数定义与应用私有标签'}</p></div><button type="button" className="ef-icon-button" aria-label="关闭注册参数" onClick={onClose}><X size={19} /></button></div>
      <div className="ef-modal-body">
        <div className="rp-section-heading"><h3>参数定义</h3><small>注册时无需选择层</small></div>
        <label className="ef-field" htmlFor="register-parameter-serviceId">所属应用 / 服务 <span className="ef-required">*</span>{locked ? <input id="register-parameter-serviceId" className="input rp-locked-service" readOnly value={currentService ? `${currentService.name} · ${currentService.id}` : lockedServiceId ?? ''} aria-invalid={Boolean(errors.serviceId)} aria-describedby="register-parameter-service-lock" /> : <select id="register-parameter-serviceId" className="select" value={serviceId} required aria-invalid={Boolean(errors.serviceId)} onChange={event => { const next = event.target.value; if (!owner || owner === services.find(s => s.id === serviceId)?.owner) setOwner(services.find(s => s.id === next)?.owner ?? ''); setServiceId(next); setTagIds([]); setServiceError(''); clearError('serviceId'); }}><option value="">请选择已登记的应用 / 服务</option>{services.map(service => <option key={service.id} value={service.id}>{service.name} · {service.id}</option>)}</select>}{fieldError('serviceId')}<span className="ef-helper" id="register-parameter-service-lock">{locked ? '已固定为当前服务，注册时不可切换。实验取值仍受参数层范围约束。' : '参数归属服务负责维护，实验中的参数值由所属层管理。'}</span></label>
        {!locked && <div className="rp-inline-service"><button type="button" className="btn btn-small" onClick={()=>setAddingService(value=>!value)}>{addingService?'收起应用登记':'+ 登记新应用'}</button>{addingService&&<div className="rp-inline-service-form"><p>先保存应用 / 服务档案，再继续注册参数；接入状态为待验证。</p><div className="ef-form-grid"><label className="ef-field">服务标识<input className="input" aria-label="新服务标识" placeholder="例如 search-api" maxLength={64} value={serviceDraft.id} onChange={e=>setServiceDraft(d=>({...d,id:e.target.value}))}/></label><label className="ef-field">服务名称<input className="input" aria-label="新服务名称" maxLength={60} value={serviceDraft.name} onChange={e=>setServiceDraft(d=>({...d,name:e.target.value}))}/></label><label className="ef-field">服务负责人<input className="input" aria-label="新服务负责人" maxLength={60} value={serviceDraft.owner} onChange={e=>setServiceDraft(d=>({...d,owner:e.target.value}))}/></label><label className="ef-field">服务类型<select className="select" aria-label="新服务类型" value={serviceDraft.type} onChange={e=>setServiceDraft(d=>({...d,type:e.target.value as ServiceDefinition['type']}))}><option value="frontend">前端应用</option><option value="backend">后端服务</option><option value="strategy">算法服务</option><option value="gateway">网关 / BFF</option></select></label></div>{serviceError&&<p role="alert" className="pt-error">{serviceError}</p>}<button type="button" className="btn btn-small" onClick={createService}>登记并选择应用</button></div>}</div>}
        <label className="ef-field" htmlFor="register-parameter-key">参数 Key <span className="ef-required">*</span><input id="register-parameter-key" className="input ef-code" value={key} autoComplete="off" spellCheck={false} required maxLength={80} aria-invalid={Boolean(errors.key)} aria-describedby={errors.key ? 'register-parameter-key-error' : 'register-parameter-key-hint'} onChange={event => { setKey(event.target.value); clearError('key'); }} placeholder="例如：ranking.result_limit" />{fieldError('key') || <span id="register-parameter-key-hint" className="ef-helper">工作空间内唯一；3–80 位，使用小写业务前缀与点号，如 ranking.result_limit。</span>}</label>
        <div className="ef-form-grid">
          <label className="ef-field" htmlFor="register-parameter-name">显示名称 <span className="ef-required">*</span><input id="register-parameter-name" className="input" value={name} required maxLength={60} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'register-parameter-name-error' : undefined} onChange={event => { setName(event.target.value); clearError('name'); }} placeholder="例如：推荐结果数量" />{fieldError('name')}</label>
          <label className="ef-field" htmlFor="register-parameter-owner">负责人 <span className="ef-required">*</span><input id="register-parameter-owner" className="input" value={owner} required maxLength={60} aria-invalid={Boolean(errors.owner)} aria-describedby={errors.owner ? 'register-parameter-owner-error' : undefined} onChange={event => { setOwner(event.target.value); clearError('owner'); }} placeholder="例如：推荐策略团队" />{fieldError('owner')}</label>
        </div>
        <label className="ef-field" htmlFor="register-parameter-description">参数说明 <span className="ef-optional">选填</span><textarea id="register-parameter-description" className="input" rows={2} maxLength={300} value={description} onChange={event => { setDescription(event.target.value); clearError(); }} placeholder="说明参数的业务用途与使用方式" /></label>
        <label className="ef-field" htmlFor="register-parameter-type">参数类型 <span className="ef-required">*</span><select id="register-parameter-type" className="select" value={type} onChange={event => { const nextType = event.target.value as ParameterType; setType(nextType); setDefaultText(typeOptions.find(option => option.value === nextType)!.example); clearError('defaultValue'); }}>{typeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="ef-field" htmlFor="register-parameter-defaultValue">默认值 · JSON <span className="ef-required">*</span><textarea id="register-parameter-defaultValue" className="input ef-code" rows={3} value={defaultText} spellCheck={false} required aria-invalid={Boolean(errors.defaultValue)} aria-describedby={errors.defaultValue ? 'register-parameter-defaultValue-error' : 'register-parameter-default-hint'} onChange={event => { setDefaultText(event.target.value); clearError('defaultValue'); }} />{fieldError('defaultValue') || <span id="register-parameter-default-hint" className="ef-helper">{chosenType.label} 示例：<code>{chosenType.example}</code>。默认值用于新实验的初始配置；生产 SDK 下发尚未实现。</span>}</label>
        <div className="ef-field"><span>业务标签 <span className="ef-optional">选填 · 可多选</span></span><ParameterTags key={effectiveServiceId} serviceId={effectiveServiceId} value={tagIds} onChange={setTagIds} experiments={experiments}/><span className="ef-helper">标签仅属于当前应用，可用于组织本应用的多个参数。创建标签立即保存到当前应用，参数标签绑定在注册时保存。</span></div>
        {error && <p ref={errorBox} tabIndex={-1} className="rp-warning" role="alert"><CircleAlert size={16} /><span>{error}</span></p>}
        <div className="ef-inline-note"><Info size={16} /><span>注册后状态为“待归层”。可先完成参数登记，再在参数详情分配到层；完成归层后才能用于实验。</span></div>
      </div>
      <div className="ef-modal-footer rp-footer"><span>本地保存；不改变现有实验取值或流量</span><div><button type="button" className="btn" onClick={onClose}>取消</button><button type="submit" className="btn btn-primary">注册参数 <ArrowRight size={14} /></button></div></div>
    </form>
  </div>;
}
