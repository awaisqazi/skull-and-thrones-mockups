// node --test "worker/test/*.test.mjs". Fault injection for the relay (QA 2026-10-28, row 9): GitHub timeouts and
// rate limits, odd signed payloads, and what an unconfigured Worker logs. Behaviour as it is today.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleRequest, handleScheduled, _resetDedupe, MAX_BODY_BYTES } from '../src/relay.js';
import worker from '../src/index.js';
import { readFileSync } from 'node:fs';

const URL_ = 'https://relay.example.workers.dev/square';
const KEY = 'key-resilience-test';
const ENV = { GITHUB_REPO: 'owner/repo', GITHUB_TOKEN: 'ghp_resilience_not_real', SQUARE_SIGNATURE_KEYS: KEY, NOTIFICATION_URL: URL_ };
const sig = (body) => createHmac('sha256', KEY).update(URL_ + body).digest('base64');
const post = (body, signed = true) => new Request(URL_, { method: 'POST', body, headers: signed ? { 'x-square-hmacsha256-signature': sig(body) } : {} });
const ev = (type, id) => JSON.stringify({ merchant_id: 'M', type, event_id: id, created_at: '2026-10-28T20:00:00Z', data: { object: { note: 'customer detail' } } });
const capture = async (fn) => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { value: await fn(), lines }; } finally { console.log = orig; }
};

beforeEach(() => _resetDedupe());

test('GitHub timeout (AbortSignal TimeoutError): booking 502 logged as "timeout", catalog 200 accepted', async () => {
  const timeout = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const { value: booking, lines } = await capture(() => handleRequest(post(ev('booking.updated', 't-1')), ENV, { fetch: timeout, cache: null }));
  assert.equal(booking.status, 502);
  assert.ok(lines.some((l) => JSON.parse(l).github === 'timeout'), lines.join('\n'));
  const catalog = await handleRequest(post(ev('team_member.updated', 't-2')), ENV, { fetch: timeout, cache: null });
  assert.equal(catalog.status, 200);
  assert.equal(await catalog.text(), 'accepted');
});

test('a catalog event GitHub rate-limited (429) is answered 200 and marked seen, so Square\'s retry is a duplicate', async () => {
  let calls = 0;
  const limited = async () => { calls++; return new Response(null, { status: 429 }); };
  const first = await handleRequest(post(ev('catalog.version.updated', 'rl-1')), ENV, { fetch: limited, cache: null });
  assert.equal(first.status, 200);
  const retry = await handleRequest(post(ev('catalog.version.updated', 'rl-1')), ENV, { fetch: limited, cache: null });
  assert.equal(await retry.text(), 'duplicate');
  assert.equal(calls, 1);
});

test('signed bodies that are JSON but not an event object (null, array, number, string) are 200 ignored, never 5xx', async () => {
  let calls = 0;
  const f = async () => { calls++; return new Response(null, { status: 204 }); };
  for (const body of ['null', '[]', '[1,2]', '42', '"booking.created"', '{}', '{"type":42}']) {
    const r = await handleRequest(post(body), ENV, { fetch: f, cache: null });
    assert.equal(r.status, 200, body);
    assert.equal(await r.text(), 'ignored', body);
  }
  assert.equal(calls, 0);
});

test('a non-string event_id is not used for dedupe and is forwarded as null', async () => {
  const bodies = [];
  const f = async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); };
  const body = JSON.stringify({ type: 'booking.created', event_id: 12345 });
  await handleRequest(post(body), ENV, { fetch: f, cache: null });
  await handleRequest(post(body), ENV, { fetch: f, cache: null });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].client_payload.event_id, null);
});

test('unconfigured Worker: 500 for any POST /square (signed or not), the log line carries no body or secret', async () => {
  for (const env of [{ ...ENV, SQUARE_SIGNATURE_KEYS: '' }, { ...ENV, SQUARE_SIGNATURE_KEYS: ' , ' }, { ...ENV, NOTIFICATION_URL: undefined }]) {
    for (const signed of [true, false]) {
      const { value: r, lines } = await capture(() => handleRequest(post(ev('booking.created', 'u-1'), signed), env, { fetch: async () => new Response(null, { status: 204 }), cache: null }));
      assert.equal(r.status, 500);
      const all = lines.join('\n');
      for (const s of ['customer detail', KEY, 'ghp_resilience_not_real']) assert.ok(!all.includes(s), s);
    }
  }
});

/* ---------- Fix round (QA 2026-10-28) ---------- */

test('fix 9 body limit counts bytes: a signed body of 2-byte characters under 256K chars but over 256 KB is 413', async () => {
  const body = JSON.stringify({ type: 'booking.created', event_id: 'big-1', pad: 'é'.repeat(140000) });
  assert.ok(body.length < MAX_BODY_BYTES && new TextEncoder().encode(body).length > MAX_BODY_BYTES);
  // No content-length: a streamed body, so only the byte count can catch it.
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
  const req = new Request(URL_, { method: 'POST', body: stream, duplex: 'half', headers: { 'x-square-hmacsha256-signature': sig(body) } });
  assert.equal(req.headers.get('content-length'), null);
  let calls = 0;
  const r = await handleRequest(req, ENV, { fetch: async () => { calls++; return new Response(null, { status: 204 }); }, cache: null });
  assert.equal(r.status, 413);
  assert.equal(calls, 0);
});

test('fix 9 body limit: a multi-byte body under the limit still verifies and dispatches (decoded as UTF-8)', async () => {
  const body = JSON.stringify({ type: 'booking.created', event_id: 'utf-1', note: 'Peña · 理髮 · 💈' });
  const r = await handleRequest(post(body), ENV, { fetch: async () => new Response(null, { status: 204 }), cache: null });
  assert.equal(await r.text(), 'dispatched');
});

test('fix B cron: handleScheduled dispatches square-booking with { reason: "cron", scheduled_time } and logs no secret', async () => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); };
  const { value: out, lines } = await capture(() => handleScheduled({ scheduledTime: Date.parse('2026-10-28T15:00:00Z'), cron: '*/15 12-23 * * *' }, ENV, { fetch: f }));
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/dispatches');
  assert.deepEqual(JSON.parse(calls[0].init.body), { event_type: 'square-booking', client_payload: { reason: 'cron', scheduled_time: '2026-10-28T15:00:00.000Z' } });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ghp_resilience_not_real');
  const all = lines.join('\n');
  assert.ok(all.includes('"msg":"cron dispatched"'), all);
  assert.ok(!all.includes('ghp_resilience_not_real'));
});

test('fix B cron: GitHub down, refused or not configured never throws; the result says why', async () => {
  for (const [f, status] of [[async () => { throw new TypeError('fetch failed'); }, 'network-error'], [async () => new Response(null, { status: 401 }), 401], [async () => new Response(null, { status: 503 }), 503]]) {
    const { value: out } = await capture(() => handleScheduled({ scheduledTime: 0 }, ENV, { fetch: f }));
    assert.equal(out.ok, false);
    assert.equal(out.status, status);
  }
  const { value: off } = await capture(() => handleScheduled({}, { ...ENV, GITHUB_TOKEN: '' }, { fetch: async () => { throw new Error('must not be called'); }, now: () => 0 }));
  assert.equal(off.status, 'not-configured');
});

test('fix B cron: the default export has a scheduled() handler that uses waitUntil', async () => {
  assert.equal(typeof worker.scheduled, 'function');
  const pending = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    await capture(async () => {
      await worker.scheduled({ scheduledTime: Date.now(), cron: '*/15 0-2 * * *' }, ENV, { waitUntil: (p) => pending.push(p) });
      assert.equal(pending.length, 1);
      await Promise.all(pending);
    });
  } finally { globalThis.fetch = orig; }
});

test('fix B cron: wrangler.toml declares the two UTC cron triggers (the union of 07:00-20:59 Chicago, CDT and CST)', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[triggers\]\s*\ncrons = \["\*\/15 12-23 \* \* \*", "\*\/15 0-2 \* \* \*"\]/);
});
