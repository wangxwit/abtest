import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, CircleAlert, GitBranch, Link2, Users } from 'lucide-react';
import { APPLICATION_ROUTE_CHANGE_EVENT } from '../application-routes';
import { audienceReferenceHref, type AudienceReferenceResolution } from '../audience-reference-routes';
import { describeExpression } from '../audiences';
import { getTopology } from '../traffic';
import './audience-reference-context.css';

export function useAudienceReferenceHash(): string {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const sync = () => setHash(location.hash);
    window.addEventListener('hashchange', sync);
    window.addEventListener(APPLICATION_ROUTE_CHANGE_EVENT, sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener(APPLICATION_ROUTE_CHANGE_EVENT, sync); };
  }, []);
  return hash;
}

type Props = { kind: 'domain' | 'experiment'; targetId: string; hash: string; resolution: AudienceReferenceResolution };
export default function AudienceReferenceContext({ kind, targetId, hash, resolution }: Props) {
  const ref = useRef<HTMLElement>(null);
  const matched = resolution.status === 'matched';
  useEffect(() => {
    if (!matched) return;
    const frame = requestAnimationFrame(() => { ref.current?.scrollIntoView({ block: 'center', behavior: 'instant' }); ref.current?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [hash, targetId, matched]);
  if (resolution.status === 'none') return null;
  const sourceLabel = resolution.audience ? `${resolution.audience.name} · v${resolution.audience.version}` : resolution.attribute ? `${resolution.attribute.label} · ${resolution.attribute.key}` : '无法验证的引用来源';
  const relationLabel = resolution.relation === 'both' ? '直接引用及祖先继承' : resolution.relation === 'direct' ? '直接引用' : '祖先继承';
  return <section ref={ref} tabIndex={-1} className={`aud-reference-context ${matched ? 'is-verified' : 'is-unverified'}`} data-audience-reference-status={resolution.status} aria-label={matched ? '已定位的受众引用条件' : '受众引用来源提示'}>
    <header><span className="arc-icon">{matched ? <Link2 size={18}/> : <CircleAlert size={18}/>}</span><div><span className="arc-eyebrow">{resolution.attribute ? '来源画像属性' : '来源受众版本'}</span><h3>{sourceLabel}</h3></div>{matched && <span className="arc-relation">{relationLabel}</span>}</header>
    <p className="arc-message" role={matched ? 'status' : 'alert'}>{resolution.message}</p>
    {matched && <div className="arc-references">{resolution.references.map((reference, index) => <article key={`${reference.audience.id}:${reference.domainId ?? 'self'}:${index}`}>
      <div className="arc-reference-title"><Users size={14}/><a href={`#audiences/${encodeURIComponent(reference.audience.id)}`}>{reference.audience.name} · v{reference.audience.version}<ArrowUpRight size={12}/></a><span>{reference.relation === 'direct' ? '直接引用' : '祖先继承'}{reference.legacy ? ' · 历史名称兼容' : ''}</span></div>
      <div className="arc-reference-origin"><GitBranch size={12}/>{reference.domainName ? `${reference.relation === 'direct' ? '当前域' : '来自域'}：${reference.domainName}` : '实验本身的固定受众版本'}</div>
      {resolution.attribute && <div className="arc-matching-rules"><span>相关条件</span>{reference.rules.map((rule, ruleIndex) => <code key={ruleIndex}>{describeExpression({ kind: 'rule', rule }, getTopology())}</code>)}</div>}
      <p className="arc-expression"><span>该版本完整条件</span>{reference.expression}</p>
    </article>)}</div>}
    {matched && <div className="arc-effective"><strong>当前{kind === 'domain' ? '域' : '实验'}的完整有效条件</strong><p>{resolution.effectiveCondition}</p><small>以上是配置引用关系；用户是否执行仍由固定画像与桶位共同决定。</small></div>}
    <footer>{resolution.sourceHref && <a href={resolution.sourceHref}><ArrowLeft size={13}/>返回来源{resolution.attribute ? '属性' : '受众'}</a>}<a href={audienceReferenceHref(kind, targetId, {})}>关闭来源定位</a></footer>
  </section>;
}
