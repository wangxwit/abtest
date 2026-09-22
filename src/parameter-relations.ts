import type { Experiment } from './data';
import { domainGlobalTraffic, getTopology, getParameterDefinition, isParameterPending, layerCreationBlock, layerParameterOptions, layerScope, nodePath, parameterKeys, type Topology, type TrafficDomain } from './traffic.ts';
import { validateParameterValue } from './parameter-definitions.ts';
export type ParameterOwner={domainId:string;domainName:string;layerId:string;layerName:string;path:string;mode:TrafficDomain['mode'];globalTraffic:number;referenceExperimentIds:string[];transferBlockedReason:string|null};
export type ParameterReference={experiment:Experiment;currentOwner:boolean;values:{variant:string;value:unknown;error?:string}[]};
export type ParameterRelationships={key:string;owners:ParameterOwner[];references:ParameterReference[];issues:string[];pending:boolean};
/** A view derived from the same topology and experiment declarations used by allocation.
 * There is no second editable ownership table that can drift from the actual configuration. */
export function getParameterRelationships(key:string,experiments:Experiment[],t:Topology=getTopology()):ParameterRelationships{
 const issues:string[]=[];
 if(!parameterKeys(t).includes(key))issues.push(`参数 ${key} 尚未登记。`);
 const owners:ParameterOwner[]=[];
 for(const layer of t.layers.filter(l=>layerScope(l.id,t).includes(key))){
  const domain=t.domains.find(d=>d.id===layer.domainId);
  if(!domain){issues.push(`「${layer.name}」缺少所属域。`);continue}
  const option=layerParameterOptions(domain.id,experiments,t).find(p=>p.key===key&&p.sourceLayerId===layer.id);
  owners.push({domainId:domain.id,domainName:domain.name,layerId:layer.id,layerName:layer.name,path:nodePath('layer',layer.id,t).map(n=>n.name).join(' → '),mode:domain.mode,globalTraffic:domainGlobalTraffic(domain.id,t),referenceExperimentIds:experiments.filter(e=>e.domainId===domain.id&&e.layerId===layer.id&&e.parameterKeys.includes(key)).map(e=>e.id),transferBlockedReason:layerCreationBlock(domain.id,t)||option?.blockedReason||null});
 }
 for(const domainId of new Set(owners.map(o=>o.domainId))){
  const sameDomain=owners.filter(o=>o.domainId===domainId);
  if(sameDomain.length>1)issues.push(`「${sameDomain[0].domainName}」中参数同时归属多个层：${sameDomain.map(o=>o.layerName).join('、')}。`);
 }
 const references:ParameterReference[]=experiments.filter(e=>e.parameterKeys.includes(key)).map(experiment=>{
  const currentOwner=owners.some(o=>o.domainId===experiment.domainId&&o.layerId===experiment.layerId);
  if(!currentOwner&&experiment.status!=='completed')issues.push(`「${experiment.name}」引用的参数不属于其当前域／层。`);
  if(experiment.status!=='completed'&&t.layers.find(l=>l.id===experiment.layerId)?.role==='routing')issues.push(`「${experiment.name}」不能绑定默认路由层。`);
  const values=experiment.variants.map(variant=>{
   let payload:unknown;
   try{payload=JSON.parse(variant.value)}catch{const error='版本参数不是有效 JSON';issues.push(`「${experiment.name}」${variant.name}：${error}。`);return {variant:variant.name,value:null,error}}
   if(!payload||typeof payload!=='object'||Array.isArray(payload)){const error='版本参数必须是 JSON 对象';issues.push(`「${experiment.name}」${variant.name}：${error}。`);return {variant:variant.name,value:null,error}}
   if(!Object.prototype.hasOwnProperty.call(payload,key)){const error=`版本中缺少已声明参数 ${key}`;issues.push(`「${experiment.name}」${variant.name}：${error}。`);return {variant:variant.name,value:null,error}}
   const value=(payload as Record<string,unknown>)[key],definition=getParameterDefinition(key,t);
   const error=definition?validateParameterValue(definition,value):null;
   if(error){issues.push(`「${experiment.name}」${variant.name}：${error}`);return {variant:variant.name,value,error}}
   return {variant:variant.name,value};
  });
  return {experiment,currentOwner,values};
 });
 return {key,owners,references,issues:[...new Set(issues)],pending:isParameterPending(key,t)};
}
