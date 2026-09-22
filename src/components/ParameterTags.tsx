import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, Plus, Tag } from 'lucide-react';
import type { Experiment } from '../data';
import { getTopology, saveTopology, subscribeTopology } from '../traffic';
import { getCatalog, getServiceTags, planTagCreate } from '../service-catalog';
import './parameter-tags.css';

export default function ParameterTags({serviceId,value,onChange,experiments,allowCreate=true}: {
  serviceId:string;value:string[];onChange:(ids:string[])=>void;experiments:Experiment[];allowCreate?:boolean;
}) {
  const topology=useSyncExternalStore(subscribeTopology,getTopology,getTopology);
  const service=getCatalog(topology).services.find(item=>item.id===serviceId);
  const tags=service?getServiceTags(serviceId,topology):[];
  const selectedIds=value.filter(id=>tags.some(tag=>tag.id===id));
  const [name,setName]=useState(''),[error,setError]=useState('');
  useEffect(()=>{setName('');setError('');},[serviceId]);
  function create() {
    if(!serviceId||!getCatalog(getTopology()).services.some(item=>item.id===serviceId)){setError('请先选择已登记的所属应用 / 服务。');return;}
    const plan=planTagCreate(serviceId,name.trim(),'green',getTopology());
    if(plan.error||!plan.topology||!plan.tagId){setError(plan.error??'无法创建应用标签');return;}
    if(!getServiceTags(serviceId,plan.topology).some(tag=>tag.id===plan.tagId)){setError('新标签不属于当前应用，请重新创建。');return;}
    const invalid=saveTopology(plan.topology,experiments);
    if(invalid){setError(invalid);return;}
    onChange([...new Set([...selectedIds,plan.tagId])]);
    setName('');setError('');
  }
  return <div className="pt-editor">
    <div className="pt-options" aria-label="选择当前应用的参数标签">{tags.map(tag=><button type="button" key={tag.id} className={`pt-chip pt-${tag.color} ${selectedIds.includes(tag.id)?'is-selected':''}`} aria-pressed={selectedIds.includes(tag.id)} onClick={()=>onChange(selectedIds.includes(tag.id)?selectedIds.filter(id=>id!==tag.id):[...selectedIds,tag.id])}>{selectedIds.includes(tag.id)?<Check size={12}/>:<Tag size={12}/>}<span>{tag.name}</span></button>)}{!tags.length&&<span className="pt-hint">{service?(allowCreate?'当前应用尚未创建标签，可在下方创建。':'当前应用尚未创建标签。'):'请先选择所属应用 / 服务，再维护标签。'}</span>}</div>
    {allowCreate&&service&&<div className="pt-create"><input className="input" aria-label="新标签名称" placeholder="创建当前应用标签" value={name} maxLength={30} onChange={e=>{setName(e.target.value);setError('');}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();create();}}}/><button type="button" className="btn btn-small" disabled={!name.trim()} onClick={create}><Plus size={13}/>创建并选择</button></div>}
    {value.length!==selectedIds.length&&<p className="pt-hint">部分已选标签不属于当前应用，请重新选择当前应用的标签。</p>}
    {error&&<p className="pt-error" role="alert">{error}</p>}
  </div>;
}
