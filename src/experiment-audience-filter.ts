import type { Experiment } from './data';
import type { Topology } from './traffic';
import { getAudiences } from './audiences.ts';
import { audienceUsage } from './audience-management.ts';

export type ExperimentAudienceFilter = { audienceId: string | null; error: string | null };

export function experimentAudienceListHref(audienceId?: string | null): string {
  return audienceId ? `#experiments?audience=${encodeURIComponent(audienceId)}` : '#experiments';
}

/** Parse only the experiment list; detail-page reference queries have separate semantics. */
export function parseExperimentAudienceFilter(hash: string): ExperimentAudienceFilter {
  const route = hash.replace(/^#/, '');
  const question = route.indexOf('?');
  const path = question === -1 ? route : route.slice(0, question);
  const empty = { audienceId: null, error: null };
  if (path !== 'experiments' || question === -1) return empty;
  const query = route.slice(question + 1);
  if (!query) return empty;
  const invalid = (): ExperimentAudienceFilter => ({ audienceId: null, error: '受众筛选地址无效，请重新选择受众版本或清除筛选。' });
  // URLSearchParams tolerates malformed escapes, so verify decoding before reading values.
  try { decodeURIComponent(query.replaceAll('+', ' ')); } catch { return invalid(); }
  const params = new URLSearchParams(query);
  if ([...params.keys()].some(key => key !== 'audience')) return invalid();
  const values = params.getAll('audience');
  if (values.length !== 1 || !values[0] || values[0] !== values[0].trim()) return invalid();
  return { audienceId: values[0], error: null };
}

/** Match immutable versions using the same direct, legacy and inherited references as usage counts. */
export function filterExperimentsByAudience(experiments: Experiment[], audienceId: string | null, topology: Topology): Experiment[] {
  if (audienceId === null) return [...experiments];
  if (!audienceId || !getAudiences(topology).some(audience => audience.id === audienceId)) return [];
  return audienceUsage(audienceId, topology, experiments).experiments;
}
