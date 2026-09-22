import { validDraftId } from './experiment-drafts.ts';
export type DraftRoute = {kind:'none'}|{kind:'invalid';error:string}|{kind:'new';initialLayerId?:string;copyExperimentId?:string}|{kind:'draft';draftId:string};
export function parseExperimentDraftRoute(hash:string):DraftRoute {
  const [path,query='']=hash.replace(/^#/,'').split('?');if(path!=='experiments/new'&&!path.startsWith('experiments/drafts'))return {kind:'none'};
  const invalid:DraftRoute={kind:'invalid',error:'草稿地址无效，请从实验列表重新打开。'};
  try {decodeURIComponent(query.replaceAll('+',' '));if(hash.split('?').length>2)return invalid;
    if(path==='experiments/new'){const p=new URLSearchParams(query);if([...p.keys()].some(k=>!['layer','copy'].includes(k))||p.getAll('layer').length>1||p.getAll('copy').length>1||p.has('layer')&&p.has('copy'))return invalid;const layer=p.get('layer'),copy=p.get('copy');if([layer,copy].some(v=>v!==null&&(!v||v!==v.trim())))return invalid;return {kind:'new',...(layer?{initialLayerId:layer}:{}),...(copy?{copyExperimentId:copy}:{})};}
    const parts=path.split('/'),id=decodeURIComponent(parts[2]??'');return parts.length===3&&!query&&validDraftId(id)?{kind:'draft',draftId:id}:invalid;
  }catch{return invalid;}
}
export const experimentDraftHref=(id:string)=>`#experiments/drafts/${encodeURIComponent(id)}`;
export const newExperimentHref=(input:{layerId?:string;copyExperimentId?:string}={})=>`#experiments/new${input.layerId?`?layer=${encodeURIComponent(input.layerId)}`:input.copyExperimentId?`?copy=${encodeURIComponent(input.copyExperimentId)}`:''}`;
