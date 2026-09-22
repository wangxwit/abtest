import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Check, CircleAlert, Database, FileText, LockKeyhole, Search, Users, X } from 'lucide-react';
import type { Experiment } from '../data';
import { getTopology, saveTopology } from '../traffic';
import { getProfileAttributes, isBuiltinProfileAttribute, planProfileAttributeRegistration } from '../profile-attributes';
import type { ProfileAttribute } from '../profile-attributes';
import { profileAttributeUsage } from '../audience-management';
import { audienceCondition, audienceSummary } from '../audiences';
import AudienceReferenceList from './AudienceReferenceList';

type Props = {experiments:Experiment[];routeId:string|null;creating:boolean;onCloseCreate:()=>void};
const typeNames:Record<ProfileAttribute['type'],string> = {enum:'枚举',number:'数值',boolean:'布尔',string:'文本'};
const operators:Record<ProfileAttribute['type'],string> = {enum:'等于、属于任意值',number:'等于、大于等于、小于等于',boolean:'等于（是／否）',string:'等于、属于任意值'};

function AttributeEditor({experiments,onClose,onSaved}:{experiments:Experiment[];onClose:()=>void;onSaved:(key:string)=>void}) {
  const [key,setKey] = useState(''),[label,setLabel] = useState(''),[type,setType] = useState<ProfileAttribute['type']>('enum');
  const [description,setDescription] = useState(''),[values,setValues] = useState(''),[unit,setUnit] = useState(''),[integer,setInteger] = useState(false),[error,setError] = useState('');
  const formRef=useRef<HTMLFormElement>(null),errorRef=useRef<HTMLParagraphElement>(null),closeRef=useRef(onClose);
  closeRef.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';formRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const handler=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeRef.current();return;}
      if(event.key!=='Tab')return;
      const items=Array.from(formRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')??[]).filter(item=>item.getClientRects().length);
      if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}
      else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}
    };
    document.addEventListener('keydown',handler,true);
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',handler,true);if(previous?.isConnected)previous.focus();};
  },[]);
  useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
  function submit(event:FormEvent) {
    event.preventDefault();
    if(!key.trim()||!label.trim()||!description.trim()){setError('请填写属性 Key、名称和统计口径。');return;}
    const input = {key:key.trim(),label:label.trim(),type,description:description.trim(),...(type==='enum'?{values:values.split(/[\n,，]/).map(value=>value.trim()).filter(Boolean)}:{}),...(type==='number'?{integer,...(unit.trim()?{unit:unit.trim()}:{})}:{})};
    const plan=planProfileAttributeRegistration(input,getTopology());
    if(plan.error||!plan.topology){setError(plan.error??'无法登记画像属性。');return;}
    const invalid=saveTopology(plan.topology,experiments);
    if(invalid){setError(invalid);return;}
    onSaved(input.key);
  }
  return <div className="ef-modal-overlay pat-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><form ref={formRef} className="ef-modal pat-modal" role="dialog" aria-modal="true" aria-labelledby="profile-attribute-title" onSubmit={submit} noValidate>
    <div className="ef-modal-head"><span className="ef-heading-icon"><Database size={22}/></span><div><h2 id="profile-attribute-title">登记画像属性</h2><p>定义属性类型与统计口径，供受众条件选择。</p></div><button type="button" className="ef-icon-button" aria-label="关闭属性登记" onClick={onClose}><X size={19}/></button></div>
    <div className="ef-modal-body"><div className="ef-form-grid"><label className="ef-field">属性 Key <span className="ef-required">*</span><input className="input" aria-label="画像属性 Key" value={key} maxLength={64} onChange={event=>{setKey(event.target.value);setError('');}} placeholder="例如 customer.loyalty_level"/><small className="ef-helper">画像中的稳定标识，工作空间内唯一。</small></label><label className="ef-field">显示名称 <span className="ef-required">*</span><input className="input" aria-label="画像属性名称" value={label} maxLength={60} onChange={event=>{setLabel(event.target.value);setError('');}} placeholder="例如 客户等级"/></label><label className="ef-field">属性类型 <span className="ef-required">*</span><select className="select" aria-label="画像属性类型" value={type} onChange={event=>{setType(event.target.value as ProfileAttribute['type']);setError('');}}>{Object.entries(typeNames).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label></div>
      {type==='enum'&&<label className="ef-field">允许取值 <span className="ef-required">*</span><textarea className="input" aria-label="画像属性枚举值" rows={3} value={values} onChange={event=>{setValues(event.target.value);setError('');}} placeholder={'每行一个值，例如：\nsilver\ngold\nplatinum'}/><small className="ef-helper">也可用逗号分隔；取值区分大小写，不能重复。</small></label>}
      {type==='number'&&<div className="ef-form-grid"><label className="ef-field">计量单位<input className="input" aria-label="画像属性单位" value={unit} maxLength={20} onChange={event=>setUnit(event.target.value)} placeholder="例如 元、次、天"/></label><label className="pat-checkbox"><input type="checkbox" checked={integer} onChange={event=>setInteger(event.target.checked)}/>仅允许非负整数</label></div>}
      <label className="ef-field">定义与统计口径 <span className="ef-required">*</span><textarea className="input" aria-label="画像属性统计口径" rows={3} value={description} maxLength={300} onChange={event=>{setDescription(event.target.value);setError('');}} placeholder="说明含义、统计窗口与缺失情况。例如：首次入组前30天已支付且未退款订单金额，人民币元。"/></label>
      <div className="aud-modal-note"><strong>资格口径：首次入组固定</strong><p>使用同一用户进入实验前的画像快照。登记只声明数据契约，实际画像采集与传输尚未接入。</p><p>属性登记后定义保持固定。若类型或含义变化，请登记新的 Key 并创建受众新版本。</p></div>
      {error&&<p className="aud-error" role="alert" ref={errorRef} tabIndex={-1}><CircleAlert size={14}/>{error}</p>}
    </div><div className="ef-modal-footer"><span>画像属性用于圈选用户，不进入实验参数包。</span><div><button type="button" className="btn" onClick={onClose}>取消</button><button type="submit" className="btn btn-primary">登记属性<ArrowRight size={14}/></button></div></div>
  </form></div>;
}

export default function ProfileAttributeCenter({experiments,routeId,creating,onCloseCreate}:Props) {
  const topology=getTopology(),attributes=getProfileAttributes(topology);
  const [selectedKey,setSelectedKey]=useState('country'),[query,setQuery]=useState(''),[type,setType]=useState('all'),[notice,setNotice]=useState('');
  useEffect(()=>{if(routeId&&attributes.some(attribute=>attribute.key===routeId))setSelectedKey(routeId);},[routeId,attributes]);
  const selected=attributes.find(attribute=>attribute.key===(routeId??selectedKey))??(!routeId?attributes[0]:undefined);
  const visible=attributes.filter(attribute=>(type==='all'||attribute.type===type)&&`${attribute.key} ${attribute.label} ${attribute.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const usage=selected?profileAttributeUsage(selected.key,topology,experiments):null;
  const choose=(key:string)=>{setSelectedKey(key);location.hash=`audiences/attributes/${encodeURIComponent(key)}`;};
  return <div className="pat-page">
    <div className="pat-intro"><Database size={19}/><div><strong>先定义属性，再组合人群</strong><p>统一名称、类型和数据口径。业务圈选时可直接选择这些属性，按条件组合定义受众。</p></div><span>数据采集未接入</span></div>
    {notice&&<p className="aud-notice" role="status"><Check size={15}/>{notice}</p>}
    <div className="pat-toolbar"><label className="search-field"><Search size={14}/><input aria-label="搜索画像属性" value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索属性名称、Key 或口径…"/></label><select aria-label="筛选画像属性类型" value={type} onChange={event=>setType(event.target.value)}><option value="all">全部类型</option>{Object.entries(typeNames).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select><span>{visible.length} / {attributes.length} 个属性</span></div>
    <div className="aud-workbench pat-workbench"><section className="card aud-directory"><header><strong>画像属性目录</strong><small>{visible.length} 项</small></header><nav aria-label="画像属性列表">{visible.map(attribute=><button key={attribute.key} className={`aud-item ${selected?.key===attribute.key?'is-selected':''}`} aria-pressed={selected?.key===attribute.key} onClick={()=>choose(attribute.key)}><Database size={15}/><span><strong>{attribute.label}</strong><small className="pat-key">{attribute.key}</small></span><b>{typeNames[attribute.type]}</b></button>)}</nav>{!visible.length&&<div className="empty-state">没有匹配的画像属性<button className="btn btn-small" onClick={()=>{setQuery('');setType('all');}}>清除筛选</button></div>}</section>
      {selected&&usage?<div className="aud-detail"><section className="card aud-hero"><div className="aud-hero-head"><div><span className="aud-overline">PROFILE ATTRIBUTE</span><h2>{selected.label}</h2><code className="pat-key-detail">{selected.key}</code></div><span className="pat-type-badge">{typeNames[selected.type]}</span></div><div className="pat-metadata"><div><span>资格快照</span><strong>首次入组固定</strong></div><div><span>数据状态</span><strong>未接入</strong></div><div><span>可用运算符</span><strong>{operators[selected.type]}</strong></div>{selected.type==='number'&&<><div><span>取值范围</span><strong>{selected.integer?'非负整数':'非负有限数值'}</strong></div><div><span>计量单位</span><strong>{selected.unit||'无单位'}</strong></div></>}</div><div className="pat-definition"><FileText size={15}/><div><strong>定义与统计口径</strong><p>{selected.description}</p></div></div>{selected.values&&<div className="pat-enums"><strong>{isBuiltinProfileAttribute(selected.key) ? '常用取值（保留开放值兼容）' : '允许取值'}</strong><div>{selected.values.map(value=><span key={value}>{value}</span>)}</div></div>}<div className="aud-version-note"><LockKeyhole size={13}/><span>已登记定义不可原地修改或删除。改变类型或口径时，登记新 Key 并在新的受众版本中选择。</span></div></section>
        <section className="card"><h3>属性引用与影响范围</h3><p>覆盖所有条件分支和祖先继承关系。下方可按受众版本打开引用实验列表；影响总数按域、实验标识去重。</p><div className="pat-impact-stats"><div><strong>{usage.audiences.length}</strong><span>受众版本</span></div><div><strong>{usage.domains.length}</strong><span>引用或继承的域</span></div><div><strong>{usage.experiments.length}</strong><span>引用或继承的实验</span></div></div>
          <div className="aud-ref-heading">直接使用此属性的受众版本</div>{usage.audiences.map(audience=><a className="aud-reference" key={audience.id} href={`#audiences/${encodeURIComponent(audience.id)}`}><Users size={14}/><span><strong>{audience.name}</strong><small>v{audience.version} · {audience.owner}</small><span className="aud-reference-condition">{audienceSummary(audienceCondition(audience,topology))}</span></span><ArrowRight size={13}/></a>)}{!usage.audiences.length&&<div className="aud-no-refs">尚无受众使用此属性。新建受众时可在属性选择器中找到它。</div>}
          <AudienceReferenceList domains={usage.domains} experiments={usage.experiments} topology={topology} context={{attributeKey:selected.key}}/>
        </section>
      </div>:<div className="card aud-not-found" role="status"><CircleAlert size={19}/><div><strong>未找到画像属性</strong><p>此 Key 不在当前目录中。请选择左侧已有属性。</p></div></div>}
    </div>
    {creating&&<AttributeEditor experiments={experiments} onClose={onCloseCreate} onSaved={key=>{onCloseCreate();setQuery('');setType('all');choose(key);setNotice('画像属性已登记，可在受众条件中选择。');}}/>}
  </div>;
}
