import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTopology, simulateAllocation } from '../src/traffic.ts';
import { initialExperiments } from '../src/data.ts';
import { getCatalog, planParameterService } from '../src/service-catalog.ts';
import { canonicalApplicationRoute, parameterHref, serviceHref } from '../src/application-routes.ts';

const base = () => structuredClone(defaultTopology);
function legacyCustom() {
  const topology = base();
  topology.parameters = [{ key: 'ranking.legacy_weight', name: '历史权重', type: 'number', defaultValue: 0, owner: '旧负责人', description: '', createdAt: '2026-09-12T00:00:00.000Z' }];
  topology.layers.find(layer => layer.id === 'ranking').parameterKeys.push('ranking.legacy_weight');
  return topology;
}

test('parameter links open the owning service parameters tab across frontend, backend, and strategy services', () => {
  const topology = base();
  assert.equal(parameterHref('ui.layout', topology), '#applications/services/ui-web/parameters/ui.layout');
  assert.equal(parameterHref('ranking.model', topology), '#applications/services/ranking-service/parameters/ranking.model');
  assert.equal(parameterHref('checkout.parallel', topology), '#applications/services/checkout-service/parameters/checkout.parallel');
  assert.equal(serviceHref('ui-web'), '#applications/services/ui-web');
  assert.equal(serviceHref('ui-web', 'integration'), '#applications/services/ui-web/integration');
});

test('old global parameter and service lists resolve to the application directory', () => {
  for (const hash of ['#parameters', '#parameters/', '#applications/parameters', '#applications/parameters/', '#services', '#services/', '#applications/unassigned']) assert.equal(canonicalApplicationRoute(hash, base()), '#applications', hash);
});

test('all legacy parameter deep links resolve to one canonical service-owned route', () => {
  const topology = base(), expected = parameterHref('ranking.model', topology);
  for (const hash of ['#parameters/ranking.model', '#applications/parameters/ranking.model', '#applications/parameters/ranking%2Emodel', '#applications/services/ranking-service/parameters/ranking.model']) assert.equal(canonicalApplicationRoute(hash, topology), expected, hash);
});

test('a parameter nested under the wrong service resolves by actual ownership without reassigning it', () => {
  const topology = base(), before = structuredClone(topology);
  for (const hash of ['#applications/services/ui-web/parameters/ranking.model', '#applications/services/unknown-service/parameters/ranking.model', '#services/ui-web/parameters/ranking.model']) assert.equal(canonicalApplicationRoute(hash, topology), '#applications/services/ranking-service/parameters/ranking.model');
  assert.deepEqual(topology, before);
});

test('historical parameters remain unassigned regardless of their namespace; unknown keys retain their identity', () => {
  const topology = legacyCustom();
  assert.equal(parameterHref('ranking.legacy_weight', topology), '#applications/unassigned/ranking.legacy_weight');
  assert.equal(parameterHref('unknown.parameter', topology), '#applications/unassigned/unknown.parameter');
  for (const hash of ['#parameters/unknown.parameter', '#applications/parameters/unknown.parameter', '#applications/services/ui-web/parameters/unknown.parameter']) assert.equal(canonicalApplicationRoute(hash, topology), '#applications/unassigned/unknown.parameter');
  assert.equal(canonicalApplicationRoute('#applications/services/ranking-service/parameters/ranking.legacy_weight', topology), '#applications/unassigned/ranking.legacy_weight');
});

test('claiming a historical parameter changes its unassigned link to the explicitly chosen owner', () => {
  const topology = legacyCustom(), route = '#applications/unassigned/ranking.legacy_weight';
  assert.equal(canonicalApplicationRoute(route, topology), route);
  const claimed = planParameterService('ranking.legacy_weight', 'checkout-service', topology);
  assert.equal(claimed.error, null);
  assert.equal(canonicalApplicationRoute(route, claimed.topology), '#applications/services/checkout-service/parameters/ranking.legacy_weight');
  assert.deepEqual(claimed.topology.parameters, topology.parameters);
  assert.deepEqual(claimed.topology.layers, topology.layers);
});

test('service tabs and unrelated application paths retain their route and encoded identifiers safely', () => {
  const topology = base();
  assert.equal(canonicalApplicationRoute('#services/ui-web', topology), '#applications/services/ui-web');
  assert.equal(canonicalApplicationRoute('#services/ui-web/integration', topology), '#applications/services/ui-web/integration');
  assert.equal(canonicalApplicationRoute('#applications/services/ui-web/parameters', topology), '#applications/services/ui-web/parameters');
  for (const hash of ['', '#overview', '#experiments/EXP-1027', '#traffic/layer/ranking', '#applications', '#applications/services/missing-service', '#applications/services/ui-web/integration', '#parameters-other']) assert.equal(canonicalApplicationRoute(hash, topology), hash);
  assert.equal(serviceHref('literal/id', 'a/b'), '#applications/services/literal%2Fid/a%2Fb');
});

test('canonicalization is idempotent for aliases, unknown parameters, malformed escapes, and wrong-service links', () => {
  const topology = base();
  for (const hash of ['#parameters/ui.layout', '#applications/parameters', '#applications/services/wrong/parameters/ranking.model', '#parameters/%broken', '#parameters/unknown%2Fkey', '#applications/unassigned/ui.layout', '#services/ui-web']) {
    const canonical = canonicalApplicationRoute(hash, topology);
    assert.equal(canonicalApplicationRoute(canonical, topology), canonical, hash);
  }
});

test('link resolution never mutates catalog, historical experiments, or simulated assignments', () => {
  const topology = base(), before = structuredClone(topology), catalog = getCatalog(topology), experiments = structuredClone(initialExperiments);
  const assignments = simulateAllocation('route-stability', initialExperiments, topology);
  for (const key of catalog.bindings.map(binding => binding.key)) {
    parameterHref(key, topology);
    canonicalApplicationRoute(`#parameters/${key}`, topology);
    canonicalApplicationRoute(`#applications/services/wrong/parameters/${key}`, topology);
  }
  assert.deepEqual(topology, before);
  assert.deepEqual(initialExperiments, experiments);
  assert.deepEqual(simulateAllocation('route-stability', initialExperiments, topology), assignments);
});
