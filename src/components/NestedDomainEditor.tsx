import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Braces, Check, GitBranch, Info, X } from 'lucide-react';
import type { Experiment } from '../data';
import { domains, layers, nodePath, layerScope, layerAudienceCapacity, candidateLayerAudience, explainAllocationConflicts, findAvailableBucketRanges, domainGlobalTraffic, getTopology, saveTopology, validateTopology, type TrafficDomain } from '../traffic';
import { BUCKET_COUNT, bucketCount, formatBucketRanges, trafficToBucketCount } from '../bucket-ranges';
import { formatPercent } from '../format-percent';
import { audienceSummary, describeExpression, getAudienceExpression, domainEffectiveAudience, getAudience, audienceIsEmpty } from '../audiences';
import { planChildDomainCreation } from '../child-domain-creation';
import { defaultResourceManagement, validateResourceManagement } from '../resource-management';
import AudienceSelect from './AudienceSelect';
import TrafficEstimate from './TrafficEstimate';
import ApplicationParameterBrowser from './ApplicationParameterBrowser';
import ResourceManagementFields from './ResourceManagementFields';
import './experiment-flow.css';
import './nested-domain-editor.css';
export default function NestedDomainEditor({parentLayerId,experiments,onClose,onCreated}:{parentLayerId:string;experiments:Experiment[];onClose:()=>void;onCreated:(domainId:string)=>void}){
 const parent=layers.find(l=>l.id===parentLayerId)!;
 const owner=domains.find(d=>d.id===parent.domainId)!;
 const scope=layerScope(parentLayerId);
 const path=nodePath('layer',parentLayerId);
 const isolatedAncestor=path.some(n=>n.kind==='domain'&&domains.find(d=>d.id===n.id)?.mode==='non-overlapping');
 const canOverlap=!isolatedAncestor;
 const [name,setName]=useState(''),[mode,setMode]=useState<TrafficDomain['mode']>(canOverlap?'overlapping':'non-overlapping');
 const [traffic,setTraffic]=useState(10);
 const [management,setManagement]=useState(defaultResourceManagement);
 const [audienceId,setAudienceId]=useState('');
 const selectedAudience=audienceId?getAudience(audienceId,getTopology()):undefined;
 const audienceSelection={...(audienceId?{audienceId}:{}),audience:'全部活跃用户'};
 const inheritedAudience=audienceSummary(domainEffectiveAudience(owner.id,getTopology()));
 const effectiveAudienceLabel=`${inheritedAudience}${selectedAudience?`；并且 ${describeExpression(getAudienceExpression(selectedAudience), getTopology())}`:''}`;
 const capacity=layerAudienceCapacity(parentLayerId,experiments,getTopology(),audienceSelection);
 const emptyAudience=audienceIsEmpty(candidateLayerAudience(parentLayerId,audienceSelection,getTopology()));
 const conflicts=explainAllocationConflicts({id:'',domainId:owner.id,layerId:parentLayerId,bucketStart:0,traffic:100,...audienceSelection},experiments,getTopology());
 const [error,setError]=useState('');const ref=useRef<HTMLDivElement>(null);
 const availableRanges=findAvailableBucketRanges(parentLayerId,traffic,experiments,undefined,getTopology(),audienceSelection);
 const requestedBuckets=trafficToBucketCount(traffic);
 const availableBuckets=Math.round(capacity.available*BUCKET_COUNT/100);
 const allocationConfigError=availableRanges===null?validateTopology(getTopology(),experiments):null;
 const allocationIssue=requestedBuckets===null?'子域流量须为 0.01–100%，最小步长为 0.01%（1 桶）。':audienceId&&!selectedAudience?'所选受众版本不存在，请重新选择。':allocationConfigError?`配置检查未通过：${allocationConfigError}`:!emptyAudience&&availableRanges===null?requestedBuckets>availableBuckets?`申请 ${requestedBuckets} 桶，当前受众可用 ${availableBuckets} 桶，容量不足。请降低比例；平台会自动组合多个空闲桶段。`:'当前父层无法生成分配，请检查父层与受众配置。':null;
 const share=domainGlobalTraffic(owner.id)*traffic/100;
 useEffect(()=>{const previous=document.activeElement as HTMLElement;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';ref.current?.querySelector<HTMLInputElement>('input')?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();onClose()}if(e.key==='Tab'){const fields=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')??[]).filter(el=>el.getClientRects().length);const first=fields[0],last=fields.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}};document.addEventListener('keydown',key);return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',key);previous?.focus()}},[]);
 const submit=()=>{
  const id=`domain-${crypto.randomUUID().slice(0,8)}`;
  const planned=planChildDomainCreation({id,parentLayerId,name,mode,traffic,management,...(audienceId?{audienceId}:{})},experiments,getTopology());
  if(!planned.ok){setError(planned.error);ref.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();return}
  const invalid=saveTopology(planned.topology,experiments);
  if(invalid){setError(invalid);return}onCreated(planned.domainId);
 };
 return <div className="ef-modal-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="ef-modal nd-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="new-domain-title">
  <div className="ef-modal-head"><span className="ef-heading-icon"><GitBranch size={22}/></span><div><h2 id="new-domain-title">在父层中创建子域</h2><p>划分流量，继承参数，再继续分层</p></div><button className="ef-icon-button" aria-label="关闭子域配置" onClick={onClose}><X size={19}/></button></div>
  <div className="ef-modal-body"><div className="ef-recursive-breadcrumb">{path.map((n,i)=><span key={n.id}><small>{n.kind==='domain'?'域':'层'}</small>{n.name}{i<path.length-1&&<ArrowRight size={11}/>}</span>)}</div>
   <label className="ef-field">子域名称 <input className="input" value={name} maxLength={40} onChange={e=>{setName(e.target.value);setError('')}} placeholder="例如：会员界面探索子域"/></label>
   <ResourceManagementFields value={management} onChange={value=>{setManagement(value);setError('')}} idPrefix="create-domain-management" showErrors />
   <div className="ef-section-label">子域模式</div><div className="nd-modes">{(['overlapping','non-overlapping'] as const).map(m=><button key={m} className={mode===m?'selected':''} onClick={()=>{setMode(m);setError('')}} aria-pressed={mode===m} disabled={m==='overlapping'&&!canOverlap}><strong>{m==='overlapping'?'重叠子域':'非重叠子域'}</strong><span>{m==='overlapping'?'先完整继承参数，后续可拆分并行层':'一个完整参数层，分支内实验互斥'}</span>{mode===m&&<Check size={15}/>}</button>)}</div>
   {isolatedAncestor&&<p className="ef-helper nd-hint">祖先域为非重叠模式，后代分支须继续保持至多一个实验。</p>}
   <AudienceSelect id="child-domain-audience" label="子域受众版本 · 选填" value={audienceId} onChange={id=>{setAudienceId(id);setError('')}} inheritedLabel={inheritedAudience} inheritedCondition={domainEffectiveAudience(owner.id,getTopology())} experiments={experiments} allocation={{layerId:parentLayerId,traffic}}/>
   {emptyAudience&&<p className="ef-error" role="alert">本受众与祖先条件相互矛盾，当前有效人群为空。</p>}
   {conflicts.length>0&&<section className="ef-conflict-list" aria-label="子域受众潜在冲突列表"><strong>当前受众需避开的 {conflicts.length} 个配置</strong><p>{availableRanges!==null?'已避开以下潜在冲突，按申请比例自动组合可用桶段。':'下列配置与当前受众可能重叠，需保留其桶段；总容量不足时请降低比例。'}</p>{conflicts.map(conflict=><article key={`${conflict.kind}:${conflict.id}`}><div><strong>{conflict.kind==='domain'?'子域':'实验'} · {conflict.name}</strong></div><details className="ef-conflict-buckets" open={conflict.bucketRanges.length<=4}><summary>占用桶段 · {conflict.bucketRanges.length} 段</summary><code>{formatBucketRanges(conflict.bucketRanges)}</code></details><p>{conflict.reason}{conflict.unknown?' · 保守预留，不按互斥处理':''}</p>{conflict.witness&&<details><summary>可能同时满足的画像示例</summary><pre>{JSON.stringify(conflict.witness,null,2)}</pre></details>}</article>)}</section>}
   <label className="ef-field ef-traffic-control"><span className="ef-label-row"><strong>占父层名义流量</strong><span className="ef-percent-input"><input type="number" aria-label="子域占父层流量" min="0.01" max="100" step="0.01" value={traffic} onChange={e=>{setTraffic(Number(e.target.value));setError('')}}/>%</span></span><input aria-label="子域流量滑块" type="range" min="0.01" max="100" step="0.01" value={traffic} onChange={e=>{setTraffic(Number(e.target.value));setError('')}}/><span className="ef-range-labels"><span>0.01% / 1 桶</span><span>当前受众可用 {availableBuckets} 桶 · {formatPercent(capacity.available)}%</span><span>100%</span></span></label>
   {allocationIssue&&<p className="ef-error ef-bucket-error" role="alert">{allocationIssue}</p>}
   <div className="ef-allocation-preview"><div><span>拟分配父层桶</span><strong className={availableRanges===null?'ef-negative':''}>{availableRanges===null?'尚未生成分配':`${bucketCount(availableRanges)} 桶 · ${bucketCount(availableRanges)/100}%`}</strong><small>{requestedBuckets===null?'比例精度无效':`申请 ${requestedBuckets} / ${BUCKET_COUNT} 桶，平台自动组合空闲桶段`}</small></div><div><span>申请折算全局名义流量</span><strong>{requestedBuckets===null?'—':`${formatPercent(share)}%`}</strong><small>父域 {formatPercent(domainGlobalTraffic(owner.id))}% × 申请 {traffic}%；仅比例折算，尚未生效</small></div></div>
   {availableRanges&&<details className="ef-bucket-range-preview" open={availableRanges.length<=4}><summary>拟分配桶段 · {availableRanges.length} 段 <span>整数桶号，左闭右开</span></summary><code>{formatBucketRanges(availableRanges)}</code><p>桶号范围为 [0, {BUCKET_COUNT})，无需手动填写；保存时按最新配置重新计算。</p></details>}
   <div className="ef-inline-note"><Info size={16}/><span>{capacity.reusable>0?`当前条件可复用 ${capacity.reusable}% 已有桶坐标。`:'当前条件暂无可证明互斥的桶坐标复用。'} 子域继承全部祖先条件，再追加自身条件；缺少属性不视为满足。</span></div>
   <TrafficEstimate nominalPercent={share} audienceLabel={effectiveAudienceLabel}/>
   <div className="ef-section-label nd-scope-title"><Braces size={15}/>参数层初始化</div>
   <section className="nd-initial-layer" aria-label="自动创建的初始参数层"><div><strong>初始参数层</strong><span>自动创建 · 1 个层</span></div><p>完整继承父层的 {scope.length} 个参数。{mode==='overlapping'?(scope.length>1?'创建后，可在域内通过「新建层」按业务拆分参数。':'创建后可在域内新增参数层；待参数增加后，再按业务拆分。'):'非重叠子域保持一个完整参数层，分支内实验互斥。'}</p><p>初始参数层沿用本次填写的负责人、使用期限和预计结束日期，创建后可单独修改。</p></section>
   <ApplicationParameterBrowser parameterKeys={scope} allowNavigation={false} label="初始参数层继承的应用参数" renderState={()=><span className="nd-parameter-assignment">完整继承</span>} emptyMessage="父层尚未分配参数。"/>
   <div className="ef-inline-note"><Info size={16}/><span>按入组前固定画像判定有效受众，同桶配置须可证明条件互斥；已有分配保持不变。{mode==='non-overlapping'?'隔离范围限于本分支；祖先重叠域的其他层仍可并行。':'保存后可在初始参数层创建实验，也可继续创建更深子域。'}</span></div>
   {error&&error!==validateResourceManagement(management)&&<p role="alert" className="nd-error">{error}</p>}
  </div><div className="nd-footer"><span>本地演示配置 · 保存到当前浏览器</span><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" onClick={submit}>创建子域 <ArrowRight size={14}/></button></div>
 </div></div>
}
