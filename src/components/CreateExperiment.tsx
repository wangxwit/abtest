import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, Copy, Download, Info, Layers3, Save, ShieldCheck, Target, SlidersHorizontal, Users, CheckCheck } from 'lucide-react';
import { metrics, type Experiment } from '../data';
import { domains, layers, childDomains, domainGlobalTraffic, domainScope, layerScope, nodePath, findAvailableBucketRanges, layerAudienceCapacity, candidateLayerAudience, explainAllocationConflicts, validateAllocation, getParameterDefinition, compatibleLayers, getTopology, isParameterPending } from '../traffic';
import { BUCKET_COUNT, bucketCount, formatBucketRanges, trafficToBucketCount } from '../bucket-ranges';
import { formatPercent } from '../format-percent';
import { getAudience, describeExpression, getAudienceExpression, domainEffectiveAudience, audienceSummary, audienceIsEmpty } from '../audiences';
import { addParametersToVariants } from '../variant-draft-operations';
import { getParameterService } from '../service-catalog';
import { createExperimentDraft, loadExperimentDraft, saveExperimentDraft, markExperimentDraftSubmitted, setDraftLeaveGuard, DRAFT_PREFIX, type ExperimentDraft, type ExperimentDraftForm as Form, type DraftSection } from '../experiment-drafts';
import { validateDraftForm, draftParameterKeys, type DraftIssue } from '../experiment-draft-validation';
import { initialDraftForm } from '../experiment-draft-initial';
import ExperimentGroupsEditor from './ExperimentGroupsEditor';
import ParameterPicker from './ParameterPicker';
import AudienceSelect from './AudienceSelect';
import TrafficEstimate from './TrafficEstimate';
import './experiment-flow.css';
import './experiment-workspace.css';

type Props={existing:Experiment[];onClose:()=>void;onCreate:(experiment:Experiment)=>string|{experimentId:string};draftId?:string;initialLayerId?:string;copyExperimentId?:string;onDraftReady:(id:string)=>void};
const sections=[{id:'goal' as const,name:'实验目标',icon:Target,description:'明确假设与衡量标准'},{id:'traffic' as const,name:'范围与流量',icon:Layers3,description:'确定层、受众和流量'},{id:'groups' as const,name:'分组与参数',icon:SlidersHorizontal,description:'配置各组的实验方案'},{id:'review' as const,name:'检查与提交',icon:CheckCheck,description:'检查完整配置并提交审核'}];
function initialParameterValue(key:string){return getParameterDefinition(key)?.defaultValue??(key.endsWith('cache_ttl')?60:'baseline');}
function orderedDomains() {
  const output: { id: string; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    const current = domains.find(d => d.id === id)!;
    if (current.parentLayerId !== null) output.push({ id, depth: Math.max(0, depth - 1) });
    layers.filter(l => l.domainId === id).forEach(l => childDomains(l.id).forEach(d => visit(d.id, depth + 1)));
  };
  domains.filter(d => d.parentLayerId === null).forEach(d => visit(d.id, 0));
  return output;
}

export default function CreateExperiment({existing,onClose,onCreate,draftId,initialLayerId,copyExperimentId,onDraftReady}:Props){
 const bootstrap=useRef<{draft:ExperimentDraft|null;form:Form;error:string;submitted?:string}> (null!);
 if(!bootstrap.current){
  const loaded=draftId?loadExperimentDraft(draftId):null;
  const source=copyExperimentId?existing.find(e=>e.id===copyExperimentId):undefined;
  const error=draftId?loaded&&!loaded.ok?loaded.error:loaded?.ok&&!loaded.draft?'该草稿不存在，已有数据没有被替换。':'':copyExperimentId&&!source?'被复制的实验不存在。':initialLayerId&&!layers.some(l=>l.id===initialLayerId&&l.role!=='routing'&&layerScope(l.id).length)?'当前层不可用于创建实验，请选择已配置参数的普通层。':'';
  const draft=loaded?.ok?loaded.draft:null;
  bootstrap.current={draft,form:draft?.form??initialDraftForm(getTopology(),{layerId:initialLayerId,source}),error,submitted:draft?(draft.submittedExperimentId??existing.find(e=>e.sourceDraftId===draft.id)?.id):undefined};
 }
 const [form,setForm]=useState<Form>(bootstrap.current.form);
 const [section,setSection]=useState<DraftSection>(bootstrap.current.draft?.section??'goal');
 const [selectedVariantId,setSelectedVariantId]=useState(bootstrap.current.draft?.selectedVariantId??form.variants[0].id);
 const [record,setRecord]=useState<ExperimentDraft|null>(bootstrap.current.draft);
 const [saveState,setSaveState]=useState<'saved'|'dirty'|'error'>('saved');
 const [saveError,setSaveError]=useState(''),[actionError,setActionError]=useState('');
 const [focusTarget,setFocusTarget]=useState<{variantId:string;field?:string;parameterKey?:string;nonce:number}|undefined>();
 const [parameterResetUndo,setParameterResetUndo]=useState<Form['variants']|null>(null);
 const [checked,setChecked]=useState(false);
 const recordRef=useRef(record),latest=useRef({form,section,selectedVariantId});latest.current={form,section,selectedVariantId};
 const savedPayload=useRef(record?JSON.stringify({form:record.form,section:record.section,selectedVariantId:record.selectedVariantId}):'');
 const initialized=useRef(false),blocked=useRef(false),completed=useRef(false);
 const persistRef=useRef<()=>boolean>(()=>true);
 const panelRef=useRef<HTMLDivElement>(null);
 const submitted=record?.submittedExperimentId??bootstrap.current.submitted;
 const issues=useMemo(()=>validateDraftForm(form,existing,getTopology()),[form,existing,getTopology()]);
 const errors:Record<string,string>={};for(const issue of issues){if(issue.variantId)errors[`${issue.field==='variant-name'?'name':issue.field==='variant-weight'?'weight':issue.field==='variant-role'?'role':'value'}-${issue.variantId}`]??=issue.message;else if(issue.field)errors[issue.field]??=issue.message;}
 if(issues.some(i=>i.section==='groups'))errors.variants=`${issues.filter(i=>i.section==='groups').length} 项待完善，可在「检查与提交」中逐项定位。`;
 const domain=domains.find(d=>d.id===form.domainId),layer=layers.find(l=>l.id===form.layerId);
 const domainLayers=layers.filter(l=>l.domainId===form.domainId);
 const selectedAudience=form.audienceId?getAudience(form.audienceId,getTopology()):undefined;
 const audienceSelection={...(form.audienceId?{audienceId:form.audienceId}:{}),audience:selectedAudience?.name??'全部活跃用户'};
 const inheritedAudience=audienceSummary(domainEffectiveAudience(form.domainId,getTopology()));
 const effectiveAudienceLabel=!domain?'未选择实验域':form.audienceId&&!selectedAudience?'受众版本不可用，需重新选择':`${inheritedAudience}${selectedAudience?`；并且 ${describeExpression(getAudienceExpression(selectedAudience),getTopology())}`:''}`;
 const availableRanges=findAvailableBucketRanges(form.layerId,form.traffic,existing,undefined,getTopology(),audienceSelection);
 const capacity=layerAudienceCapacity(form.layerId,existing,getTopology(),audienceSelection);
 const requestedBuckets=trafficToBucketCount(form.traffic),availableBuckets=Math.round(capacity.available*100);
 const plannedTraffic=availableRanges?bucketCount(availableRanges)/100:null;
 const emptyAudience=audienceIsEmpty(candidateLayerAudience(form.layerId,audienceSelection,getTopology()));
 const conflicts=explainAllocationConflicts({id:'',domainId:form.domainId,layerId:form.layerId,bucketStart:0,traffic:100,...audienceSelection},existing,getTopology());
 const domainGlobal=domainGlobalTraffic(form.domainId),globalTraffic=domainGlobal*form.traffic/100;
 const allowedParameters=layerScope(form.layerId),inheritedScope=domainScope(form.domainId),breadcrumb=nodePath('layer',form.layerId);
 const declaredKeys=draftParameterKeys(form);
 const involvedServices=[...new Map(declaredKeys.map(key=>getParameterService(key,getTopology())).filter(s=>s!==undefined).map(s=>[s.id,s])).values()];
 const compatible=declaredKeys.length?compatibleLayers(declaredKeys):[];
 const error=(field:string)=>(checked||!!form[field as keyof Form]||!['name','key','metric'].includes(field))&&errors[field]?<span className="ef-error" role="alert">{errors[field]}</span>:null;
 const setSaved=(draft:ExperimentDraft)=>{recordRef.current=draft;setRecord(draft);savedPayload.current=JSON.stringify({form:draft.form,section:draft.section,selectedVariantId:draft.selectedVariantId});setSaveState('saved');setSaveError('');};
 const persist=():boolean=>{
  if(completed.current||bootstrap.current.error)return true;
  if(blocked.current)return false;
  if(recordRef.current?.submittedExperimentId)return true;
  const payload=JSON.stringify(latest.current);if(recordRef.current&&payload===savedPayload.current)return true;
  const result=recordRef.current?saveExperimentDraft({id:recordRef.current.id,revision:recordRef.current.revision,...latest.current}):createExperimentDraft(latest.current);
  if(!result.ok){blocked.current=result.code==='conflict'||result.code==='submitted';setSaveError(result.error);setSaveState('error');return false;}
  const first=!recordRef.current;setSaved(result.draft);if(first)onDraftReady(result.draft.id);return true;
 };
 persistRef.current=persist;
 useEffect(()=>{if(initialized.current)return;initialized.current=true;if(!bootstrap.current.error&&!bootstrap.current.draft)persistRef.current();},[]);
 useEffect(()=>{if(bootstrap.current.error||completed.current||submitted)return;if(JSON.stringify(latest.current)===savedPayload.current)return;setSaveState(blocked.current?'error':'dirty');const timeout=setTimeout(()=>persistRef.current(),400);return()=>clearTimeout(timeout);},[form,section,selectedVariantId,submitted]);
 useEffect(()=>{
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(!persistRef.current()){event.preventDefault();event.returnValue='';}};
  const external=(event:StorageEvent)=>{if(event.key!==DRAFT_PREFIX+recordRef.current?.id)return;const loaded=loadExperimentDraft(recordRef.current!.id);if(!loaded.ok||!loaded.draft||loaded.draft.revision!==recordRef.current!.revision){blocked.current=true;setSaveState('error');setSaveError('草稿已在其他页面更新，自动保存已暂停。当前内容保留，可另存或加载最新版本。');}};
  setDraftLeaveGuard(()=>persistRef.current());window.addEventListener('beforeunload',beforeUnload);window.addEventListener('storage',external);
  return()=>{persistRef.current();setDraftLeaveGuard(null);window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('storage',external);};
 },[]);
 useEffect(()=>{if(!record||submitted||completed.current)return;if(existing.some(e=>e.sourceDraftId===record.id)){blocked.current=true;setSaveState('error');setSaveError('此草稿已在其他页面提交。当前页面输入仍保留，可另存为新草稿、导出，或加载已提交版本。');}},[existing,record,submitted]);
 const update=<K extends keyof Form>(key:K,value:Form[K])=>{if(key==='variants')setParameterResetUndo(null);setActionError('');setForm(old=>({...old,[key]:value}));};
 const chooseLayer=(id:string,domainId=form.domainId)=>{setParameterResetUndo(null);setForm(old=>({...old,domainId,layerId:id}));};
 const chooseDomain=(id:string)=>{const first=layers.find(l=>l.domainId===id&&l.role!=='routing'&&layerScope(l.id).length);chooseLayer(first?.id??'',id);};
 const addParameters=(keys:string[]):boolean=>{if(keys.some(key=>!allowedParameters.includes(key)||isParameterPending(key)||!getParameterService(key,getTopology())))return false;try{update('variants',addParametersToVariants(form.variants,Object.fromEntries(keys.map(key=>[key,initialParameterValue(key)]))));return true;}catch{setActionError('所有分组必须为有限 JSON 对象后才能批量加入参数；原文已保留。');return false;}};
 const navigateSection=(next:DraftSection)=>{setSection(next);setActionError('');requestAnimationFrame(()=>panelRef.current?.focus({preventScroll:true}));};
 const locate=(issue:DraftIssue)=>{setSection(issue.section);if(issue.variantId){setSelectedVariantId(issue.variantId);setFocusTarget({variantId:issue.variantId,field:issue.field,parameterKey:issue.parameterKey,nonce:Date.now()});}else requestAnimationFrame(()=>{const element=panelRef.current?.querySelector<HTMLElement>(issue.field==='guardrails'?'[data-field=guardrails]':issue.field==='variants'?'.eg-editor':issue.field==='audienceId'?'#experiment-audience':`[name="${issue.field}"]`);element?.focus();element?.scrollIntoView({block:'center'});});};
 const saveCopy=()=>{const result=createExperimentDraft(latest.current);if(!result.ok){setSaveError(result.error);return;}blocked.current=false;setSaved(result.draft);onDraftReady(result.draft.id);};
 const loadLatest=()=>{if(!recordRef.current)return;const result=loadExperimentDraft(recordRef.current.id);if(!result.ok||!result.draft){setSaveError(result.ok?'草稿已不存在。':result.error);return;}if(!window.confirm('加载最新版本将替换当前页面内容。需要保留当前输入时，请先选择另存草稿或导出。'))return;blocked.current=false;setForm(result.draft.form);setSection(result.draft.section);setSelectedVariantId(result.draft.selectedVariantId??result.draft.form.variants[0].id);setSaved(result.draft);};
 const exportDraft=()=>{const blob=new Blob([JSON.stringify({schemaVersion:1,...latest.current},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${form.name||'实验草稿'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 const submit=()=>{
  setChecked(true);const fresh=validateDraftForm(form,existing,getTopology());if(fresh.length){setSection('review');setActionError('请先修正下方问题，草稿可以继续保存。');return;}
  if(!persist()){setSection('review');return;}const currentRecord=recordRef.current!;
  const previous=existing.find(e=>e.sourceDraftId===currentRecord.id);if(previous){completed.current=true;location.hash=`experiments/${encodeURIComponent(previous.id)}`;return;}
  const ranges=findAvailableBucketRanges(form.layerId,form.traffic,existing,undefined,getTopology(),audienceSelection);
  if(!ranges?.length||!domain||!layer){setActionError('流量配置已变化，请重新检查。');return;}
  const now=new Date();const id=Math.max(1028,...existing.map(e=>Number(e.id.replace('EXP-',''))||0))+1;
  const candidate:Experiment={id:`EXP-${id}`,sourceDraftId:currentRecord.id,key:form.key.trim(),name:form.name.trim(),description:form.description.trim()||'尚未填写实验背景。',hypothesis:form.hypothesis.trim(),type:'frontend',status:'review',owner:'陈思远',team:'实验平台',traffic:form.traffic,participants:0,lift:null,significant:false,metric:form.metric,date:now.toLocaleDateString('sv-SE'),duration:0,layer:layer.name,...audienceSelection,unit:domain.unit,guardrails:form.guardrails,domainId:domain.id,layerId:layer.id,bucketStart:ranges[0].start/100,bucketRanges:ranges,parameterKeys:[...declaredKeys].sort(),variants:form.variants.map(v=>({...v,name:v.name.trim()})),activities:[{title:'从工作区提交实验审核并预留流量',time:now.toLocaleString('zh-CN'),person:'陈思远'}],health:'healthy'};
  const invalid=validateAllocation(candidate,existing,getTopology());if(invalid){setActionError(invalid);return;}
  completed.current=true;const result=onCreate(candidate);if(typeof result==='string'){completed.current=false;setActionError(result);return;}
  markExperimentDraftSubmitted(currentRecord.id,result.experimentId,currentRecord.revision);
 };
 if(bootstrap.current.error)return <section className="card ew-load-error" role="alert"><CircleAlert size={25}/><h1>暂时无法打开草稿</h1><p>{bootstrap.current.error}</p><button className="btn" onClick={onClose}>返回实验列表</button></section>;
 if(submitted)return <section className="card ew-load-error"><CheckCheck size={25}/><h1>这份草稿已提交</h1><p>继续查看实验的审核与运行状态。</p><a className="btn btn-primary" href={`#experiments/${encodeURIComponent(submitted)}`}>查看实验 {submitted}</a><button className="btn" onClick={onClose}>返回实验列表</button></section>;
 return <div className="experiment-workspace">
  <div className="ew-top"><button className="ew-back" onClick={()=>{if(persist())onClose();}}><ArrowLeft size={14}/>返回实验列表</button><div className="ew-title"><div><span className="ew-eyebrow">EXPERIMENT DRAFT</span><h1>{form.name||'新建实验'}</h1></div><div className="ew-actions"><span className={`ew-save-state ${saveState}`} role="status">{saveState==='saved'?'已保存到本机':saveState==='dirty'?'正在保存…':'尚未保存'}</span><button className="btn" onClick={()=>{blocked.current=false;persist();}}><Save size={14}/>保存草稿</button><button className="btn btn-primary" onClick={()=>{setChecked(true);navigateSection('review');}}>检查并提交<ArrowRight size={14}/></button></div></div><p className="ew-subtitle">自由切换配置区，未完成内容也会保存。草稿不预占流量。</p></div>
  {saveError&&<div className="ew-save-error" role="alert"><CircleAlert size={18}/><div><strong>当前内容尚未保存</strong><p>{saveError}</p><div><button className="btn btn-small" onClick={saveCopy}><Copy size={13}/>另存当前草稿</button>{record&&<button className="btn btn-small" onClick={loadLatest}>加载最新版本</button>}<button className="btn btn-small" onClick={exportDraft}><Download size={13}/>导出当前内容</button></div></div></div>}
  <div className="ew-layout"><nav className="ew-navigation" aria-label="实验配置分区">{sections.map((item,index)=>{const pending=item.id==='review'?issues.length:issues.filter(i=>i.section===item.id).length;const untouched=item.id==='goal'?!form.name&&!form.key:item.id==='traffic'?!form.layerId:item.id==='groups'?!declaredKeys.length:false;return <button key={item.id} onClick={()=>navigateSection(item.id)} className={section===item.id?'selected':''} aria-current={section===item.id?'step':undefined}><span className="ew-nav-icon"><item.icon size={17}/></span><span><strong>{item.name}</strong><small>{item.id==='review'?pending?`${pending} 项待处理`:'可以提交':untouched?'未配置':pending?`${pending} 项待修正`:'已完成'}</small></span>{!pending?<Check size={14}/>:<i>{index+1}</i>}</button>})}<div className="ew-scope-summary"><span>当前实验范围</span><strong>{domain?.name??'尚未选择域'}</strong><p>{layer?.name??'尚未选择参数层'}</p><small>{form.variants.length} 个分组 · {declaredKeys.length} 个参数</small></div></nav>
  <div className="ew-main" ref={panelRef} tabIndex={-1}><div className="ew-section-heading"><div><span>{String(sections.findIndex(s=>s.id===section)+1).padStart(2,'0')}</span><h2>{sections.find(s=>s.id===section)?.name}</h2></div><p>{sections.find(s=>s.id===section)?.description}</p></div>
  {actionError&&<p className="ew-action-error" role="alert">{actionError}</p>}
  <section hidden={section!=='goal'} className="ew-section" aria-label="实验目标配置"><div className="ew-card"><h3>实验信息</h3>
          <label className="ef-field">实验名称 <span className="ef-required">*</span><input name="name" className="input" autoComplete="off" placeholder="例如：首页推荐算法升级" maxLength={60} value={form.name} onChange={e => update('name', e.target.value)} aria-invalid={(checked||!!form.name)&&!!errors.name} />{error('name')}</label>
          <label className="ef-field">实验标识 <span className="ef-required">*</span><input name="key" className="input ef-code" autoComplete="off" placeholder="homepage_recommend_v3" value={form.key} onChange={e => update('key', e.target.value)} aria-invalid={(checked||!!form.key)&&!!errors.key} />{error('key') || <span className="ef-helper">当前工作空间内唯一，用于 SDK 接入；仅支持小写字母、数字和下划线。</span>}</label>
          <label className="ef-field">实验描述<textarea className="input" placeholder="描述业务背景与本次计划验证的方案…" rows={3} value={form.description} onChange={e => update('description', e.target.value)} /></label>
          <label className="ef-field">实验假设 <span className="ef-optional">选填</span><input className="input" placeholder="如果优化推荐排序，预计人均点击次数将提升 3%" value={form.hypothesis} onChange={e => update('hypothesis', e.target.value)} /></label>

</div><div className="ew-card"><h3>衡量指标</h3>
          <label className="ef-field">核心指标 <span className="ef-required">*</span><select name="metric" className="select" value={form.metric} onChange={e => update('metric', e.target.value)}><option value="">请选择核心指标</option>{metrics.filter(m => m.category !== '护栏指标').map(m => <option key={m.key}>{m.name}</option>)}</select><span className="ef-helper">{metrics.find(m => m.name === form.metric)?.description}</span>{error('metric')}</label>
          <div className="ef-field" tabIndex={-1} data-field="guardrails">护栏指标<span className="ef-helper">用于观察业务稳定性，触发阈值后应暂停实验并排查。</span><div className="ef-guardrail-options">{metrics.filter(m => m.category === '护栏指标').map(m => <label key={m.key} className={`ef-guardrail-option ${form.guardrails.includes(m.name) ? 'selected' : ''}`}><input type="checkbox" checked={form.guardrails.includes(m.name)} onChange={e => update('guardrails', e.target.checked ? [...form.guardrails, m.name] : form.guardrails.filter(g => g !== m.name))} /><span><strong>{m.name}</strong><small>{m.name === '支付成功率' ? '相对下降超过 0.5% 时预警' : '相对上升超过 10% 时预警'}</small></span><ShieldCheck size={18} /></label>)}</div></div>

</div></section>
<section hidden={section!=='traffic'} className="ew-section" aria-label="实验范围与流量"><div className="ew-card">          <label className="ef-field">选择实验域<select name="domainId" className="select" value={form.domainId} onChange={e => chooseDomain(e.target.value)}><option value="">请选择实验域</option>{orderedDomains().map(({ id, depth }) => { const d = domains.find(value => value.id === id)!; const available = layers.some(l => l.domainId === id && l.role !== 'routing' && layerScope(l.id).length > 0); return <option key={id} value={id} disabled={!available}>{'　'.repeat(depth)}{depth ? '↳ ' : ''}{d.name} · 全局 {formatPercent(domainGlobalTraffic(id))}%{available ? '' : ' · 待配置'}</option>; })}</select><span className="ef-helper">按真实父子关系展示可承载实验的域；待配置层须先分配参数，默认根域仅负责路由。</span></label>{domain?<>

          <div className="ef-recursive-breadcrumb" aria-label="完整分配路径">{breadcrumb.map((node, index) => <span key={node.kind + node.id}><small>{node.kind === 'domain' ? '域' : '层'}</small>{node.name}{index < breadcrumb.length - 1 && <ArrowRight size={11} />}</span>)}</div>

          <div className="ef-form-grid"><label className="ef-field">参数层{domain.mode === 'overlapping' ? <select name="layerId" className="select" value={form.layerId} onChange={e => chooseLayer(e.target.value)}>{domainLayers.map(l => <option key={l.id} value={l.id} disabled={l.role === 'routing' || layerScope(l.id).length === 0}>{l.name}{layerScope(l.id).length === 0 ? ' · 待配置' : ''}</option>)}</select> : <input name="layerId" className="input" value={(layer?.name??'未选择参数层') + ' · 固定'} readOnly />}<span className="ef-helper">{domain.mode === 'overlapping' ? '当前层只拥有本域继承参数的一部分；同层实验与子域互斥。' : '全参数指父层作用域内全部参数，不扩展到全局。'}</span>{error('layerId')}</label><label className="ef-field">随机化单元<input className="input ef-code" value={domain.unit} readOnly /><span className="ef-helper">继承当前域配置，沿递归路径保持随机化单元一致。</span></label></div>
          <AudienceSelect id="experiment-audience" label="实验受众版本" value={form.audienceId} onChange={id => update('audienceId', id)} inheritedLabel={inheritedAudience} inheritedCondition={domainEffectiveAudience(form.domainId, getTopology())} experiments={existing} allocation={{ layerId: form.layerId, traffic: form.traffic }} />{error('audienceId')}
          {emptyAudience && <p className="ef-error" role="alert">本受众与祖先条件相互矛盾，当前有效人群为空。请更换受众版本或实验域。</p>}
          {conflicts.length > 0 && <details className="ew-disclosure"><summary>查看 {conflicts.length} 个需避开的配置</summary><section className="ef-conflict-list" aria-label="受众潜在冲突列表"><strong>当前受众需避开的 {conflicts.length} 个配置</strong><p>{availableRanges !== null ? '已避开下列潜在受众冲突，按申请比例自动组合可用桶段。' : '列出当前层需避开的受众配置及其桶段。平台会组合空闲桶段；总容量不足时请降低比例。'}</p>{conflicts.map(conflict => <article key={`${conflict.kind}:${conflict.id}`}><div><strong>{conflict.kind === 'domain' ? '子域' : '实验'} · {conflict.name}</strong></div><details className="ef-conflict-buckets" open={conflict.bucketRanges.length <= 4}><summary>占用桶段 · {conflict.bucketRanges.length} 段</summary><code>{formatBucketRanges(conflict.bucketRanges)}</code></details><p>{conflict.reason}{conflict.unknown ? ' · 保守预留，不按互斥处理' : ''}</p>{conflict.witness && <details><summary>可能同时满足的画像示例</summary><pre>{JSON.stringify(conflict.witness, null, 2)}</pre></details>}</article>)}</section></details>}
          <div className="ef-field ef-traffic-control"><div className="ef-label-row"><label htmlFor="traffic-range">本域内实验流量 <span className="ef-required">*</span></label><span className="ef-percent-input"><input name="traffic" type="number" aria-label="实验流量百分比" min={0.01} max={100} step={0.01} value={form.traffic} onChange={e => update('traffic', Number(e.target.value))} />%</span></div><input id="traffic-range" type="range" min={0.01} max={100} step={0.01} value={form.traffic} onChange={e => update('traffic', Number(e.target.value))} /><div className="ef-range-labels"><span>0.01% / 1 桶</span><span>当前受众可用 {availableBuckets} 桶 · {formatPercent(capacity.available)}%</span><span>100%</span></div>{error('traffic')}</div>
          <div className="ef-allocation-preview"><div><span>拟分配当前层桶</span><strong className={availableRanges === null ? 'ef-negative' : ''}>{availableRanges === null ? '尚未生成分配' : `${bucketCount(availableRanges)} 桶 · ${plannedTraffic}%`}</strong><small>{requestedBuckets === null ? '比例精度无效' : `申请 ${requestedBuckets} / ${BUCKET_COUNT} 桶，平台自动组合空闲桶段`}</small></div><div><span>申请折算全局名义流量</span><strong>{requestedBuckets === null ? '—' : `${formatPercent(globalTraffic)}%`}</strong><small>父域 {formatPercent(domainGlobal)}% × 申请 {form.traffic}%；仅比例折算，尚未生效</small></div></div>
          {availableRanges && <details className="ef-bucket-range-preview"><summary>拟分配桶段 · {availableRanges.length} 段 <span>整数桶号，左闭右开</span></summary><code>{formatBucketRanges(availableRanges)}</code><p>平台自动分配，无需填写桶号；草稿不预占流量，提交审核时重新检查。</p></details>}
          <div className="ef-inline-note ef-note-neutral"><Info size={16} /><span>{capacity.reusable > 0 ? `当前条件可复用 ${capacity.reusable}% 已有桶坐标，受众互斥时同桶可承载多个配置。` : '当前条件暂无可证明互斥的桶坐标复用。'} 受众按入组前固定画像判定；缺少属性不视为合格，未匹配不改投其他桶。</span></div>
          <TrafficEstimate nominalPercent={globalTraffic} audienceLabel={effectiveAudienceLabel} />
</>:<div className="ew-empty"><Layers3 size={24}/><p>先选择域，再确定参数层、受众和流量。</p></div>}</div></section>
<section hidden={section!=='groups'} className="ew-section" aria-label="实验分组与参数"><div className="ew-card"><div className="ew-parameter-title"><h3>实验参数</h3><span>{declaredKeys.length} 个 Key · {involvedServices.length} 个应用</span></div>
{!layer?<div className="ew-empty"><p>先选择参数层后，可从应用目录加入参数；已填写的分组内容会保留。</p><button className="btn" onClick={()=>navigateSection('traffic')}>选择实验范围</button></div>:<details className="ew-disclosure" open={declaredKeys.length===0}><summary>按应用与标签选择参数</summary><ParameterPicker allowedKeys={allowedParameters} selectedKeys={declaredKeys} onAdd={addParameters} existing={existing}/></details>}
{declaredKeys.some(key=>!allowedParameters.includes(key))&&<div className="ew-action-error"><p>部分参数不在当前层范围内，原文已保留。</p>{compatible.map(candidate=><button className="btn btn-small" key={candidate.id} onClick={()=>chooseLayer(candidate.id,candidate.domainId)}>使用 {nodePath('layer',candidate.id).map(n=>n.name).join(' / ')}</button>)}</div>}
{layer&&<details className="ew-disclosure"><summary>初始化与配置说明</summary><p>初始化会将当前层的全部参数默认值写入每个分组，可立即撤销；未登记默认值的历史参数使用示例初值。</p><button className="btn btn-small" onClick={()=>{setParameterResetUndo(form.variants);const value=JSON.stringify(Object.fromEntries(allowedParameters.map(key=>[key,initialParameterValue(key)])),null,2);setForm(old=>({...old,variants:old.variants.map(v=>({...v,value}))}));}}>用当前层参数初始化所有组</button>{parameterResetUndo&&<button className="btn btn-small" onClick={()=>{update('variants',parameterResetUndo);}}>撤销初始化</button>}</details>}
</div><ExperimentGroupsEditor variants={form.variants} onChange={variants=>update('variants',variants)} traffic={form.traffic} globalTraffic={globalTraffic} errors={errors} selectedVariantId={selectedVariantId} onSelectedVariantChange={setSelectedVariantId} focusTarget={focusTarget} active={section==='groups'} saveState={saveState} saveError={saveError}/></section>
<section hidden={section!=='review'} className="ew-section" aria-label="实验提交检查"><div className={`ew-check-banner ${issues.length?'pending':'ready'}`}><ShieldCheck size={24}/><div><h3>{issues.length?`还有 ${issues.length} 项需要完善`:'配置检查通过'}</h3><p>{issues.length?'点击问题可进入对应配置，未完成的内容可以保存在草稿中。':'提交时将再次按最新配置校验并预留流量，进入待审核状态。'}</p></div></div>
{issues.length>0&&<div className="ew-issues" aria-label="待修正问题列表">{issues.map(issue=><button key={issue.id} onClick={()=>locate(issue)}><span>{sections.find(s=>s.id===issue.section)?.name}{issue.variantId?` · ${form.variants.find(v=>v.id===issue.variantId)?.name||'未命名组'}`:''}</span><strong>{issue.message}</strong><ArrowRight size={15}/></button>)}</div>}
<div className="ew-card"><h3>提交内容</h3><dl className="ew-review-summary"><div><dt>实验名称</dt><dd>{form.name||'未填写'}</dd></div><div><dt>实验标识</dt><dd>{form.key||'未填写'}</dd></div><div><dt>实验路径</dt><dd>{breadcrumb.map(n=>n.name).join(' → ')||'未选择'}</dd></div><div><dt>受众条件</dt><dd>{effectiveAudienceLabel}</dd></div><div><dt>申请流量</dt><dd>{form.traffic}% · {requestedBuckets??'—'} 桶 · 全局名义 {formatPercent(globalTraffic)}%</dd></div><div><dt>核心指标</dt><dd>{form.metric||'未选择'}</dd></div><div><dt>护栏指标</dt><dd>{form.guardrails.join('、')||'未配置'}</dd></div><div><dt>参数范围</dt><dd>{declaredKeys.length?declaredKeys.join('、'):issues.some(i=>i.field==='variant-value')?'参数原文待修正':'无参数覆盖（A/A）'}</dd></div></dl></div>
<div className="ew-card"><h3>分组配置复核</h3><p className="ef-helper">每个分组保存完整配置；展开查看原文，或返回该组修改。</p><div className="ew-review-groups">{form.variants.map(v=><details key={v.id}><summary><span>{v.name||'未命名组'} <small>{v.role==='control'?'对照组':'实验组'}</small></span><strong>{formatPercent(v.weight)}%</strong></summary><pre>{v.value}</pre><button className="btn btn-small" onClick={()=>locate({id:v.id,section:'groups',variantId:v.id,field:'variant-value',message:''})}>编辑此组<ArrowRight size={12}/></button></details>)}</div></div>
{availableRanges&&<details className="ew-disclosure"><summary>查看拟分配桶段</summary><code>{formatBucketRanges(availableRanges)}</code><p>草稿未预留，提交时重新计算。</p></details>}
<div className="ew-submit-row"><span>本地演示审核 · 提交不会自动启动实验</span><button className="btn btn-primary" disabled={issues.length>0||!!saveError} onClick={submit}><ShieldCheck size={15}/>提交审核</button></div></section>

  <div className="ew-section-footer"><span>所有修改保存到当前浏览器</span><button className="btn" onClick={()=>navigateSection(sections[(sections.findIndex(s=>s.id===section)+1)%sections.length].id)}>{section==='review'?'返回实验目标':'继续配置'}<ArrowRight size={14}/></button></div></div></div>
 </div>;
}
