import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeParameterJson, diffParameterJson } from '../src/json-parameter-analysis.ts';

test('hundreds of strategy lines produce an ordered, hierarchical, navigable outline', () => {
  const source = JSON.stringify({ 'ranking.strategy': { scenes: Object.fromEntries(Array.from({ length: 90 }, (_, index) => [`scene_${index}`, { enabled: true, limit: index + 1 }])) }, 'ui.enabled': true }, null, 2);
  assert.ok(source.split('\n').length > 300);
  const result = analyzeParameterJson(source);
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.nodes[0].path, '/ranking.strategy');
  assert.equal(result.nodes[0].depth, 0);
  const leaf = result.nodes.find(node => node.path === '/ranking.strategy/scenes/scene_80/limit');
  assert.deepEqual(leaf.segments, ['ranking.strategy', 'scenes', 'scene_80', 'limit']);
  assert.equal(leaf.type, 'number');
  assert.equal(leaf.depth, 3);
  assert.equal(leaf.topLevelKey, 'ranking.strategy');
  assert.equal(source.slice(leaf.from, leaf.to), '"limit": 81');
  assert.equal(leaf.line, source.slice(0, leaf.from).split('\n').length);
  assert.equal(result.nodes.some(node => node.path === ''), false);
});

test('JSON Pointer escaping preserves dotted keys, slashes, tildes, empty keys and numeric array indices', () => {
  const source = '{"app.config":{"a/b":{"~name":[{"":null}]},"0":false}}';
  const result = analyzeParameterJson(source);
  const node = result.nodes.find(node => node.path === '/app.config/a~1b/~0name/0/');
  assert.deepEqual(node.segments, ['app.config', 'a/b', '~name', 0, '']);
  assert.equal(source.slice(node.from, node.to), '"":null');
  const arrayItem = result.nodes.find(node => node.path === '/app.config/a~1b/~0name/0');
  assert.equal(source.slice(arrayItem.from, arrayItem.to), '{"":null}');
  assert.deepEqual(result.nodes.find(node => node.path === '/app.config/0').segments, ['app.config', '0']);
});

test('line numbers support CRLF and CR without shifting offsets', () => {
  const source = '{\r\n  "one": 1,\r  "two": 2\n}';
  const result = analyzeParameterJson(source);
  assert.equal(result.valid, true);
  assert.deepEqual(result.nodes.map(node => node.line), [2, 3]);
  assert.equal(source.slice(result.nodes[1].from, result.nodes[1].to), '"two": 2');
});

test('all JSON scalar and array roots are rejected', () => {
  for (const source of ['[]', 'null', 'true', '1', '"text"', '']) {
    const result = analyzeParameterJson(source);
    assert.equal(result.valid, false, source);
    assert.equal(Object.hasOwn(result, 'value'), false, source);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.message.includes('JSON 对象')), source);
  }
  assert.equal(analyzeParameterJson('{}').valid, true);
});

test('strict JSON rejects comments, trailing commas and incomplete source without rewriting it', () => {
  for (const source of ['{"x":1,}', '{"x":[1,]}', '{/* comment */"x":1}', '{"x":1}// comment', '{"x":', '{"x": 1 "y":2}', '{"x": "bad\\q"}']) {
    const raw = source;
    const result = analyzeParameterJson(source);
    assert.equal(result.valid, false, source);
    assert.equal(Object.hasOwn(result, 'value'), false, source);
    assert.equal(source, raw);
    assert.ok(result.diagnostics.every(diagnostic => diagnostic.from >= 0 && diagnostic.to <= source.length));
  }
  const incomplete = analyzeParameterJson('{"valid":1,"unfinished":');
  assert.deepEqual(incomplete.nodes.map(node => node.key), ['valid', 'unfinished']);
  assert.equal(incomplete.nodes[1].preview, '未完成');
});

test('duplicate decoded property names are errors at the second property even when escaped or nested', () => {
  const source = '{\n "x": 1,\n "\\u0078": 2,\n "strategy": {"route":1,"route":2}\n}';
  const result = analyzeParameterJson(source);
  assert.equal(result.valid, false);
  assert.equal(Object.hasOwn(result, 'value'), false);
  const duplicates = result.diagnostics.filter(diagnostic => diagnostic.message.includes('重复'));
  assert.equal(duplicates.length, 2);
  assert.equal(source.slice(duplicates[0].from, duplicates[0].to), '"\\u0078"');
  assert.equal(source.slice(duplicates[1].from, duplicates[1].to), '"route"');
  assert.equal(diffParameterJson('{}', source).valid, false);
  assert.equal(diffParameterJson(source, '{}').changes.length, 0);
});

test('equal keys in separate objects are valid and prototype-named keys do not affect validation', () => {
  const source = '{"a":{"key":1},"b":{"key":2},"__proto__":{"polluted":true},"constructor":1,"toString":2}';
  const result = analyzeParameterJson(source);
  assert.equal(result.valid, true);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(Object.hasOwn(result.value, '__proto__'), true);
  assert.equal(result.value.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
  const diff = diffParameterJson('{}', source);
  assert.equal(diff.valid, true);
  assert.ok(diff.changes.some(change => change.path === '/__proto__' && change.kind === 'added'));
});

test('non-finite numbers are rejected at their original token including deep array values', () => {
  const source = '{"ranking.config":{"limits":[1,1e309,-1e309]}}';
  const result = analyzeParameterJson(source);
  assert.equal(result.valid, false);
  const numbers = result.diagnostics.filter(diagnostic => diagnostic.message.includes('有限值'));
  assert.deepEqual(numbers.map(diagnostic => source.slice(diagnostic.from, diagnostic.to)), ['1e309', '-1e309']);
  assert.equal(Object.hasOwn(result, 'value'), false);
  assert.equal(diffParameterJson('{}', source).valid, false);
});

test('whitespace and object key order changes produce no structural changes, even inside arrays', () => {
  const before = '{"cfg":{"a":1,"b":false},"routes":[{"id":"x","n":2}]}';
  const after = '{\n "routes": [{"n":2, "id":"x"}], "cfg": {"b":false,"a":1.0}\n}';
  assert.deepEqual(diffParameterJson(before, after), { valid: true, changes: [] });
});

test('nested primitive and type changes identify exact escaped paths and after source coordinates', () => {
  const before = '{"ranking.config":{"a/b":{"weight":1},"enabled":true}}';
  const after = '{\n"ranking.config":{"a/b":{"weight":2},"enabled":{"mode":"on"}}\n}';
  const result = diffParameterJson(before, after);
  assert.equal(result.valid, true);
  assert.deepEqual(result.changes.map(change => [change.path, change.kind]), [['/ranking.config/a~1b/weight', 'changed'], ['/ranking.config/enabled', 'changed']]);
  assert.equal(after.slice(result.changes[0].from, result.changes[0].to), '"weight":2');
  assert.deepEqual(result.changes[1].before, true);
  assert.deepEqual(result.changes[1].after, { mode: 'on' });
});

test('arrays are a single change for reordering, insertion, and editing an item', () => {
  const before = '{"ranking.routes":[{"id":"a","limit":1},{"id":"b","limit":2}]}';
  for (const routes of [[{ id: 'b', limit: 2 }, { id: 'a', limit: 1 }], [{ id: 'a', limit: 3 }, { id: 'b', limit: 2 }], [{ id: 'a', limit: 1 }]]) {
    const result = diffParameterJson(before, JSON.stringify({ 'ranking.routes': routes }));
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, '/ranking.routes');
    assert.equal(result.changes[0].kind, 'changed');
    assert.deepEqual(result.changes[0].segments, ['ranking.routes']);
  }
});

test('absent keys differ from null and removed values never expose stale after coordinates', () => {
  const result = diffParameterJson('{"removed":null,"same":null,"object":{}}', '{"added":null,"same":null,"object":{"n":null}}');
  assert.deepEqual(result.changes.map(change => [change.path, change.kind]), [['/removed', 'removed'], ['/object/n', 'added'], ['/added', 'added']]);
  assert.equal(result.changes[0].before, null);
  assert.equal(Object.hasOwn(result.changes[0], 'after'), false);
  assert.equal(Object.hasOwn(result.changes[0], 'from'), false);
  assert.equal(result.changes[1].after, null);
  assert.equal(Object.hasOwn(result.changes[1], 'before'), false);
});

test('maximum depth is explicit and extreme nesting is rejected without recursion overflow', () => {
  const atDepth = depth => '{"x":'.repeat(depth) + '0' + '}'.repeat(depth);
  assert.equal(analyzeParameterJson(atDepth(32)).valid, true);
  assert.equal(analyzeParameterJson(atDepth(33)).valid, false);
  const extreme = analyzeParameterJson(atDepth(10000));
  assert.equal(extreme.valid, false);
  assert.ok(extreme.diagnostics.some(diagnostic => diagnostic.message.includes('32 层')));
});

test('outline truncation does not skip validation or structural changes beyond its node limit', () => {
  const input = Object.fromEntries(Array.from({ length: 5005 }, (_, index) => [`key${index}`, index]));
  const before = JSON.stringify(input);
  const result = analyzeParameterJson(before);
  assert.equal(result.valid, true);
  assert.equal(result.truncated, true);
  assert.equal(result.nodes.length, 5000);
  assert.equal(result.value.key5004, 5004);
  const after = before.replace('"key5004":5004', '"key5004":5006');
  const diff = diffParameterJson(before, after);
  assert.equal(diff.valid, true);
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0].path, '/key5004');
  assert.equal(Object.hasOwn(diff.changes[0], 'from'), false);
  const invalid = analyzeParameterJson(before.slice(0, -1) + ',"key5004":1}');
  assert.equal(invalid.valid, false);
  assert.ok(invalid.diagnostics.some(diagnostic => diagnostic.message.includes('重复')));
});
