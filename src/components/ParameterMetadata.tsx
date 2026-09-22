import { useState } from 'react';
import { Check, Server, Tag } from 'lucide-react';
import type { Experiment } from '../data';
import { getTopology, saveTopology } from '../traffic';
import { getCatalog, getParameterBinding, getParameterService, planParameterService, planParameterTags } from '../service-catalog';
import ParameterTags from './ParameterTags';
import { serviceHref } from '../application-routes';

export default function ParameterMetadata({parameterKey,experiments,onSaved}: {parameterKey:string;experiments:Experiment[];onSaved:(message:string)=>void}) {
  const topology=getTopology();
  const binding=getParameterBinding(parameterKey,topology);
  const service=getParameterService(parameterKey,topology);
  const [serviceId,setServiceId]=useState(binding?.serviceId??'');
  const [tagIds,setTagIds]=useState<string[]>(binding?.tagIds??[]);
  const [error,setError]=useState('');
  const tagServiceId=service?.id??serviceId;
  function save() {
    if(!service&&!serviceId){setError('请先选择所属应用 / 服务，再保存参数标签。');return;}
    let next=getTopology();
    let tagsToSave=tagIds;
    if(!service&&serviceId){
      const claim=planParameterService(parameterKey,serviceId,next);
      if(claim.error||!claim.topology){setError(claim.error??'服务归属保存失败');return;}
      next=claim.topology;
      tagsToSave=[...new Set([...(getParameterBinding(parameterKey,next)?.tagIds??[]),...tagIds])];
    }
    const plan=planParameterTags([parameterKey],tagsToSave,'replace',next);
    if(plan.error||!plan.topology){setError(plan.error??'标签保存失败');return;}
    const invalid=saveTopology(plan.topology,experiments);
    if(invalid){setError(invalid);return;}
    setTagIds(tagsToSave);setError('');onSaved(service ? '参数标签已保存，已有实验的参数值和流量保持不变。' : '参数服务与标签已保存，已有实验的参数值和流量保持不变。');
  }
  return <div className="pc-metadata">
    <div className="pc-service-owner"><Server size={16}/><div><span>所属应用 / 服务</span>{service?<><a href={serviceHref(service.id)}>{service.name} ↗</a><small>{service.id} · 应用负责人 {service.owner}</small></>:<><strong>待归属 · 历史参数</strong><select aria-label="补充参数所属服务" value={serviceId} onChange={e=>{setServiceId(e.target.value);setTagIds([]);setError('');}}><option value="">选择所属服务</option>{getCatalog(topology).services.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><small>确认服务后可用于新实验；原有实验继续保留。</small></>}</div></div>
    <div className="pc-tag-editor"><h3><Tag size={14}/>业务标签</h3><ParameterTags key={tagServiceId} serviceId={tagServiceId} value={tagIds} onChange={setTagIds} experiments={experiments}/><small>标签仅属于当前应用，用于组织本应用参数，不改变层归属、流量或组合约束。新标签立即保存到当前应用。</small></div>
    {error&&<p className="pt-error" role="alert">{error}</p>}
    <button className="btn btn-small" onClick={save}><Check size={13}/>{service ? '保存标签' : '保存归属与标签'}</button>
  </div>;
}
