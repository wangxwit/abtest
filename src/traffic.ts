import type { Experiment, VariantRole } from './data';
import { getVariantRole, hasExplicitVariantMetadata, selectExperimentVariant, validateExperimentVariants } from './experiment-variants.ts';
import { BUCKET_COUNT, bucketCount, bucketInRanges, formatBucketRanges, getBucketRanges, intersectBucketRanges, trafficToBucketCount, unionBucketRanges, validateBucketAllocation, type BucketRange } from './bucket-ranges.ts';
import { audienceIsEmpty, audienceRuleCount, audienceSummary, audiencesMayOverlap, combineAudiences, compareAudienceConditions, domainEffectiveAudience, evaluateAudience, experimentEffectiveAudience, getAudienceById, selectionAudience, validateAudienceCatalog, validateAudienceTransition, type AudienceDefinition, type AudienceProfile, type AudienceSelection, type EffectiveAudience } from './audiences.ts';
export type { AudienceSelection } from './audiences.ts';
import { validateProfileAttributeCatalog, validateProfileAttributeTransition, type ProfileAttribute } from './profile-attributes.ts';
import { validateParameterDefinition, validateParameterValue, type ParameterDefinition } from './parameter-definitions.ts';
import { validateCoordination } from './coordination.ts';
import { getCatalog, migrateServiceCatalog, validateCatalogTransition, validateServiceCatalog, type ServiceCatalog } from './service-catalog.ts';
import { planParameterLayerAssignment, registrationAssignments, type RegistrationAssignment } from './parameter-assignment.ts';
import { validateResourceManagement, type ResourceManagement } from './resource-management.ts';
/** Google KDD 2010 §4 Fig.2: recursively alternate traffic domains and parameter layers.
 * Percentages, depth limit, user_id and simulator hash are implementation choices. */
export type TrafficDomain={id:string;name:string;mode:'overlapping'|'non-overlapping';parentLayerId:string|null;traffic:number;start:number;bucketRanges?:BucketRange[];unit:string;description:string;audienceId?:string;management?:ResourceManagement};
export type TrafficLayer={id:string;domainId:string;name:string;parameterKeys:string[];description:string;role?:'routing'|'normal';management?:ResourceManagement};
export type Topology={domains:TrafficDomain[];layers:TrafficLayer[];parameters?:ParameterDefinition[];catalog?:ServiceCatalog;pendingParameterKeys?:string[];audiences?:AudienceDefinition[];profileAttributes?:ProfileAttribute[]};
const builtInParameters=['ui.layout','ui.onboarding','ui.cart','ui.membership','ui.content_card','ranking.model','ranking.search','ranking.recall','ranking.longtail','checkout.cache_ttl','checkout.parallel','checkout.inventory','pricing.coupon'];
export let registeredParameters=[...builtInParameters];
export const defaultTopology:Topology={domains:[
{id:'root',name:'默认域',mode:'overlapping',parentLayerId:null,traffic:100,start:0,unit:'user_id',description:'全工作空间流量的入口。默认层承载全参数范围，递归划分子域。'},
{id:'overlap',name:'常规重叠域',mode:'overlapping',parentLayerId:'root-layer',traffic:80,start:0,unit:'user_id',description:'展示、排序、交易层独立分流；展示层中可继续进入子域。'},
{id:'exclusive',name:'全链路非重叠域',mode:'non-overlapping',parentLayerId:'root-layer',traffic:20,start:80,unit:'user_id',description:'从默认层获得全参数范围，与常规重叠域互斥。'},
{id:'ui-mobile',name:'界面探索子域',mode:'overlapping',parentLayerId:'presentation',traffic:20,start:60,unit:'user_id',description:'继承展示层参数，在导航与内容子层中独立实验。此名称不代表移动端受众筛选。'},
{id:'ui-isolation',name:'界面联动隔离子域',mode:'non-overlapping',parentLayerId:'presentation',traffic:10,start:80,unit:'user_id',description:'一次实验可联动全部展示参数；仍可与祖先域的排序、交易层实验叠加。'},
{id:'card-depth',name:'内容深度探索域',mode:'overlapping',parentLayerId:'ui-content',traffic:50,start:50,unit:'user_id',description:'在内容子层中再次划分流量，继续细分卡片与购物车参数。'}
],layers:[
{id:'root-layer',domainId:'root',name:'默认层',parameterKeys:['*'],role:'routing',description:'全部流量与参数的起点，同一桶只能进入一个直属子域。'},
{id:'presentation',domainId:'overlap',name:'展示参数层',parameterKeys:registeredParameters.slice(0,5),description:'直接实验与子域共享同一组互斥桶段。'},
{id:'ranking',domainId:'overlap',name:'排序参数层',parameterKeys:registeredParameters.slice(5,9),description:'推荐、检索和召回参数，与展示层独立分流。'},
{id:'transaction',domainId:'overlap',name:'交易参数层',parameterKeys:registeredParameters.slice(9),description:'交易与优惠策略参数，与展示层独立分流。'},
{id:'full',domainId:'exclusive',name:'全参数隔离层',parameterKeys:['*'],description:'继承默认层全部参数，当前分支至多命中一个实验。'},
{id:'ui-navigation',domainId:'ui-mobile',name:'导航与入口子层',parameterKeys:['ui.layout','ui.onboarding','ui.membership'],description:'继承展示参数中的导航和入口配置。'},
{id:'ui-content',domainId:'ui-mobile',name:'内容交互子层',parameterKeys:['ui.cart','ui.content_card'],description:'可直接运行实验，或进入下一层内容深度探索域。'},
{id:'ui-full',domainId:'ui-isolation',name:'展示全参数子层',parameterKeys:['*'],description:'星号仅继承父展示层的 5 个参数，不含排序和交易参数。'},
{id:'card-layout',domainId:'card-depth',name:'卡片样式孙层',parameterKeys:['ui.content_card'],description:'只可覆盖内容卡片参数。'},
{id:'ui-cart',domainId:'card-depth',name:'购物车交互孙层',parameterKeys:['ui.cart'],description:'只可覆盖购物车参数。'}
]};
export let domains=structuredClone(defaultTopology.domains);
export let layers=structuredClone(defaultTopology.layers);
let parameterDefinitions:ParameterDefinition[]=[];
let serviceCatalog:ServiceCatalog|undefined;
let pendingParameterKeys:string[]|undefined;
let audienceDefinitions:AudienceDefinition[]|undefined;
let profileAttributeDefinitions:ProfileAttribute[]|undefined;
let topologyLoadError:string|null=null;
// Exact persisted snapshot last loaded or written by this module. This detects stale
// pages before whole-topology writes; it is not an atomic cross-tab transaction.
let topologyStorageRaw:string|null=null;
export const getTopologyLoadError=():string|null=>topologyLoadError;
const current=():Topology=>({domains,layers,...(parameterDefinitions.length?{parameters:parameterDefinitions}:{}),...(serviceCatalog?{catalog:serviceCatalog}:{}),...(pendingParameterKeys!==undefined?{pendingParameterKeys}:{}),...(audienceDefinitions!==undefined?{audiences:audienceDefinitions}:{}),...(profileAttributeDefinitions!==undefined?{profileAttributes:profileAttributeDefinitions}:{})});
export const parameterKeys=(t:Topology=current())=>[...builtInParameters,...(t.parameters??[]).map(p=>p.key)];
export const isParameterPending=(key:string,t:Topology=current())=>(t.pendingParameterKeys??[]).includes(key);
export const activeParameterKeys=(t:Topology=current())=>parameterKeys(t).filter(key=>!isParameterPending(key,t));
export const getParameterDefinition=(key:string,t:Topology=current())=>t.parameters?.find(p=>p.key===key);
export const reserveStatuses=['running','paused','review'];
export const getDomain=(e:Pick<Experiment,'domainId'>)=>domains.find(d=>d.id===e.domainId)!;
export const getLayer=(e:Pick<Experiment,'layerId'>)=>layers.find(l=>l.id===e.layerId)!;
export const childDomains=(layerId:string,t:Topology=current())=>t.domains.filter(d=>d.parentLayerId===layerId);
export const domainLayers=(domainId:string,t:Topology=current())=>t.layers.filter(l=>l.domainId===domainId);
export function domainScope(domainId:string,t:Topology=current(),seen=new Set<string>()):string[]{
 if(seen.has(domainId))return [];seen.add(domainId);const d=t.domains.find(x=>x.id===domainId);
 return !d?[]:d.parentLayerId===null?activeParameterKeys(t):layerScope(d.parentLayerId,t,seen);
}
export function layerScope(layerId:string,t:Topology=current(),seen=new Set<string>()):string[]{
 const l=t.layers.find(x=>x.id===layerId);return !l?[]:l.parameterKeys.includes('*')?domainScope(l.domainId,t,seen):l.parameterKeys.filter(key=>!isParameterPending(key,t));
}
export function compatibleLayers(keys:string[],t:Topology=current()):TrafficLayer[]{
 return keys.length?t.layers.filter(layer=>layer.role!=='routing'&&keys.every(key=>layerScope(layer.id,t).includes(key))):[];
}
export function domainGlobalTraffic(domainId:string,t:Topology=current(),seen=new Set<string>()):number{
 if(seen.has(domainId))return 0;seen.add(domainId);const d=t.domains.find(x=>x.id===domainId);if(!d)return 0;if(d.parentLayerId===null)return 100;
 const l=t.layers.find(x=>x.id===d.parentLayerId);return l?domainGlobalTraffic(l.domainId,t,seen)*d.traffic/100:0;
}
export const globalTraffic=(e:Pick<Experiment,'domainId'|'traffic'>)=>domainGlobalTraffic(e.domainId)*e.traffic/100;
export type PathNode={kind:'domain'|'layer';id:string;name:string};
export function nodePath(kind:'domain'|'layer',id:string,t:Topology=current(),seen=new Set<string>()):PathNode[]{
 if(seen.has(id))return [];seen.add(id);const n=kind==='domain'?t.domains.find(d=>d.id===id):t.layers.find(l=>l.id===id);if(!n)return [];
 const parent=kind==='domain'?(n as TrafficDomain).parentLayerId:(n as TrafficLayer).domainId;
 return [...(parent?nodePath(kind==='domain'?'layer':'domain',parent,t,seen):[]),{kind,id,name:n.name}];
}
export function maxConcurrent(domainId:string,t:Topology=current(),seen=new Set<string>()):number{
 if(seen.has(domainId))return 0;const next=new Set(seen).add(domainId);
 return domainLayers(domainId,t).reduce((n,l)=>n+Math.max(l.role==='routing'||!layerScope(l.id,t).length?0:1,...childDomains(l.id,t).map(d=>maxConcurrent(d.id,t,next))),0);
}
type OccupiedRange={id:string;name:string;kind:'experiment'|'domain';bucketRanges:BucketRange[];condition:EffectiveAudience};
function occupiedRanges(layerId:string,existing:Experiment[],excludeId?:string,t:Topology=current()):OccupiedRange[]{
 return [...existing.filter(e=>e.layerId===layerId&&e.id!==excludeId&&reserveStatuses.includes(e.status)).map(e=>({id:e.id,name:e.name,kind:'experiment' as const,bucketRanges:getBucketRanges(e),condition:experimentEffectiveAudience(e,t)})),...childDomains(layerId,t).map(d=>({id:d.id,name:d.name,kind:'domain' as const,bucketRanges:getBucketRanges(d),condition:domainEffectiveAudience(d.id,t)}))].sort((a,b)=>(a.bucketRanges[0]?.start??0)-(b.bucketRanges[0]?.start??0));
}
const occupiedUnion=(ranges:OccupiedRange[])=>unionBucketRanges(ranges.flatMap(range=>range.bucketRanges));
const invalidLayerRanges=(layerId:string,existing:Experiment[],t:Topology)=>[...existing.filter(e=>e.layerId===layerId&&reserveStatuses.includes(e.status)),...childDomains(layerId,t)].some(allocation=>validateBucketAllocation(allocation)!==null);
export const layerUsage=(layerId:string,existing:Experiment[],t:Topology=current())=>bucketCount(occupiedUnion(occupiedRanges(layerId,existing,undefined,t)))/100;
export function candidateLayerAudience(layerId:string,selection:AudienceSelection,t:Topology=current()):EffectiveAudience{
 const layer=t.layers.find(layer=>layer.id===layerId);
 return combineAudiences(domainEffectiveAudience(layer?.domainId??'',t),selectionAudience(selection,t));
}
export function layerAudienceCapacity(layerId:string,existing:Experiment[],t:Topology=current(),selection:AudienceSelection={},excludeId?:string):{occupied:number;available:number;largestFree:number;reusable:number;nominalOccupied:number}{
 if(!layerScope(layerId,t).length||invalidLayerRanges(layerId,existing,t))return {occupied:0,available:0,largestFree:0,reusable:0,nominalOccupied:0};
 const condition=candidateLayerAudience(layerId,selection,t),all=occupiedRanges(layerId,existing,excludeId,t);
 const ranges=occupiedUnion(all.filter(range=>audiencesMayOverlap(range.condition,condition)));
 const occupiedCount=bucketCount(ranges),nominalCount=bucketCount(occupiedUnion(all)),occupied=occupiedCount/100,nominalOccupied=nominalCount/100;
 let cursor=0,largestFree=0;for(const range of ranges){largestFree=Math.max(largestFree,range.start-cursor);cursor=range.end}largestFree=Math.max(largestFree,BUCKET_COUNT-cursor);largestFree/=100;
 if(audienceIsEmpty(condition))return {occupied,available:0,largestFree:0,reusable:0,nominalOccupied};
 return {occupied,available:Math.max(0,BUCKET_COUNT-occupiedCount)/100,largestFree,reusable:Math.max(0,nominalCount-occupiedCount)/100,nominalOccupied};
}
export function findAvailableStart(layerId:string,traffic:number,existing:Experiment[],excludeId?:string,t:Topology=current(),selection:AudienceSelection={}):number|null{
 const count=trafficToBucketCount(traffic);
 if(count===null||!t.layers.some(l=>l.id===layerId)||!layerScope(layerId,t).length||invalidLayerRanges(layerId,existing,t))return null;
 const condition=candidateLayerAudience(layerId,selection,t);if(audienceIsEmpty(condition))return null;
 let cursor=0;for(const range of occupiedUnion(occupiedRanges(layerId,existing,excludeId,t).filter(range=>audiencesMayOverlap(range.condition,condition)))){if(range.start-cursor>=count)return cursor/100;cursor=range.end}return cursor+count<=BUCKET_COUNT?cursor/100:null;
}
/** Allocate all required buckets from the lowest available coordinates without compacting reservations. */
export function findAvailableBucketRanges(layerId:string,traffic:number,existing:Experiment[],excludeId?:string,t:Topology=current(),selection:AudienceSelection={}):BucketRange[]|null{
 const count=trafficToBucketCount(traffic);
 if(count===null||!t.layers.some(layer=>layer.id===layerId)||!layerScope(layerId,t).length)return null;
 if(validateTopology(t,existing))return null;
 if(selection.audienceId!==undefined&&(typeof selection.audienceId!=='string'||!getAudienceById(selection.audienceId,t)))return null;
 const condition=candidateLayerAudience(layerId,selection,t);if(audienceIsEmpty(condition))return null;
 const occupied=occupiedUnion(occupiedRanges(layerId,existing,excludeId,t).filter(range=>audiencesMayOverlap(range.condition,condition)));
 const result:BucketRange[]=[];let remaining=count,cursor=0;
 for(const range of [...occupied,{start:BUCKET_COUNT,end:BUCKET_COUNT}]){
  if(range.start>cursor){const take=Math.min(remaining,range.start-cursor);if(take>0){result.push({start:cursor,end:cursor+take});remaining-=take}if(!remaining)return unionBucketRanges(result)}
  cursor=range.end;
 }
 return null;
}
export function validateTopology(t:Topology,existing:Experiment[]=[]):string|null{
 if(!t||!Array.isArray(t.domains)||!Array.isArray(t.layers))return '层域配置格式无效。';
 if(t.parameters!==undefined&&!Array.isArray(t.parameters))return '参数目录格式无效。';
 const catalogKeys=new Set(builtInParameters);
 for(const definition of t.parameters??[]){
  const error=validateParameterDefinition(definition);if(error)return error;
  if(catalogKeys.has(definition.key))return `参数 ${definition.key} 已注册，Key 必须唯一。`;
  if(typeof definition.createdAt!=='string'||!Number.isFinite(Date.parse(definition.createdAt)))return '参数注册时间无效。';
  catalogKeys.add(definition.key);
 }
 if(t.pendingParameterKeys!==undefined&&(!Array.isArray(t.pendingParameterKeys)||new Set(t.pendingParameterKeys).size!==t.pendingParameterKeys.length||t.pendingParameterKeys.some(key=>typeof key!=='string'||!(t.parameters??[]).some(parameter=>parameter.key===key))))return '待归层参数必须是不重复的已注册自定义参数。';
 const serviceError=validateServiceCatalog(t);if(serviceError)return serviceError;
 const profileError=validateProfileAttributeCatalog(t);if(profileError)return profileError;
 const audienceError=validateAudienceCatalog(t);if(audienceError)return audienceError;
 for(const experiment of existing){
  if(experiment.audienceId!==undefined&&(typeof experiment.audienceId!=='string'||!getAudienceById(experiment.audienceId,t)))return '实验引用了未知受众版本。';
  if(reserveStatuses.includes(experiment.status)||Object.prototype.hasOwnProperty.call(experiment,'bucketRanges')){const invalid=validateBucketAllocation(experiment);if(invalid)return `${experiment.name}：${invalid}`;}
 }
 if(t.layers.some(l=>!l||!Array.isArray(l.parameterKeys)))return '参数层配置格式无效。';
 const all=[...t.domains,...t.layers];if(all.some(n=>!n||typeof n.id!=='string'||!n.id||typeof n.name!=='string')||new Set(all.map(n=>n.id)).size!==all.length)return '域与层的标识必须存在且全局唯一。';
 for(const node of all){const error=validateResourceManagement(node.management);if(error)return `${node.name}：${error}`;}
 const roots=t.domains.filter(d=>d.parentLayerId===null);if(roots.length!==1||roots[0].id!=='root'||roots[0].traffic!==100||roots[0].start!==0)return '必须有唯一的默认根域，覆盖全部流量。';
 const rootLayers=domainLayers('root',t);if(rootLayers.length!==1||rootLayers[0].id!=='root-layer'||rootLayers[0].role!=='routing'||rootLayers[0].parameterKeys.join()!=='*')return '默认域必须包含唯一的全参数默认路由层。';
 for(const d of t.domains){
  if(d.audienceId!==undefined&&(typeof d.audienceId!=='string'||!getAudienceById(d.audienceId,t)))return '域引用了未知受众版本。';
  if(audienceIsEmpty(domainEffectiveAudience(d.id,t)))return `${d.name} 与祖先域的受众条件相互矛盾，交集为空。`;
  if(!['overlapping','non-overlapping'].includes(d.mode))return `${d.name} 的父层桶范围无效。`;
  const bucketError=validateBucketAllocation(d);if(bucketError)return `${d.name} 的父层桶范围无效：${bucketError}`;
  const p=d.parentLayerId===null?null:t.layers.find(l=>l.id===d.parentLayerId);if(d.parentLayerId!==null&&!p)return `${d.name} 缺少父层。`;
  const ancestors=new Set<string>();let cursor:TrafficDomain|undefined=d;
  while(cursor){if(ancestors.has(cursor.id))return '层域结构不能形成环。';ancestors.add(cursor.id);if(ancestors.size>16)return '原型最多支持 16 级域嵌套。';if(cursor.parentLayerId===null)break;const parentLayer=t.layers.find(l=>l.id===cursor!.parentLayerId);cursor=t.domains.find(x=>x.id===parentLayer?.domainId);if(!cursor)return '域必须通过父层连接到默认根域。'}
  if(d.unit!=='user_id'||(p&&t.domains.find(x=>x.id===p.domainId)?.unit!==d.unit))return '子域必须继承父层所属域的随机化单元 user_id。';
  const dl=domainLayers(d.id,t);if(!dl.length)return `${d.name} 至少需要一个参数层。`;
  if(d.mode==='non-overlapping'&&(dl.length!==1||maxConcurrent(d.id,t)>1))return '非重叠域需要单个完整参数层，所有后代分支须保持至多一个实验。';
  const allowed=domainScope(d.id,t),used:string[]=[];
  for(const l of dl){
   if(!Array.isArray(l.parameterKeys)||l.parameterKeys.some(k=>typeof k!=='string'))return `${l.name} 参数集合格式无效。`;
   if(l.parameterKeys.some(key=>isParameterPending(key,t)))return `${l.name} 不能直接引用待归层参数，请先完成完整归层。`;
   if(l.parameterKeys.includes('*')&&l.parameterKeys.length!==1)return '继承全部参数的星号不能与具体参数混用。';
   const keys=layerScope(l.id,t);
   if(!keys.length&&(childDomains(l.id,t).length||existing.some(experiment=>experiment.layerId===l.id)))return '待配置的空参数层不能承载实验（包括 A/A）或子域。';
   if(keys.some(k=>!allowed.includes(k)))return `${l.name} 的参数超出父层范围。`;
   if(keys.some(k=>used.includes(k))||new Set(keys).size!==keys.length)return `${d.name} 内的参数必须唯一归层。`;
   used.push(...keys);
  }
  if(allowed.some(k=>!used.includes(k)))return `${d.name} 的子层必须完整划分父层参数。`;
 }
 for(const l of t.layers){if(!t.domains.some(d=>d.id===l.domainId))return `${l.name} 缺少所属域。`;const ranges=occupiedRanges(l.id,existing,undefined,t);for(let i=0;i<ranges.length;i++)for(let j=0;j<i;j++)if(intersectBucketRanges(ranges[i].bucketRanges,ranges[j].bucketRanges).length&&audiencesMayOverlap(ranges[i].condition,ranges[j].condition))return `${l.name} 中的实验与子域桶区间发生重叠，且「${ranges[i].name}」与「${ranges[j].name}」受众可能重叠。`}
 return null;
}
export type AllocationCandidate=Pick<Experiment,'id'|'domainId'|'layerId'|'bucketStart'|'traffic'|'bucketRanges'|'audience'|'audienceId'>;
export type AllocationConflict={kind:'experiment'|'domain';id:string;name:string;layerId:string;start:number;end:number;bucketRanges:BucketRange[];reason:string;witness?:AudienceProfile;unknown:boolean};
/** The candidate can also represent a child-domain reservation in its parent's layer. */
export function explainAllocationConflicts(candidate:AllocationCandidate,existing:Experiment[],t:Topology=current()):AllocationConflict[]{
 const condition=experimentEffectiveAudience(candidate,t);
 const candidateRanges=getBucketRanges(candidate);
 return occupiedRanges(candidate.layerId,existing,candidate.id,t).flatMap(range=>{
  const intersection=intersectBucketRanges(candidateRanges,range.bucketRanges);if(!intersection.length)return [];
  const comparison=compareAudienceConditions(condition,range.condition);
  return comparison.relation==='disjoint'?[]:[{kind:range.kind,id:range.id,name:range.name,layerId:candidate.layerId,start:intersection[0].start/100,end:intersection[0].end/100,bucketRanges:intersection,reason:comparison.reason,...(comparison.witness?{witness:comparison.witness}:{}),unknown:comparison.unknown}];
 });
}
export function validateAllocation(e:Experiment,existing:Experiment[],t:Topology=current()):string|null{
 if([...t.domains,...t.layers].some(n=>n.id===e.id))return '实验标识不能与域或层标识相同。';
 const domain=t.domains.find(d=>d.id===e.domainId),layer=t.layers.find(l=>l.id===e.layerId);
 if(!domain||!layer||layer.domainId!==domain.id)return '实验层必须属于所选域。';
 if(e.audienceId!==undefined&&(typeof e.audienceId!=='string'||!getAudienceById(e.audienceId,t)))return '实验引用了未知受众版本。';
 const effectiveAudience=experimentEffectiveAudience(e,t);if(audienceIsEmpty(effectiveAudience))return '实验与继承域的受众条件交集为空。';
 if(layer.role==='routing')return '默认路由层仅用于划分子域，请在普通参数层创建实验。';
 if(!layerScope(layer.id,t).length)return '待配置的空参数层不能创建实验（包括 A/A），请先分配参数。';
 if(e.parameterKeys.some(key=>isParameterPending(key,t)))return '实验不能使用待归层参数，请先完成参数归层。';
 if(e.unit!==domain.unit)return '随机化单元必须与域一致，当前域使用 user_id。';
 const bucketError=validateBucketAllocation(e);if(bucketError)return `实验桶范围无效：${bucketError}`;
 const variantError=validateExperimentVariants(e.variants);if(variantError)return variantError;
 if(e.parameterKeys.some(key=>!layerScope(layer.id,t).includes(key)))return '实验覆盖了本层之外的参数；子域不能扩大父层的参数范围。';
 const payloadKeys:string[][]=[];for(const variant of e.variants){try{const payload=JSON.parse(variant.value);if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error();payloadKeys.push(Object.keys(payload).sort());for(const key of Object.keys(payload)){const definition=getParameterDefinition(key,t);if(definition){const error=validateParameterValue(definition,payload[key]);if(error)return `${variant.name}：${error}`}}}catch{return '版本参数必须是有效的 JSON 对象。'}}
 if(payloadKeys.some(keys=>JSON.stringify(keys)!==JSON.stringify([...e.parameterKeys].sort())))return '各版本的参数名必须一致，并与声明的参数集合相同。';
 // Archived combination rules are not runtime gates. Validate only explicitly retained execution bindings.
 const coordinationError=e.coordination===undefined?null:validateCoordination({...e,coordination:{...e.coordination,rules:[]}});if(coordinationError)return coordinationError;
 const conflict=explainAllocationConflicts(e,existing,t)[0];
 if(conflict)return `此实验桶区间已被占用或预留（包括子域），且与「${conflict.name}」在 ${formatBucketRanges(conflict.bucketRanges)} 桶受众可能重叠：${conflict.reason}`;return null;
}
let topologySnapshot:Topology=current();const listeners=new Set<()=>void>();
export const getTopology=()=>topologySnapshot;
export const subscribeTopology=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}};
export function saveTopology(next:Topology,existing:Experiment[]):string|null{
 if(topologyLoadError)return topologyLoadError;
 const error=validateTopology(next,existing);if(error)return error;
 if(serviceCatalog!==undefined&&next.catalog===undefined)return '当前配置已有服务与标签目录，保存时必须保留完整目录；请重新读取最新配置后再修改。';
 if(pendingParameterKeys!==undefined&&next.pendingParameterKeys===undefined)return '当前配置已有参数归层状态，保存时必须保留该字段，避免待归层参数被自动激活；请重新读取最新配置后再修改。';
 for(const definition of parameterDefinitions){if(JSON.stringify(getParameterDefinition(definition.key,next))!==JSON.stringify(definition))return '已注册参数的定义不能直接删除或修改，请保留当前参数目录。';}
 const normalized:Topology={...next,catalog:structuredClone(getCatalog(next))};
 for(const key of parameterKeys(next).filter(key=>!parameterKeys(current()).includes(key))){if(!normalized.catalog!.bindings.find(binding=>binding.key===key)?.serviceId)return '新注册参数必须绑定已登记的所属服务。';}
 for(const binding of getCatalog(current()).bindings){if(binding.serviceId!==null&&normalized.catalog!.bindings.find(item=>item.key===binding.key)?.serviceId!==binding.serviceId)return '已明确的参数所属服务不能直接修改或删除；请保留现有服务归属。';}
 const transitionError=validateCatalogTransition(current(),normalized);if(transitionError)return transitionError;
 const audienceTransition=validateAudienceTransition(current(),normalized);if(audienceTransition)return audienceTransition;
 const profileTransition=validateProfileAttributeTransition(current(),normalized);if(profileTransition)return profileTransition;
 for(const previous of domains){
  const candidate=normalized.domains.find(domain=>domain.id===previous.id);if(!candidate)continue;
  if(Object.prototype.hasOwnProperty.call(previous,'bucketRanges')&&!Object.prototype.hasOwnProperty.call(candidate,'bucketRanges'))return '已有域的显式桶段不能省略，请保留完整分流配置。';
  if(previous.start!==candidate.start||previous.traffic!==candidate.traffic||JSON.stringify(unionBucketRanges(getBucketRanges(previous)))!==JSON.stringify(unionBucketRanges(getBucketRanges(candidate))))return '已有域的桶分配不能直接重排或调整，请保留原有用户入组范围。';
 }
 for(const key of activeParameterKeys(current()))if(isParameterPending(key,normalized))return '已归层参数不能退回待归层状态。';
 for(const previous of layers){
  const before=layerScope(previous.id,current()),after=layerScope(previous.id,normalized);
  if(before.length&&!after.length)return '已有非空参数层不能直接清空或删除，请保留原有参数层。';
  for(const key of before.filter(key=>!after.includes(key))){
   const option=layerParameterOptions(previous.domainId,existing,current()).find(item=>item.key===key&&item.sourceLayerId===previous.id);
   if(option?.blockedReason)return `${key}：${option.blockedReason}`;
  }
 }
 for(const e of existing.filter(e=>reserveStatuses.includes(e.status))){const invalid=validateAllocation(e,existing,next);if(invalid)return `${e.name}：${invalid}`}
 try{if(typeof localStorage!=='undefined'){
  if(localStorage.getItem('exp-lab-topology-v1')!==topologyStorageRaw)return '层域或应用配置已在其他页面更新，请刷新后重试。当前填写内容仍保留。';
  const raw=JSON.stringify(normalized);localStorage.setItem('exp-lab-topology-v1',raw);topologyStorageRaw=raw;
 }}catch{return '浏览器存储失败，层域配置尚未保存。'}
 domains=structuredClone(normalized.domains);layers=structuredClone(normalized.layers);parameterDefinitions=structuredClone(normalized.parameters??[]);serviceCatalog=structuredClone(normalized.catalog);pendingParameterKeys=normalized.pendingParameterKeys===undefined?undefined:structuredClone(normalized.pendingParameterKeys);audienceDefinitions=normalized.audiences===undefined?undefined:structuredClone(normalized.audiences);profileAttributeDefinitions=normalized.profileAttributes===undefined?undefined:structuredClone(normalized.profileAttributes);registeredParameters=parameterKeys(normalized);topologySnapshot=current();listeners.forEach(fn=>fn());return null;
}

export type LayerParameterOption={key:string;sourceLayerId:string;sourceLayerName:string;blockedReason:string|null;pending?:boolean};
export type NewLayerInput={id:string;domainId:string;name:string;description:string;parameterKeys:string[];pendingSelections?:Record<string,string>;management?:ResourceManagement};
/** Normal layers partition parameters, not traffic. A non-overlapping branch must stay single-layer. */
export function layerCreationBlock(domainId:string,t:Topology=current()):string|null{
 const domain=t.domains.find(d=>d.id===domainId);
 if(!domain)return '所选域不存在。';
 if(domain.parentLayerId===null)return '默认域保留唯一的默认路由层。请进入下级重叠域新建参数层。';
 if(domain.mode==='non-overlapping')return '非重叠域只能有一个完整参数层。如需多个并行参数层，请在父层创建重叠子域。';
 const isolatedAncestor=nodePath('domain',domainId,t).some(n=>n.kind==='domain'&&n.id!==domainId&&t.domains.find(d=>d.id===n.id)?.mode==='non-overlapping');
 if(isolatedAncestor)return '祖先域为非重叠模式，当前分支不能增加并行参数层。';
 return null;
}
export function layerParameterOptions(domainId:string,existing:Experiment[],t:Topology=current()):LayerParameterOption[]{
 if(!t.domains.some(domain=>domain.id===domainId))return [];
 return [...domainLayers(domainId,t).flatMap(layer=>{
  const scope=layerScope(layer.id,t),children=childDomains(layer.id,t);
  return scope.map(key=>{
   const users=existing.filter(e=>e.layerId===layer.id&&e.status!=='completed'&&e.parameterKeys.includes(key));
   const blockedReason=children.length?`已被子域继承：${children.map(d=>d.name).join('、')}`:users.length?`已有未结束实验使用：${users.map(e=>e.name).join('、')}`:scope.length===1?'来源层仅有这一个参数，需保留至少一个参数。':null;
   return {key,sourceLayerId:layer.id,sourceLayerName:layer.name,blockedReason};
  });
 }),...(t.pendingParameterKeys??[]).map(key=>({key,sourceLayerId:'',sourceLayerName:'待归层',blockedReason:null,pending:true}))];
}
function newLayerAssignmentState(input:NewLayerInput,t:Topology):{topology:Topology;selections:Record<string,string>;forced:Record<string,string>}{
 const topology=structuredClone(t);
 topology.layers.push({id:input.id,domainId:input.domainId,name:input.name.trim()||'新参数层',description:input.description,parameterKeys:[],role:'normal',...(input.management===undefined?{}:{management:structuredClone(input.management)})});
 const forced:Record<string,string>={[input.domainId]:input.id};
 for(const node of nodePath('domain',input.domainId,t).filter(node=>node.kind==='layer')){
  const layer=t.layers.find(layer=>layer.id===node.id);if(layer)forced[layer.domainId]=layer.id;
 }
 return {topology,selections:{...input.pendingSelections,...forced},forced};
}
export function newLayerRegistrationAssignments(input:NewLayerInput,t:Topology=current()):RegistrationAssignment[]{
 const preview=newLayerAssignmentState(input,t);
 return registrationAssignments(preview.selections,preview.topology).map(row=>({...row,...(preview.forced[row.domainId]?{forced:true}:{})}));
}
/** Atomically repartition unused parameters; retain every existing layer id, bucket and experiment. */
export function planLayerCreation(input:NewLayerInput,existing:Experiment[],t:Topology=current()):{topology:Topology|null;error:string|null}{
 const reject=(error:string)=>({topology:null,error});
 const originalError=validateTopology(t,existing);if(originalError)return reject(originalError);
 const managementError=validateResourceManagement(input.management);if(managementError)return reject(managementError);
 const blocked=layerCreationBlock(input.domainId,t);if(blocked)return reject(blocked);
 const name=input.name.trim();if(!name)return reject('请填写层名称。');
 if(name.length>40)return reject('层名称不能超过 40 个字符。');
 if(domainLayers(input.domainId,t).some(l=>l.name.trim()===name))return reject('当前域已存在同名参数层，请使用其他名称。');
 if(!input.id.trim()||[...t.domains,...t.layers,...existing].some(n=>n.id===input.id))return reject('层标识不能为空，也不能与已有域、层或实验重复。');
 if(!Array.isArray(input.parameterKeys))return reject('新层参数集合格式无效。');
 if(new Set(input.parameterKeys).size!==input.parameterKeys.length)return reject('新层参数不能重复。');
 const options=layerParameterOptions(input.domainId,existing,t);
 for(const key of input.parameterKeys){const option=options.find(p=>p.key===key);if(!option)return reject(`参数 ${key} 不在当前域的继承范围内。`);if(option.blockedReason)return reject(`${key}：${option.blockedReason}`)}
 const pendingKeys=input.parameterKeys.filter(key=>isParameterPending(key,t));
 const activeKeys=input.parameterKeys.filter(key=>!isParameterPending(key,t));
 const moved=new Set(activeKeys),sourceIds=new Set(options.filter(p=>moved.has(p.key)).map(p=>p.sourceLayerId));
 let next=structuredClone(t);
 for(const layer of next.layers.filter(l=>sourceIds.has(l.id))){
  const remaining=layerScope(layer.id,t).filter(key=>!moved.has(key));
  if(!remaining.length)return reject(`「${layer.name}」至少需要保留一个参数，请减少勾选。`);
  layer.parameterKeys=remaining;
 }
 next.layers.push({id:input.id,domainId:input.domainId,name,description:input.description.trim(),parameterKeys:[...activeKeys],role:'normal',...(input.management===undefined?{}:{management:{...structuredClone(input.management),owner:input.management.owner.trim()}})});
 if(pendingKeys.length){
  const assignment=newLayerAssignmentState(input,t);
  for(const [domainId,layerId]of Object.entries(assignment.forced))if(input.pendingSelections?.[domainId]&&input.pendingSelections[domainId]!==layerId)return reject('新参数必须沿目标新层及其祖先路径归层，不能修改强制路径。');
  for(const key of pendingKeys){
   const assigned=planParameterLayerAssignment(key,assignment.selections,existing,next);
   if(assigned.error||!assigned.topology)return reject(assigned.error??'待归层参数分配失败。');
   next=assigned.topology;
  }
 }
 const invalid=validateTopology(next,existing);if(invalid)return reject(invalid);
 for(const e of existing.filter(e=>reserveStatuses.includes(e.status))){const error=validateAllocation(e,existing,next);if(error)return reject(`${e.name}：${error}`)}
 return {topology:next,error:null};
}

export type LayerDecision={layerId:string;layerName:string;domainId:string;depth:number;bucket:number;childDomainId:string|null;experimentId:string|null;experimentName:string|null;variant:string|null;variantId?:string;variantRole?:VariantRole;parameters:Record<string,unknown>;reason:string;audienceStatus?:'match'|'not-match'|'unknown'};
export type SimulationTrace={kind:'domain'|'layer'|'experiment'|'default';id:string;name:string;depth:number;domainId:string;layerId?:string;bucket?:number;globalTraffic?:number;reason:string;variantId?:string;variantRole?:VariantRole;audienceStatus?:'match'|'not-match'|'unknown'};
export type AllocationSimulation={unitId:string;domain:TrafficDomain;domainBucket:number;decisions:LayerDecision[];mergedParameters:Record<string,unknown>;enteredDomains:string[];visitedNodeIds:string[];trace:SimulationTrace[];error?:string};
function hashBucket(text:string):number{let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)}h^=h>>>16;h=Math.imul(h,0x85ebca6b);h^=h>>>13;h=Math.imul(h,0xc2b2ae35);h^=h>>>16;return(h>>>0)%10000}
export function simulateAllocation(unitId:string,existing:Experiment[],t:Topology=current(),profile:AudienceProfile={}):AllocationSimulation{
 const unit=unitId.trim(),bucket=hashBucket(`workspace:domain-epoch-1:${unit}`)/100;
 const root=t.domains.find(d=>d.id==='root')??defaultTopology.domains[0];
 const result:AllocationSimulation={unitId:unit,domain:root,domainBucket:bucket,decisions:[],mergedParameters:{},enteredDomains:[],visitedNodeIds:[],trace:[]};
 if(!unit)return {...result,error:'请输入一个非空的 user_id。'};
 const invalid=validateTopology(t,existing);if(invalid)return {...result,error:invalid};
 for(const e of existing.filter(x=>reserveStatuses.includes(x.status))){const error=validateAllocation(e,existing,t);if(error)return {...result,error:`${e.name}：${error}`}}
 const rootEligibility=evaluateAudience(domainEffectiveAudience(root.id,t),profile);
 if(rootEligibility.status!=='match'){result.trace.push({kind:'default',id:'audience-root',name:'根域受众未命中',depth:0,domainId:root.id,reason:rootEligibility.reason,audienceStatus:rootEligibility.status});return result}
 function walk(domain:TrafficDomain,depth:number){
  result.enteredDomains.push(domain.id);result.visitedNodeIds.push(domain.id);
  result.trace.push({kind:'domain',id:domain.id,name:domain.name,domainId:domain.id,depth,globalTraffic:domainGlobalTraffic(domain.id,t),reason:domain.parentLayerId?'从父层的互斥桶段进入；只在此分支内继续分流':'默认域覆盖全部流量'});
  for(const layer of domainLayers(domain.id,t)){
   if(layer.role!=='routing'&&!layerScope(layer.id,t).length)continue;
   const b=layer.id==='root-layer'?bucket:hashBucket(`domain:${domain.id}:layer:${layer.id}:epoch-1:${unit}`)/100;
   const candidates=occupiedRanges(layer.id,existing,undefined,t).filter(range=>bucketInRanges(Math.round(b*100),range.bucketRanges)).map(range=>({...range,eligibility:evaluateAudience(range.condition,profile)}));
   const matches=candidates.filter(candidate=>candidate.eligibility.status==='match');
   if(matches.length>1){result.error='同桶出现多个符合受众的候选，已拒绝分配，不能按优先级挑选。';return}
   const selected=matches[0];
   const child=selected?.kind==='domain'?t.domains.find(d=>d.id===selected.id):undefined;
   const reserved=selected?.kind==='experiment'?existing.find(e=>e.id===selected.id):undefined;
   const audienceAware=candidates.length>1||candidates.some(candidate=>audienceRuleCount(candidate.condition)>0||candidate.condition.unknown);
   const audienceStatus=selected?'match' as const:candidates.some(candidate=>candidate.eligibility.status==='unknown')?'unknown' as const:'not-match' as const;
   const candidateExplanation=audienceAware?[...candidates].sort((a,b)=>a.id.localeCompare(b.id)).map(candidate=>`「${candidate.name}」${{match:'匹配','not-match':'不匹配',unknown:'未知'}[candidate.eligibility.status]}：${candidate.eligibility.reason}`).join(' '):'';
   const rejection=candidates.length&&!selected?candidateExplanation:'';
   const decision:LayerDecision={layerId:layer.id,layerName:layer.name,domainId:domain.id,depth,bucket:b,childDomainId:child?.id??null,experimentId:null,experimentName:null,variant:null,parameters:{},reason:rejection||'未命中实验或子域区间，使用默认参数',...(audienceAware?{audienceStatus}:{})};
   result.decisions.push(decision);result.visitedNodeIds.push(layer.id);
   result.trace.push({kind:'layer',id:layer.id,name:layer.name,domainId:domain.id,layerId:layer.id,depth:depth+1,bucket:b,reason:audienceAware?`本层保持固定桶，在同桶候选中校验受众。${candidateExplanation}`:child?'本层桶命中子域，跳过本层直接实验':'本层独立计算固定桶，子域与直接实验共享此桶空间',...(audienceAware?{audienceStatus}:{})});
   if(child){decision.reason=`进入「${child.name}」${formatBucketRanges(getBucketRanges(child))} 桶；不命中本层直接实验`;if(layer.id==='root-layer')result.domain=child;walk(child,depth+2);continue}
   if(reserved?.status==='running'){
    const variantBucket=hashBucket(`experiment:${reserved.id}:variant-epoch-1:${unit}`),vb=variantBucket/100;
    const variant=selectExperimentVariant(reserved.variants,variantBucket);
    if(!variant){result.error='实验分组配置无法解析，已拒绝分配。';return}
    const identity=hasExplicitVariantMetadata(reserved.variants)?{variantId:variant.id!,variantRole:getVariantRole(variant,reserved.variants.indexOf(variant))}:{};
    const parameters=JSON.parse(variant.value) as Record<string,unknown>;
    if(Object.keys(parameters).some(k=>Object.prototype.hasOwnProperty.call(result.mergedParameters,k))){result.error='并行分支出现重复参数覆盖，已拒绝合并。';return}
    Object.assign(result.mergedParameters,parameters);Object.assign(decision,{experimentId:reserved.id,experimentName:reserved.name,variant:variant.name,...identity,parameters,reason:audienceAware?`固定入组画像满足受众，命中固定桶区间${candidates.length>1?'；与互斥人群复用桶，未重新分桶':''}`:'满足示例活跃用户资格，命中固定桶区间'});
    result.trace.push({kind:'experiment',id:reserved.id,name:`${reserved.name} · ${variant.name}`,domainId:domain.id,layerId:layer.id,depth:depth+2,bucket:vb,reason:'此分支的最终实验版本',...identity,...(audienceAware?{audienceStatus}:{})});
   }else{
    if(reserved)decision.reason=`该桶由「${reserved.name}」${reserved.status==='paused'?'暂停保留':'待审核预留'}，使用默认参数`;
    result.trace.push({kind:'default',id:`default-${layer.id}`,name:'使用默认参数',domainId:domain.id,layerId:layer.id,depth:depth+2,reason:decision.reason,...(audienceAware?{audienceStatus}:{})});
   }
  }
 }
 walk(root,0);if(result.error)result.mergedParameters={};return result;
}

const legacyParam:Record<string,string>={homepage_recommend_v3:'ranking.model',product_detail_layout:'ui.layout',search_rank_v2:'ranking.search',checkout_cache:'checkout.cache_ttl',onboarding_flow:'ui.onboarding',coupon_smart_assign:'pricing.coupon',cart_recommend:'ui.cart',api_parallel:'checkout.parallel',membership_entry:'ui.membership',recall_diversity:'ranking.recall',inventory_reserve:'checkout.inventory',content_card_style:'ui.content_card',longtail_recall:'ranking.longtail'};
/** Upgrade only previous prototype fields; already explicit allocations stay unchanged. */
export function normalizeExperiments(existing:Experiment[],t:Topology=current()):Experiment[]{
 const layers=t.layers;
 const upgraded:Experiment[]=[];
 for(const e of existing){
  if(Object.prototype.hasOwnProperty.call(e,'bucketRanges')||(e.domainId&&e.layerId&&e.parameterKeys&&Number.isFinite(e.bucketStart))){upgraded.push(e);continue}
  const key=legacyParam[e.key]??(e.type==='frontend'?'ui.layout':e.type==='backend'?'checkout.cache_ttl':'ranking.model');
  const layer=layers.find(l=>l.domainId==='overlap'&&l.parameterKeys.includes(key))!;
  const bucketStart=findAvailableStart(layer.id,e.traffic||1,upgraded,undefined,t,e)??0;
  upgraded.push({...e,domainId:'overlap',layerId:layer.id,layer:layer.name,parameterKeys:[key],bucketStart,unit:'user_id',variants:e.variants.map((v,i)=>{
   let old:unknown=v.value;try{const object=JSON.parse(v.value);old=typeof object==='object'&&object!==null?Object.values(object)[0]:object}catch{ /* legacy scalar */ }
   return {...v,value:JSON.stringify({[key]:old??(i?'treatment':'baseline')})};
  })});
 }
 return upgraded;
}

/** Add nested examples only to genuinely free parent buckets during a flat-model upgrade.
 * Existing explicit experiment intervals never move. A saved topology takes precedence. */
export function migrateFlatTopology(existing:Experiment[]):Topology{
 const base:Topology={domains:structuredClone(defaultTopology.domains.filter(d=>['root','overlap','exclusive'].includes(d.id))),layers:structuredClone(defaultTopology.layers.filter(l=>['root','overlap','exclusive'].includes(l.domainId)))};
 const reserved=normalizeExperiments(existing,base);
 for(const id of ['ui-mobile','ui-isolation']){
  const source=defaultTopology.domains.find(d=>d.id===id)!;
  const branchIds=id==='ui-mobile'?['ui-mobile','card-depth']:['ui-isolation'];
  const originalFree=!occupiedRanges(source.parentLayerId!,reserved,undefined,base).some(r=>intersectBucketRanges(getBucketRanges(source),r.bucketRanges).length);
  const start=originalFree?source.start:findAvailableStart(source.parentLayerId!,source.traffic,reserved,undefined,base);
  if(start===null)continue;
  base.domains.push(...structuredClone(defaultTopology.domains.filter(d=>branchIds.includes(d.id))).map(d=>d.id===id?{...d,start}:d));
  base.layers.push(...structuredClone(defaultTopology.layers.filter(l=>branchIds.includes(l.domainId))));
 }
 return base;
}
try{
 if(typeof localStorage!=='undefined'){
  const rawTopology=localStorage.getItem('exp-lab-topology-v1');
  topologyStorageRaw=rawTopology;
  if(rawTopology){
   const migration=migrateServiceCatalog(JSON.parse(rawTopology));
   const invalid=migration.error??(migration.topology?validateTopology(migration.topology):'保存的配置为空。');
   if(invalid)topologyLoadError=`保存的层域或应用标签配置无效：${invalid} 原始数据已保留，已暂停写入；请修复配置后刷新重试。`;
   else if(migration.topology){
    const saved=migration.topology;
    if(migration.migrated){try{const raw=JSON.stringify(saved);localStorage.setItem('exp-lab-topology-v1',raw);topologyStorageRaw=raw}catch{topologyLoadError='应用私有标签迁移保存失败，可能是浏览器存储空间不足。原始数据已保留，已暂停写入；请恢复存储后刷新重试。';}}
    if(!topologyLoadError){domains=saved.domains;layers=saved.layers;parameterDefinitions=saved.parameters??[];serviceCatalog=saved.catalog;pendingParameterKeys=saved.pendingParameterKeys;audienceDefinitions=saved.audiences;profileAttributeDefinitions=saved.profileAttributes;registeredParameters=parameterKeys(saved);topologySnapshot=current()}
   }
  }
  else{
   const raw=JSON.parse(localStorage.getItem('exp-lab-experiments-v3')||localStorage.getItem('exp-lab-experiments-v2')||localStorage.getItem('exp-lab-experiments-v1')||'null');
   if(Array.isArray(raw)&&raw.every(e=>e?.id&&Array.isArray(e.variants))){
    // Already nested saved experiments require their exact topology, not a guessed migration.
    const alreadyNested=raw.some(e=>e.domainId&&!['overlap','exclusive'].includes(e.domainId));
    const adapted=alreadyNested?structuredClone(defaultTopology):migrateFlatTopology(raw);
    if(!validateTopology(adapted,normalizeExperiments(raw,adapted))){const serialized=JSON.stringify(adapted);localStorage.setItem('exp-lab-topology-v1',serialized);topologyStorageRaw=serialized;domains=adapted.domains;layers=adapted.layers;topologySnapshot=current()}
   }
  }
 }
}catch(error){topologyLoadError=error instanceof SyntaxError?'保存的配置 JSON 无效。原始数据已保留，已暂停写入；请修复配置后刷新重试。':'浏览器配置存储读取失败。原始数据已保留，已暂停写入；请恢复存储后刷新重试。';}
