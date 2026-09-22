import type { Experiment } from './data';
import type { Topology } from './traffic';
import { nodePath } from './traffic.ts';
import { defaultAudiences, getAudienceExpression, getAudiences } from './audiences.ts';
import type { AudienceDefinition, AudienceExpression } from './audiences';

export function audienceAttributeKeys(audience: AudienceDefinition): string[] {
  const keys = new Set<string>();
  const collect = (node: AudienceExpression) => {
    if (node.kind === 'rule') keys.add(node.rule.field);
    else node.children.forEach(collect);
  };
  collect(getAudienceExpression(audience));
  return [...keys];
}

export function audienceUsage(id: string, topology: Topology, experiments: Experiment[]) {
  const directDomains = topology.domains.filter(domain => domain.audienceId === id);
  const directIds = new Set(directDomains.map(domain => domain.id));
  const domains = topology.domains.filter(domain => nodePath('domain',domain.id,topology).some(node => node.kind === 'domain' && directIds.has(node.id)));
  const inheritedIds = new Set(domains.map(domain => domain.id));
  const legacy = defaultAudiences.find(audience => audience.id === id);
  return {directDomains,domains,experiments:experiments.filter(experiment => experiment.audienceId === id || (!experiment.audienceId && legacy && experiment.audience === legacy.name) || inheritedIds.has(experiment.domainId))};
}

export function profileAttributeUsage(key: string, topology: Topology, experiments: Experiment[]) {
  const audiences = getAudiences(topology).filter(audience => audienceAttributeKeys(audience).includes(key));
  const impacts = audiences.map(audience => audienceUsage(audience.id,topology,experiments));
  const domainIds = new Set(impacts.flatMap(impact => impact.domains.map(domain => domain.id)));
  const experimentIds = new Set(impacts.flatMap(impact => impact.experiments.map(experiment => experiment.id)));
  return {audiences,domains:topology.domains.filter(domain => domainIds.has(domain.id)),experiments:experiments.filter(experiment => experimentIds.has(experiment.id))};
}

export type AudienceRoute = {tab:'audiences'|'attributes';id:string|null;invalid:boolean};
export function parseAudienceRoute(hash: string): AudienceRoute {
  const parts = hash.replace(/^#/, '').split('/');
  const tab = parts[1] === 'attributes' ? 'attributes' : 'audiences';
  const rest = parts.slice(tab === 'attributes' ? 2 : 1);
  if (parts[0] !== 'audiences' || rest.length > 1) return {tab,id:null,invalid:true};
  try { return {tab,id:rest[0] ? decodeURIComponent(rest[0]) : null,invalid:false}; }
  catch { return {tab,id:null,invalid:true}; }
}
