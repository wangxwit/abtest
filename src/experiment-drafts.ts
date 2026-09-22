import type { DraftExperimentVariant } from './variant-draft-operations';
export type DraftSection = 'goal' | 'traffic' | 'groups' | 'review';
export type ExperimentDraftForm = { name:string; key:string; description:string; hypothesis:string; traffic:number; domainId:string; layerId:string; audienceId:string; variants:DraftExperimentVariant[]; metric:string; guardrails:string[] };
export type ExperimentDraft = { id:string; form:ExperimentDraftForm; section:DraftSection; selectedVariantId?:string; revision:number; createdAt:string; updatedAt:string; submittedExperimentId?:string };
type StorageLike = Pick<Storage,'getItem'|'setItem'|'key'|'length'>;
type Failure = { ok:false; error:string; code:'storage'|'invalid'|'conflict'|'missing'|'submitted'; currentDraft?:ExperimentDraft };
type Result<T> = ({ok:true}&T)|Failure;
export const DRAFT_PREFIX = 'exp-lab-experiment-draft-v1:';
export const DRAFT_CHANGED_EVENT = 'experimentdraftchange';
const sections = ['goal','traffic','groups','review'];
export const validDraftId=(id:string)=>/^draft-[a-zA-Z0-9-]{8,80}$/.test(id);
function validForm(f:ExperimentDraftForm):boolean {
  return !!f && ['name','key','description','hypothesis','domainId','layerId','audienceId','metric'].every(k=>typeof f[k as keyof ExperimentDraftForm]==='string') && Number.isFinite(f.traffic) && Array.isArray(f.guardrails) && f.guardrails.every(s=>typeof s==='string') && Array.isArray(f.variants) && f.variants.length>=2 && f.variants.length<=20 && new Set(f.variants.map(v=>v?.id)).size===f.variants.length && f.variants.every(v=>v && typeof v.id==='string' && !!v.id && typeof v.name==='string' && typeof v.value==='string' && ['control','treatment'].includes(v.role) && Number.isFinite(v.weight));
}
function validRecord(d:ExperimentDraft):boolean{return !!d && validDraftId(d.id) && validForm(d.form) && sections.includes(d.section) && Number.isSafeInteger(d.revision) && d.revision>0 && d.revision<Number.MAX_SAFE_INTEGER && typeof d.createdAt==='string' && Number.isFinite(Date.parse(d.createdAt)) && typeof d.updatedAt==='string' && Number.isFinite(Date.parse(d.updatedAt)) && (d.selectedVariantId===undefined||typeof d.selectedVariantId==='string') && (d.submittedExperimentId===undefined||typeof d.submittedExperimentId==='string'&&!!d.submittedExperimentId);}
const failure=(code:Failure['code'],error:string):Failure=>({ok:false,code,error});
const changed=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event(DRAFT_CHANGED_EVENT));};
export function loadExperimentDraft(id:string, storage?:StorageLike):Result<{draft:ExperimentDraft|null}> {
  if(!validDraftId(id))return failure('invalid','草稿标识无效。');
  try {const raw=(storage??localStorage).getItem(DRAFT_PREFIX+id);if(raw===null)return {ok:true,draft:null};const item=JSON.parse(raw);if(item?.schemaVersion!==1||!validRecord(item.draft)||item.draft.id!==id)return failure('invalid','草稿数据或版本无法读取，原始内容已保留。');return {ok:true,draft:item.draft};}catch{return failure('storage','无法读取浏览器草稿，请检查存储权限；原数据未被覆盖。');}
}
export function createExperimentDraft(input:{form:ExperimentDraftForm;section?:DraftSection;selectedVariantId?:string;id?:string},storage?:StorageLike):Result<{draft:ExperimentDraft}> {
  const id=input.id??`draft-${crypto.randomUUID()}`,now=new Date().toISOString();
  const draft:ExperimentDraft={id,form:structuredClone(input.form),section:input.section??'goal',selectedVariantId:input.selectedVariantId,revision:1,createdAt:now,updatedAt:now};
  if(!validRecord(draft))return failure('invalid','草稿结构无效，无法保存；未要求参数 JSON 配置完整。');
  try {const target=storage??localStorage;if(target.getItem(DRAFT_PREFIX+id)!==null)return failure('conflict','该草稿已存在，请打开现有草稿。');target.setItem(DRAFT_PREFIX+id,JSON.stringify({schemaVersion:1,draft}));changed();return {ok:true,draft};}catch{return failure('storage','草稿未保存：浏览器存储不可用或容量不足。当前输入仍在页面中。');}
}
export function saveExperimentDraft(input:Pick<ExperimentDraft,'id'|'revision'|'form'|'section'|'selectedVariantId'>,storage?:StorageLike):Result<{draft:ExperimentDraft}> {
  const current=loadExperimentDraft(input.id,storage);if(!current.ok)return current;if(!current.draft)return failure('missing','该草稿已不存在，当前内容未写入其他草稿。');
  if(current.draft.submittedExperimentId)return {...failure('submitted','草稿已提交，请查看对应实验。'),currentDraft:current.draft};
  if(current.draft.revision!==input.revision)return {...failure('conflict','草稿已在其他页面更新，自动保存已暂停。可另存当前内容或加载最新版本。'),currentDraft:current.draft};
  const draft:ExperimentDraft={...current.draft,form:structuredClone(input.form),section:input.section,selectedVariantId:input.selectedVariantId,revision:input.revision+1,updatedAt:new Date().toISOString()};
  if(!validRecord(draft))return failure('invalid','草稿结构无法保存，请检查数值输入；参数原文仍保留。');
  try{(storage??localStorage).setItem(DRAFT_PREFIX+input.id,JSON.stringify({schemaVersion:1,draft}));changed();return {ok:true,draft};}catch{return failure('storage','草稿未保存：浏览器存储不可用或容量不足。当前输入仍在页面中。');}
}
export function markExperimentDraftSubmitted(id:string,experimentId:string,revision:number,storage?:StorageLike):Result<{draft:ExperimentDraft}> {
  if(typeof experimentId!=='string'||!experimentId.trim()||experimentId!==experimentId.trim())return failure('invalid','提交标识无效。');
  const result=loadExperimentDraft(id,storage);if(!result.ok)return result;const d=result.draft;if(!d)return failure('missing','找不到提交来源草稿。');
  if(d.submittedExperimentId===experimentId)return {ok:true,draft:d};
  if(d.submittedExperimentId)return failure('submitted','草稿已关联其他实验。');
  if(d.revision!==revision)return failure('conflict','草稿版本已变化，提交记录没有覆盖最新草稿。');
  const draft={...d,submittedExperimentId:experimentId,revision:d.revision+1,updatedAt:new Date().toISOString()};
  if(!validRecord(draft))return failure('invalid','提交标识无效。');
  try{(storage??localStorage).setItem(DRAFT_PREFIX+id,JSON.stringify({schemaVersion:1,draft}));changed();return {ok:true,draft};}catch{return failure('storage','实验已保存，但草稿提交标记未写入；再次打开将按来源标识定位实验。');}
}
export function listExperimentDrafts(storage?:StorageLike):Result<{drafts:ExperimentDraft[];warnings:string[]}> {
  try{const target=storage??localStorage;const drafts:ExperimentDraft[]=[],warnings:string[]=[];for(let i=0;i<target.length;i++){const key=target.key(i);if(!key?.startsWith(DRAFT_PREFIX))continue;const r=loadExperimentDraft(key.slice(DRAFT_PREFIX.length),target);if(!r.ok)warnings.push(r.error);else if(r.draft&&!r.draft.submittedExperimentId)drafts.push(r.draft);}return {ok:true,drafts:drafts.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),warnings};}catch{return failure('storage','无法读取草稿列表，请检查浏览器存储。');}
}

// Used by in-app navigation as well as hash changes; a failed save never silently discards input.
let leaveGuard:(()=>boolean)|null=null;
export function setDraftLeaveGuard(guard:(()=>boolean)|null){leaveGuard=guard;}
export function canLeaveExperimentDraft(){return leaveGuard?.()??true;}
