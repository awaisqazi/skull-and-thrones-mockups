import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySquareSignature, signSquarePayload, timingSafeEqual } from '../src/verify.js';

const KEY = 'test-signature-key-not-a-real-secret';
const URL_ = 'https://relay.example.workers.dev/square';
const BODY = '{"merchant_id":"MLXYZ","type":"booking.created","event_id":"e-1","created_at":"2026-10-28T20:00:00Z","data":{"type":"booking","id":"b1"}}';
// Independent computation with node:crypto, the same recipe Square documents.
const sig = (key, url, body) => createHmac('sha256', key).update(url + body).digest('base64');

test('accepts the signature node:crypto computes for the same key, url and body', async () => {
  assert.equal(await verifySquareSignature(KEY, URL_, BODY, sig(KEY, URL_, BODY)), true);
});

test('signSquarePayload matches node:crypto exactly', async () => {
  assert.equal(await signSquarePayload(KEY, URL_, BODY), sig(KEY, URL_, BODY));
});

test('handles non-ASCII bodies (UTF-8 bytes, not UTF-16)', async () => {
  const body = '{"note":"Rodríguez ✂️"}';
  assert.equal(await verifySquareSignature(KEY, URL_, body, sig(KEY, URL_, body)), true);
});

test('rejects a wrong key, a tampered body, a different url, and a stale signature', async () => {
  const good = sig(KEY, URL_, BODY);
  assert.equal(await verifySquareSignature('other-key', URL_, BODY, good), false);
  assert.equal(await verifySquareSignature(KEY, URL_, BODY.replace('b1', 'b2'), good), false);
  assert.equal(await verifySquareSignature(KEY, URL_ + '/', BODY, good), false);
  assert.equal(await verifySquareSignature(KEY, URL_, BODY, sig(KEY, URL_, 'something else')), false);
});

test('rejects missing, empty, malformed and wrong-length headers without throwing', async () => {
  for (const h of [undefined, null, '', '   ', '!!!not-base64!!!', 'AAAA', sig(KEY, URL_, BODY).slice(0, -4)]) {
    assert.equal(await verifySquareSignature(KEY, URL_, BODY, h), false, String(h));
  }
});

test('rejects missing key, url or body', async () => {
  const good = sig(KEY, URL_, BODY);
  assert.equal(await verifySquareSignature('', URL_, BODY, good), false);
  assert.equal(await verifySquareSignature(KEY, '', BODY, good), false);
  assert.equal(await verifySquareSignature(KEY, URL_, undefined, good), false);
});

test('timingSafeEqual: equal, different, different length', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])), false);
  assert.equal(timingSafeEqual(new Uint8Array([0]), new Uint8Array([])), false);
});
