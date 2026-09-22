// Documentation fixture verifier; not a production SDK.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function encode(fields) {
  assert.equal(fields.length, 9);
  const parts = [u32(fields.length)];
  for (const field of fields) {
    assert.equal(typeof field, 'string');
    assert.ok(field.length > 0);
    for (const scalar of field) {
      const value = scalar.codePointAt(0);
      assert.ok(value < 0xd800 || value > 0xdfff, 'Unpaired Unicode surrogate');
    }
    const bytes = Buffer.from(field, 'utf8');
    assert.ok(bytes.length <= 4096);
    parts.push(u32(bytes.length), bytes);
  }
  assert.equal(fields[0], 'ab-bucket-sha256-v2');
  assert.ok(['layer', 'variant'].includes(fields[1]));
  assert.match(fields[8], /^[0-9a-f]{32}$/);
  return Buffer.concat(parts);
}

const fixture = JSON.parse(readFileSync(new URL('./hash-vectors.json', import.meta.url), 'utf8'));
assert.equal(fixture.protocol, 'ab-bucket-sha256-v2');
assert.deepEqual(fixture.field_order, [
  'protocol', 'purpose', 'namespace_id', 'environment_id', 'node_id',
  'epoch', 'unit_type', 'unit_key', 'salt',
]);
for (const vector of fixture.vectors) {
  const payload = encode(vector.fields);
  assert.equal(payload.toString('hex'), vector.payload_hex, vector.name);
  const digest = createHash('sha256').update(payload).digest();
  assert.equal(digest.toString('hex'), vector.sha256_hex, vector.name);
  const integer = digest.readBigUInt64BE();
  assert.equal(integer.toString(), vector.unsigned_64, vector.name);
  assert.equal(Number(integer % 10000n), vector.bucket, vector.name);
}
const bad = fixture.vectors[0].fields.slice();
bad[7] = '\ud800';
assert.throws(() => encode(bad), /Unpaired Unicode surrogate/);
const oldProtocol = fixture.vectors[0].fields.slice();
oldProtocol[0] = 'ab-bucket-sha256-v1';
assert.throws(() => encode(oldProtocol));
console.log(`Verified ${fixture.vectors.length} Python-generated v2 vectors with Node; invalid Unicode and unsupported protocol rejected.`);
