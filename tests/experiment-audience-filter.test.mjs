import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAudiences } from '../src/audiences.ts';
import { audienceUsage } from '../src/audience-management.ts';
import { experimentAudienceListHref, filterExperimentsByAudience, parseExperimentAudienceFilter } from '../src/experiment-audience-filter.ts';

const version = (number) => ({ id: `customers-v${number}`, familyId: 'customers', version: number, name: '目标客户', description: '', owner: '产品组', createdAt: '2026-09-12T00:00:00Z', rules: [{ field: 'country', op: 'eq', value: number === 1 ? 'CN' : 'US' }] });
function fixture() {
  return {
    topology: {
      audiences: [...structuredClone(defaultAudiences), version(1), version(2)],
      domains: [{ id: 'root', parentLayerId: null }, { id: 'customers', parentLayerId: 'root-layer', audienceId: 'customers-v1' }, { id: 'nested', parentLayerId: 'customer-layer', audienceId: 'customers-v1' }, { id: 'other', parentLayerId: 'root-layer' }],
      layers: [{ id: 'root-layer', domainId: 'root' }, { id: 'customer-layer', domainId: 'customers' }, { id: 'nested-layer', domainId: 'nested' }, { id: 'other-layer', domainId: 'other' }],
    },
    experiments: [
      { id: 'both', domainId: 'nested', audienceId: 'customers-v1', audience: '目标客户' },
      { id: 'inherited', domainId: 'nested', audienceId: 'customers-v2', audience: '目标客户' },
      { id: 'v2-only', domainId: 'other', audienceId: 'customers-v2', audience: '目标客户' },
      { id: 'same-name-only', domainId: 'other', audience: '目标客户' },
      { id: 'legacy', domainId: 'other', audience: '新注册用户' },
      { id: 'explicit-wins', domainId: 'other', audienceId: 'customers-v2', audience: '新注册用户' },
    ],
  };
}
const ids = (experiments) => experiments.map(experiment => experiment.id);

test('exact audience versions include ancestor inheritance once and do not expand by family or display name', () => {
  const { topology, experiments } = fixture();
  const selected = filterExperimentsByAudience(experiments, 'customers-v1', topology);
  assert.deepEqual(ids(selected), ['both', 'inherited']);
  assert.deepEqual(selected, audienceUsage('customers-v1', topology, experiments).experiments);
  assert.deepEqual(ids(filterExperimentsByAudience(experiments, 'customers-v2', topology)), ['inherited', 'v2-only', 'explicit-wins']);
});

test('legacy seed names map to their original version only and an explicit ID takes precedence', () => {
  const { topology, experiments } = fixture();
  topology.audiences.push({ ...topology.audiences.find(audience => audience.id === 'new-users-v1'), id: 'new-users-v2', version: 2 });
  assert.deepEqual(ids(filterExperimentsByAudience(experiments, 'new-users-v1', topology)), ['legacy']);
  assert.deepEqual(filterExperimentsByAudience(experiments, 'new-users-v2', topology), []);
  delete topology.audiences;
  assert.deepEqual(ids(filterExperimentsByAudience(experiments, 'new-users-v1', topology)), ['legacy']);
});

test('unknown and empty filter IDs fail closed even if a dangling configuration references them', () => {
  const { topology, experiments } = fixture();
  topology.domains[0].audienceId = 'missing-v1';
  experiments.push({ id: 'dangling', domainId: 'other', audienceId: 'missing-v1' });
  assert.deepEqual(filterExperimentsByAudience(experiments, 'missing-v1', topology), []);
  assert.deepEqual(filterExperimentsByAudience(experiments, '', topology), []);
  assert.deepEqual(filterExperimentsByAudience(experiments, ' customers-v1 ', topology), []);
});

test('filtering preserves input order and leaves topology and experiment bytes untouched', () => {
  const { topology, experiments } = fixture();
  const before = JSON.stringify({ topology, experiments });
  const all = filterExperimentsByAudience(experiments, null, topology);
  assert.deepEqual(all, experiments);
  assert.notEqual(all, experiments);
  all.reverse();
  filterExperimentsByAudience(experiments, 'customers-v1', topology).pop();
  assert.equal(JSON.stringify({ topology, experiments }), before);
});

test('list links and parser round trip encoded version identity without storage or navigation', () => {
  const audienceId = '中国客户/v2 +&?=%';
  const href = experimentAudienceListHref(audienceId);
  assert.equal(href, '#experiments?audience=%E4%B8%AD%E5%9B%BD%E5%AE%A2%E6%88%B7%2Fv2%20%2B%26%3F%3D%25');
  assert.deepEqual(parseExperimentAudienceFilter(href), { audienceId, error: null });
  assert.deepEqual(parseExperimentAudienceFilter(href.slice(1)), { audienceId, error: null });
  assert.deepEqual(parseExperimentAudienceFilter('#experiments?audience=customers%2Dv1'), { audienceId: 'customers-v1', error: null });
});

test('clearing the list filter has one canonical route and does not consume detail-page reference queries', () => {
  for (const value of [undefined, null, '']) assert.equal(experimentAudienceListHref(value), '#experiments');
  for (const hash of ['#experiments', '#experiments?', '#audiences?audience=customers-v1', '#experiments/EXP-1?audience=customers-v1&focus=audience']) {
    assert.deepEqual(parseExperimentAudienceFilter(hash), { audienceId: null, error: null });
  }
});

test('duplicate, blank, unknown and malformed list query parameters report an invalid filter', () => {
  for (const hash of [
    '#experiments?audience=customers-v1&audience=customers-v2',
    '#experiments?audience=customers-v1&%61udience=customers-v1',
    '#experiments?audience=', '#experiments?audience', '#experiments?audience=%20',
    '#experiments?audience=%20customers-v1', '#experiments?audience=customers-v1+',
    '#experiments?audience=%ZZ', '#experiments?audience=%E0%A4%A',
    '#experiments?audience=customers-v1&focus=audience', '#experiments?other=customers-v1',
  ]) {
    const parsed = parseExperimentAudienceFilter(hash);
    assert.equal(parsed.audienceId, null, hash);
    assert.ok(parsed.error, hash);
  }
});

test('syntactically valid unknown IDs stay selected for a missing-version empty state', () => {
  const { topology, experiments } = fixture();
  const parsed = parseExperimentAudienceFilter('#experiments?audience=missing-v42');
  assert.deepEqual(parsed, { audienceId: 'missing-v42', error: null });
  assert.deepEqual(filterExperimentsByAudience(experiments, parsed.audienceId, topology), []);
});
