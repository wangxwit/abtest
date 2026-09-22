import { metrics, type Experiment } from './data.ts';
import type { ExperimentDraftForm, DraftSection } from './experiment-drafts';
import { validateExperimentVariants } from './experiment-variants.ts';
import { candidateLayerAudience, findAvailableBucketRanges, layerAudienceCapacity, layerScope, isParameterPending, getParameterDefinition, validateTopology, type Topology } from './traffic.ts';
import { getAudience, audienceIsEmpty } from './audiences.ts';
import { validateParameterValue } from './parameter-definitions.ts';
import { getParameterService } from './service-catalog.ts';
import { trafficToBucketCount } from './bucket-ranges.ts';
import { analyzeParameterJson } from './json-parameter-analysis.ts';
export type DraftIssue={id:string;section:Exclude<DraftSection,'review'>;message:string;field?:string;variantId?:string;parameterKey?:string};
export function draftParameterKeys(form:ExperimentDraftForm):string[]{return [...new Set(form.variants.flatMap(v=>{const analysis=analyzeParameterJson(v.value);return analysis.valid&&analysis.value?Object.keys(analysis.value):[];}))];}
export function validateDraftForm(form:ExperimentDraftForm,existing:Experiment[],t:Topology):DraftIssue[]{
  const issues:DraftIssue[]=[];const add=(section:DraftIssue['section'],message:string,field?:string,variantId?:string,parameterKey?:string)=>issues.push({id:`${section}:${field??''}:${variantId??''}:${parameterKey??''}:${issues.length}`,section,message,field,variantId,parameterKey});
  if(!form.name.trim())add('goal','填写实验名称。','name');else if(form.name.trim().length>60)add('goal','实验名称最多 60 个字符。','name');else if(existing.some(e=>e.name===form.name.trim()))add('goal','实验名称已存在，请使用新的名称。','name');
  if(!/^[a-z][a-z0-9_]{2,63}$/.test(form.key))add('goal','实验标识需为 3–64 位小写字母、数字或下划线，以字母开头。','key');else if(existing.some(e=>e.key===form.key))add('goal','实验标识已存在。','key');
  if(!metrics.some(m=>m.name===form.metric&&m.category!=='护栏指标'))add('goal','选择有效的核心指标。','metric');
  if(form.guardrails.some(g=>!metrics.some(m=>m.name===g&&m.category==='护栏指标')))add('goal','部分护栏指标已不可用，请重新选择。','guardrails');
  const domain=t.domains.find(d=>d.id===form.domainId),layer=t.layers.find(l=>l.id===form.layerId);
  if(!domain)add('traffic','选择可用的实验域。','domainId');
  if(!layer||layer.domainId!==domain?.id)add('traffic','选择属于当前域的参数层。','layerId');
  const scope=layer&&domain&&layer.domainId===domain.id?layerScope(layer.id,t):[];
  if(layer?.role==='routing')add('traffic','默认路由层只负责分域，请选择普通参数层。','layerId');
  else if(layer&&!scope.length)add('traffic','当前层尚未分配参数，请选择已配置的层。','layerId');
  const count=trafficToBucketCount(form.traffic);if(count===null)add('traffic','实验流量须为 0.01–100%，最多两位小数。','traffic');
  const audience={audience:'全部活跃用户',...(form.audienceId?{audienceId:form.audienceId}:{})};
  const unknown=!!form.audienceId&&!getAudience(form.audienceId,t);
  if(unknown)add('traffic','受众版本不存在，请重新选择。','audienceId');
  const topologyError=validateTopology(t,existing);
  if(topologyError)add('traffic',`配置检查未通过：${topologyError}`,'layerId');
  if(domain&&layer&&layer.domainId===domain.id&&layer.role!=='routing'&&scope.length&&!unknown&&!topologyError){
    if(audienceIsEmpty(candidateLayerAudience(layer.id,audience,t)))add('traffic','当前受众与祖先条件交集为空。','audienceId');
    else if(count!==null&&!findAvailableBucketRanges(layer.id,form.traffic,existing,undefined,t,audience)){const available=Math.round(layerAudienceCapacity(layer.id,existing,t,audience).available*100);add('traffic',count>available?`申请 ${count} 桶，当前受众可用 ${available} 桶。请降低流量或调整范围。`:'当前配置无法分配，请检查层与受众。','traffic');}
  }
  const metadataError=validateExperimentVariants(form.variants);if(metadataError)add('groups',metadataError,'variants');
  const controls=form.variants.filter(v=>v.role==='control');
  if(controls.length!==1)for(const v of controls.length?controls:form.variants.slice(0,1))add('groups','需要且只能设置一个对照组。','variant-role',v.id);
  const analyses=form.variants.map(v=>analyzeParameterJson(v.value));
  const keys=[...new Set(analyses.flatMap(analysis=>analysis.valid&&analysis.value?Object.keys(analysis.value):[]))].sort(),seenNames=new Set<string>();
  form.variants.forEach((v,index)=>{
    if(!v.name.trim()||v.name.length>60||seenNames.has(v.name.trim().toLowerCase()))add('groups','分组名称需为 1–60 个字符，且不能重复。','variant-name',v.id);
    seenNames.add(v.name.trim().toLowerCase());
    if(trafficToBucketCount(v.weight)===null)add('groups','分组流量须为正数，最多两位小数。','variant-weight',v.id);
    const analysis=analyses[index],payload=analysis.value;
    if(!analysis.valid||!payload){
      const diagnostic=analysis.diagnostics.find(item=>item.severity==='error');
      const target=diagnostic?analysis.nodes.filter(node=>node.from<=diagnostic.from&&node.to>=diagnostic.from).at(-1):undefined;
      add('groups',`参数必须是有效的有限 JSON 对象${diagnostic?`：${diagnostic.message}`:''}。原文已保留。`,'variant-value',v.id,target?.topLevelKey);return;
    }
    for(const key of keys){
      if(!Object.hasOwn(payload,key)){add('groups',`缺少参数 ${key}；所有组必须使用相同的 Key 集合。`,'variant-value',v.id,key);continue;}
      if(isParameterPending(key,t)){add('groups',`${key} 尚待归层。`,'variant-value',v.id,key);continue;}
      if(!scope.includes(key)){add('groups',`${key} 不在当前层参数范围内。`,'variant-value',v.id,key);continue;}
      if(!getParameterService(key,t))add('groups',`${key} 尚未归属应用。`,'variant-value',v.id,key);
      const definition=getParameterDefinition(key,t);if(definition){const error=validateParameterValue(definition,payload[key]);if(error)add('groups',error,'variant-value',v.id,key);}
    }
  });
  return issues;
}
