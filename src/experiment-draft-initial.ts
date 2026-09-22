import { defaultAudiences } from './audiences.ts';
import type { Experiment } from './data';
import type { ExperimentDraftForm } from './experiment-drafts';
import { getVariantRole } from './experiment-variants.ts';
import type { Topology } from './traffic';
export function initialDraftForm(t:Topology,options:{layerId?:string;source?:Experiment}={}):ExperimentDraftForm {
  const source=options.source,layer=t.layers.find(l=>l.id===(options.layerId??source?.layerId));
  const variants=source?.variants.map((v,i)=>({id:`group-${crypto.randomUUID()}`,name:v.name,role:getVariantRole(v,i),weight:v.weight,value:v.value}))??[
    {id:`group-${crypto.randomUUID()}`,name:'对照组 A',role:'control' as const,weight:50,value:'{}'},
    {id:`group-${crypto.randomUUID()}`,name:'实验组 B',role:'treatment' as const,weight:50,value:'{}'}];
  return {name:source?`${source.name} 副本`.slice(0,60):'',key:'',description:source?.description??'',hypothesis:source?.hypothesis??'',traffic:source?.traffic||10,domainId:source?.domainId??layer?.domainId??'',layerId:source?.layerId??layer?.id??'',audienceId:source?.audienceId??(source?.audience&&source.audience!=='全部活跃用户'?(defaultAudiences.find(a=>a.name===source.audience)?.id??`unresolved-legacy:${source.audience}`):''),variants,metric:source?.metric??'',guardrails:[...(source?.guardrails??[])]};
}
