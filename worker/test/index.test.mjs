import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleRequest, _resetDedupe, MAX_BODY_BYTES } from '../src/relay.js';
import worker from '../src/index.js';

const URL_ = 'https://relay.example.workers.dev/square';
const K1 = 'key-addison-test', K2 = 'key-elmhurst-test';
const ENV = { GITHUB_REPO: 'owner/repo', GITHUB_TOKEN: 'ghp_test_not_real', SQUARE_SIGNATURE_KEYS: `${K1}, ${K2}`, NOTIFICATION_URL: URL_ };
const sig = (key, body) => createHmac('sha256', key).update(URL_ + body).digest('base64');
const event = (type, id = 'ev-1') => JSON.stringify({ merchant_id: 'MERCH', type, event_id: id, created_at: '2026-10-28T20:00:00Z', data: { type: 'x', id: 'y', object: { secret: 'never forwarded' } } });
const post = (body, { key = K1, signature, path = '/square', method = 'POST', headers = {} } = {}) =>
  new Request(`https://relay.example.workers.dev${path}`, {
    method,
    body: method === 'POST' ? body : undefined,
    headers: { 'content-type': 'application/json', ...(signature === null ? {} : { 'x-square-hmacsha256-signature': signature ?? sig(key, body) }), ...headers },
  });

/** A fetch fake that records GitHub calls and answers with `status` (or throws). */
const fakeFetch = (status = 204) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (status === 'throw') throw new Error('boom');
    return new Response(null, { status });
  };
  f.calls = calls;
  return f;
};
/** Minimal Cache API stand-in. */
const fakeCache = () => {
  const m = new Map();
  return { match: async (r) => (m.has(r.url) ? new Response('1') : undefined), put: async (r) => { m.set(r.url, true); }, size: () => m.size };
};

beforeEach(() => _resetDedupe());

test('GET /health is 200 ok; unknown paths and methods are 404', async () => {
  const f = fakeFetch();
  const ok = await handleRequest(new Request('https://x.dev/health'), ENV, { fetch: f, cache: null });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ok');
  for (const [path, method] of [['/', 'GET'], ['/square', 'GET'], ['/health', 'POST'], ['/other', 'POST'], ['/square/x', 'POST']]) {
    const r = await handleRequest(post('{}', { path, method }), ENV, { fetch: f, cache: null });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  assert.equal(f.calls.length, 0);
});

test('unsigned, badly signed and wrongly keyed requests are 401 and never reach GitHub', async () => {
  const f = fakeFetch();
  const body = event('booking.created');
  for (const opts of [{ signature: null }, { signature: 'bm9wZQ==' }, { key: 'not-one-of-ours' }]) {
    const r = await handleRequest(post(body, opts), ENV, { fetch: f, cache: null });
    assert.equal(r.status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test('a body altered after signing is 401', async () => {
  const f = fakeFetch();
  const body = event('booking.created');
  const r = await handleRequest(post(body.replace('MERCH', 'EVIL'), { signature: sig(K1, body) }), ENV, { fetch: f, cache: null });
  assert.equal(r.status, 401);
});

test('either configured key is accepted (one subscription per Square account)', async () => {
  for (const key of [K1, K2]) {
    _resetDedupe();
    const f = fakeFetch();
    const r = await handleRequest(post(event('booking.created', 'id-' + key), { key }), ENV, { fetch: f, cache: null });
    assert.equal(r.status, 200, key);
    assert.equal(f.calls.length, 1);
  }
});

test('missing configuration answers 500 without dispatching', async () => {
  const f = fakeFetch();
  const body = event('booking.created');
  for (const env of [{ ...ENV, SQUARE_SIGNATURE_KEYS: '' }, { ...ENV, SQUARE_SIGNATURE_KEYS: ' , ' }, { ...ENV, NOTIFICATION_URL: undefined }, {}]) {
    const r = await handleRequest(post(body), env, { fetch: f, cache: null });
    assert.equal(r.status, 500);
  }
  assert.equal(f.calls.length, 0);
});

test('booking.created dispatches square-booking with the exact GitHub request', async () => {
  const f = fakeFetch(204);
  const r = await handleRequest(post(event('booking.created', 'ev-42')), ENV, { fetch: f, cache: null });
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.github.com/repos/owner/repo/dispatches');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer ghp_test_not_real');
  assert.equal(init.headers.Accept, 'application/vnd.github+json');
  assert.equal(init.headers['User-Agent'], 'skull-thrones-square-relay');
  assert.deepEqual(JSON.parse(init.body), {
    event_type: 'square-booking',
    client_payload: { type: 'booking.created', merchant_id: 'MERCH', event_id: 'ev-42', created_at: '2026-10-28T20:00:00Z' },
  });
  // The Square data object (customer details) is never forwarded.
  assert.ok(!init.body.includes('never forwarded'));
});

test('catalog, team member and location events dispatch square-catalog', async () => {
  for (const type of ['catalog.version.updated', 'team_member.created', 'team_member.updated', 'location.updated']) {
    const f = fakeFetch();
    const r = await handleRequest(post(event(type, 'id-' + type)), ENV, { fetch: f, cache: null });
    assert.equal(r.status, 200, type);
    assert.equal(JSON.parse(f.calls[0].init.body).event_type, 'square-catalog', type);
  }
});

test('other event types answer 200 and do nothing', async () => {
  const f = fakeFetch();
  const r = await handleRequest(post(event('payment.created')), ENV, { fetch: f, cache: null });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ignored');
  assert.equal(f.calls.length, 0);
});

test('signed but invalid JSON is 400', async () => {
  const f = fakeFetch();
  const r = await handleRequest(post('not json'), ENV, { fetch: f, cache: null });
  assert.equal(r.status, 400);
  assert.equal(f.calls.length, 0);
});

test('oversized bodies are 413 before any work', async () => {
  const f = fakeFetch();
  const big = 'x'.repeat(MAX_BODY_BYTES + 1);
  const r = await handleRequest(post(big), ENV, { fetch: f, cache: null });
  assert.equal(r.status, 413);
  assert.equal(f.calls.length, 0);
});

test('the same event_id is dispatched once (in-memory layer, no Cache API)', async () => {
  const f = fakeFetch();
  const a = await handleRequest(post(event('booking.updated', 'dup-1')), ENV, { fetch: f, cache: null });
  const b = await handleRequest(post(event('booking.updated', 'dup-1')), ENV, { fetch: f, cache: null });
  assert.equal(a.status, 200);
  assert.equal(await b.text(), 'duplicate');
  assert.equal(f.calls.length, 1);
  const c = await handleRequest(post(event('booking.updated', 'dup-2')), ENV, { fetch: f, cache: null });
  assert.equal(c.status, 200);
  assert.equal(f.calls.length, 2);
});

test('dedupe also works through the Cache API when the isolate memory is cold', async () => {
  const cache = fakeCache();
  const f = fakeFetch();
  await handleRequest(post(event('booking.created', 'c-1')), ENV, { fetch: f, cache });
  assert.equal(cache.size(), 1);
  _resetDedupe(); // a different isolate
  const b = await handleRequest(post(event('booking.created', 'c-1')), ENV, { fetch: f, cache });
  assert.equal(await b.text(), 'duplicate');
  assert.equal(f.calls.length, 1);
});

test('dedupe expires after 10 minutes', async () => {
  const f = fakeFetch();
  let t = 1_000_000;
  const deps = { fetch: f, cache: null, now: () => t };
  await handleRequest(post(event('booking.created', 'x-1')), ENV, deps);
  t += 9 * 60_000;
  assert.equal(await (await handleRequest(post(event('booking.created', 'x-1')), ENV, deps)).text(), 'duplicate');
  t += 2 * 60_000;
  await handleRequest(post(event('booking.created', 'x-1')), ENV, deps);
  assert.equal(f.calls.length, 2);
});

test('an unsigned request cannot poison the dedupe table', async () => {
  const f = fakeFetch();
  await handleRequest(post(event('booking.created', 'p-1'), { key: 'attacker' }), ENV, { fetch: f, cache: null });
  const r = await handleRequest(post(event('booking.created', 'p-1')), ENV, { fetch: f, cache: null });
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 1);
});

test('events without an event_id still dispatch (cannot be deduped)', async () => {
  const f = fakeFetch();
  const body = JSON.stringify({ type: 'booking.created', merchant_id: 'M' });
  await handleRequest(post(body), ENV, { fetch: f, cache: null });
  await handleRequest(post(body), ENV, { fetch: f, cache: null });
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.calls[0].init.body).client_payload.event_id, null);
});

test('GitHub down + booking event: 502 so Square retries, and the retry is not treated as a duplicate', async () => {
  for (const status of [500, 503, 429, 'throw']) {
    _resetDedupe();
    const down = fakeFetch(status);
    const r = await handleRequest(post(event('booking.created', 'r-1')), ENV, { fetch: down, cache: null });
    assert.equal(r.status, 502, String(status));
    const up = fakeFetch(204);
    const retry = await handleRequest(post(event('booking.created', 'r-1')), ENV, { fetch: up, cache: null });
    assert.equal(retry.status, 200);
    assert.equal(await retry.text(), 'dispatched');
    assert.equal(up.calls.length, 1);
  }
});

test('GitHub down + catalog event: still 200 (the nightly build is the backstop)', async () => {
  for (const status of [500, 'throw']) {
    _resetDedupe();
    const r = await handleRequest(post(event('catalog.version.updated', 'k-1')), ENV, { fetch: fakeFetch(status), cache: null });
    assert.equal(r.status, 200);
  }
});

test('GitHub refuses (401/403/404/422): 200, because retrying cannot help, even for bookings', async () => {
  for (const status of [401, 403, 404, 422]) {
    _resetDedupe();
    const r = await handleRequest(post(event('booking.created', 'g-1')), ENV, { fetch: fakeFetch(status), cache: null });
    assert.equal(r.status, 200, String(status));
    assert.equal(await r.text(), 'accepted');
  }
});

test('missing GITHUB_TOKEN or GITHUB_REPO: 200 and no GitHub call', async () => {
  for (const env of [{ ...ENV, GITHUB_TOKEN: undefined }, { ...ENV, GITHUB_REPO: undefined }]) {
    _resetDedupe();
    const f = fakeFetch();
    const r = await handleRequest(post(event('booking.created', 'n-1')), env, { fetch: f, cache: null });
    assert.equal(r.status, 200);
    assert.equal(f.calls.length, 0);
  }
});

test('a broken Cache API never breaks the request', async () => {
  const cache = { match: async () => { throw new Error('no cache'); }, put: async () => { throw new Error('no cache'); } };
  const f = fakeFetch();
  const r = await handleRequest(post(event('booking.created', 'b-1')), ENV, { fetch: f, cache });
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 1);
});

test('request bodies and secrets are never logged', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await handleRequest(post(event('booking.created', 'l-1')), ENV, { fetch: fakeFetch(), cache: null });
    await handleRequest(post(event('booking.created', 'l-2'), { key: 'bad' }), ENV, { fetch: fakeFetch(), cache: null });
  } finally {
    console.log = orig;
  }
  const all = lines.join('\n');
  assert.ok(lines.length >= 2);
  for (const secret of ['never forwarded', K1, K2, 'ghp_test_not_real']) assert.ok(!all.includes(secret), secret);
});

test('default export: unhandled exceptions become a plain 500', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const req = new Request('https://x.dev/square', { method: 'POST', body: '{}' });
    Object.defineProperty(req, 'text', { value: () => Promise.reject(new Error('stream broke')) });
    const r = await worker.fetch(req, ENV, {});
    assert.equal(r.status, 500);
    assert.equal((await worker.fetch(new Request('https://x.dev/health'), ENV, {})).status, 200);
  } finally {
    console.log = orig;
  }
});
