import test from 'node:test';
import assert from 'node:assert/strict';
import { equalVariantWeights, addParametersToVariants } from '../src/variant-draft-operations.ts';

test('explicit equal allocation sums exactly to 10000 weight units for 2 through 20 groups', () => {
  for (let count = 2; count <= 20; count++) {
    const weights = equalVariantWeights(count);
    assert.equal(weights.length, count);
    assert.equal(weights.reduce((sum, weight) => sum + Math.round(weight * 100), 0), 10000);
    assert.ok(Math.max(...weights) - Math.min(...weights) < 0.0100001);
  }
  assert.deepEqual(equalVariantWeights(3), [33.34, 33.33, 33.33]);
  assert.throws(() => equalVariantWeights(1));
  assert.throws(() => equalVariantWeights(21));
});

test('bulk parameters reach all groups without overwriting nested strategy values or mutating source', () => {
  const variants = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, value: JSON.stringify({ 'ranking.config': { routes: [{ id: 'r', limit: i + 1 }] } }) }));
  const before = structuredClone(variants);
  const next = addParametersToVariants(variants, { 'ranking.config': {}, 'ranking.enabled': true });
  for (let i = 0; i < 4; i++) {
    assert.equal(JSON.parse(next[i].value)['ranking.enabled'], true);
    assert.equal(JSON.parse(next[i].value)['ranking.config'].routes[0].limit, i + 1);
  }
  assert.deepEqual(variants, before);
});

test('one malformed group prevents a bulk addition without partially changing earlier groups', () => {
  const variants = [{ value: '{}' }, { value: '{broken' }, { value: '{}' }];
  const before = structuredClone(variants);
  assert.throws(() => addParametersToVariants(variants, { 'ui.layout': 'default' }));
  assert.deepEqual(variants, before);
});

test('non-finite JSON is rejected without converting a strategy value into null', () => {
  const variants = [{ value: '{}' }, { value: '{"ranking.limit":1e309}' }];
  const before = structuredClone(variants);
  assert.throws(() => addParametersToVariants(variants, { 'ranking.enabled': true }));
  assert.deepEqual(variants, before);
});

test('bulk addition rejects raw duplicate keys including escaped nested names without collapsing values', () => {
  for (const raw of ['{"ranking.model":"v1","ranking.model":"v2"}', '{"ranking.config":{"route":1,"\\u0072oute":2}}']) {
    const variants = [{ value: '{}' }, { value: raw }, { value: '{}' }];
    const before = structuredClone(variants);
    assert.throws(() => addParametersToVariants(variants, { 'ranking.enabled': true }), /重复/);
    assert.deepEqual(variants, before);
  }
});

test('bulk addition rejects excessive nesting and retains finite JSON error semantics', () => {
  const variants = [{ value: '{"nest":'.repeat(33) + '0' + '}'.repeat(33) }];
  const before = structuredClone(variants);
  assert.throws(() => addParametersToVariants(variants, { 'ranking.enabled': true }), /有限 JSON/);
  assert.deepEqual(variants, before);
});

test('bulk addition does not introduce invalid default numbers or mutate prototype properties', () => {
  const variants = [{ value: '{"__proto__":{"owned":true},"ranking.model":"v2"}' }];
  assert.throws(() => addParametersToVariants(variants, { 'ranking.limit': Infinity }), /有限 JSON/);
  const result = addParametersToVariants(variants, { 'ranking.enabled': true });
  const payload = JSON.parse(result[0].value);
  assert.equal(Object.hasOwn(payload, '__proto__'), true);
  assert.deepEqual(payload.__proto__, { owned: true });
  assert.equal(Object.getPrototypeOf(payload), Object.prototype);
  assert.equal({}.owned, undefined);
});
