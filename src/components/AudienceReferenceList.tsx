import { ArrowUpRight, FlaskConical, GitBranch } from 'lucide-react';
import type { Experiment } from '../data';
import type { Topology, TrafficDomain } from '../traffic';
import { nodePath } from '../traffic';
import { audienceSummary, domainEffectiveAudience, getAudiences } from '../audiences';
import { audienceAttributeKeys, audienceUsage } from '../audience-management';
import { audienceReferenceHref } from '../audience-reference-routes';
import { experimentAudienceListHref } from '../experiment-audience-filter';

type Props = {
  domains: TrafficDomain[];
  experiments: Experiment[];
  topology: Topology;
  context: { audienceId?: string; attributeKey?: string };
};

export default function AudienceReferenceList({ domains, experiments, topology, context }: Props) {
  const audienceExperimentGroups = context.attributeKey ? getAudiences(topology)
    .filter(audience => audienceAttributeKeys(audience).includes(context.attributeKey!))
    .map(audience => ({ audience, count: audienceUsage(audience.id, topology, experiments).experiments.length }))
    .filter(group => group.count > 0) : [];
  const directReference = (audienceId?: string) => {
    if (!audienceId) return false;
    if (context.audienceId) return audienceId === context.audienceId;
    const audience = getAudiences(topology).find(item => item.id === audienceId);
    return Boolean(audience && context.attributeKey && audienceAttributeKeys(audience).includes(context.attributeKey));
  };
  return <div className="aud-reference-list">
    {context.audienceId ? <a className="aud-reference aud-experiment-summary" href={experimentAudienceListHref(context.audienceId)}>
      <FlaskConical size={18}/><span><strong>查看引用实验 <b>{experiments.length}</b></strong><small>打开实验列表，筛选直接引用或通过祖先域继承当前受众版本的实验。</small></span><ArrowUpRight size={16}/>
    </a> : context.attributeKey ? <div className="aud-experiment-groups">
      <div className="aud-ref-heading">按受众版本查看引用实验</div>
      <p className="aud-reference-help">以下受众版本直接使用此属性。实验数包含祖先域继承，同一实验可引用多个版本。</p>
      {audienceExperimentGroups.map(({ audience, count }) => <a key={audience.id} className="aud-reference aud-experiment-version" href={experimentAudienceListHref(audience.id)}>
        <FlaskConical size={15}/><span><strong>{audience.name} · v{audience.version}</strong><small>查看引用实验 {count} · 含祖先域继承</small></span><ArrowUpRight size={14}/>
      </a>)}
      {!audienceExperimentGroups.length && <div className="aud-no-refs">暂无实验引用或继承使用此属性的受众版本。</div>}
    </div> : null}
    <div className="aud-ref-heading">引用或继承的域 · {domains.length}</div>
    {domains.map(domain => <a key={domain.id} className="aud-reference aud-reference-with-condition" href={audienceReferenceHref('domain', domain.id, context)}>
      <GitBranch size={15}/><span><span className="aud-reference-title"><strong>{domain.name}</strong><em>{directReference(domain.audienceId) ? '直接引用' : '继承引用'}</em></span><small>{nodePath('domain', domain.id, topology).filter(node => node.kind === 'domain').map(node => node.name).join(' → ')}</small><span className="aud-reference-condition"><b>有效准入条件</b>{audienceSummary(domainEffectiveAudience(domain.id, topology))}</span><span className="aud-reference-action">查看域及受众条件<ArrowUpRight size={12}/></span></span>
    </a>)}
    {!domains.length && <div className="aud-no-refs">暂无域引用或继承</div>}
  </div>;
}
