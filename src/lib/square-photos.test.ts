/* npm test. No network: fetch is injected. The build's HEAD pre-check for Square barber photos (spec §4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPhotoUrl, checkPhotos, isSquarePhotoUrl, SQUARE_IMAGE_HOSTS } from './square-photos.ts';

const ITEM = 'https://items-images-production.s3.us-west-2.amazonaws.com/files/757c4eff/original.jpeg';
const STAFF = 'https://appointments-production-f.squarecdn.com/files/ed1732a0/original.jpg';

test('isSquarePhotoUrl: exact Square hosts, https, /files/ only', () => {
  assert.deepEqual([...SQUARE_IMAGE_HOSTS], ['items-images-production.s3.us-west-2.amazonaws.com', 'appointments-production-f.squarecdn.com']);
  assert.equal(isSquarePhotoUrl(ITEM), true);
  assert.equal(isSquarePhotoUrl(STAFF), true);
  for (const bad of [
    ITEM.replace('https:', 'http:'),
    'https://items-images-production.s3.amazonaws.com/files/a/original.jpeg', // no region: not a host seen in production
    'https://appointments-production-g.squarecdn.com/files/a/original.jpg',
    'https://squarecdn.com.evil.example/files/a.jpg',
    'https://appointments-production-f.squarecdn.com:8443/files/a.jpg',
    'https://appointments-production-f.squarecdn.com/other/a.jpg',
    '//appointments-production-f.squarecdn.com/files/a.jpg',
    '', null, undefined, 42,
  ]) assert.equal(isSquarePhotoUrl(bad), false, String(bad));
});

/** Fake fetch: records each call and answers with `answer(url, init)`. */
const fake = (answer: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; method: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, method: String(init.method), init }); return answer(url, init); }) as unknown as typeof fetch;
  return { f, calls };
};
const img = (status = 200, type = 'image/jpeg') => new Response(null, { status, headers: { 'content-type': type, 'content-length': '2875913' } });

test('checkPhotoUrl: 200 image/* passes with one HEAD and no body download', async () => {
  const { f, calls } = fake(() => img());
  assert.deepEqual(await checkPhotoUrl(STAFF, { fetch: f }), { url: STAFF, ok: true });
  assert.deepEqual(calls.map((c) => c.method), ['HEAD']);
  assert.ok(calls[0]!.init.signal, 'every request carries a timeout signal');
});

test('checkPhotoUrl: 404, 403 (S3 for a missing key) and a non-image fail with a reason', async () => {
  assert.deepEqual(await checkPhotoUrl(ITEM, { fetch: fake(() => img(404, 'application/xml')).f }), { url: ITEM, ok: false, reason: 'HTTP 404' });
  assert.deepEqual(await checkPhotoUrl(ITEM, { fetch: fake(() => img(403, 'application/xml')).f }), { url: ITEM, ok: false, reason: 'HTTP 403' });
  assert.deepEqual(await checkPhotoUrl(ITEM, { fetch: fake(() => img(200, 'text/html; charset=utf-8')).f }), { url: ITEM, ok: false, reason: 'not an image (text/html; charset=utf-8)' });
  assert.deepEqual(await checkPhotoUrl(ITEM, { fetch: fake(() => new Response(null, { status: 200 })).f }), { url: ITEM, ok: false, reason: 'not an image (no content-type)' });
});

test('checkPhotoUrl: a hung host times out (real AbortSignal timer) and a network error fails, never throws', async () => {
  const hang = fake((_u, init) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
  }));
  const t0 = Date.now();
  // AbortSignal.timeout's timer is unref'd; with a fake fetch nothing else keeps Node 22's event loop alive,
  // so the runner would exit with the promise pending. A ref'd timer keeps the loop up (same as resilience.test.ts).
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    assert.deepEqual(await checkPhotoUrl(STAFF, { fetch: hang.f, timeoutMs: 50 }), { url: STAFF, ok: false, reason: 'timed out after 0.05 s' });
  } finally { clearTimeout(keepAlive); }
  assert.ok(Date.now() - t0 < 2000);
  const down = fake(() => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await checkPhotoUrl(STAFF, { fetch: down.f }), { url: STAFF, ok: false, reason: 'network error (fetch failed)' });
});

test('checkPhotoUrl: a host that refuses HEAD gets one ranged GET', async () => {
  const { f, calls } = fake((_u, init) => (init.method === 'HEAD' ? new Response(null, { status: 405 }) : new Response('x', { status: 206, headers: { 'content-type': 'image/png' } })));
  assert.deepEqual(await checkPhotoUrl(ITEM, { fetch: f }), { url: ITEM, ok: true });
  assert.deepEqual(calls.map((c) => c.method), ['HEAD', 'GET']);
  assert.equal((calls[1]!.init.headers as Record<string, string>).Range, 'bytes=0-0');
});

test('checkPhotos: results in input order, at most `concurrency` in flight (default 4)', async () => {
  let inFlight = 0;
  let peak = 0;
  const urls = Array.from({ length: 10 }, (_, i) => `${STAFF}?n=${i}`);
  const f = (async (url: string) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5 + (urls.indexOf(url) % 3) * 5));
    inFlight--;
    return url.endsWith('=3') ? img(404) : img();
  }) as unknown as typeof fetch;
  const res = await checkPhotos(urls, { fetch: f });
  assert.equal(peak, 4);
  assert.deepEqual(res.map((r) => r.url), urls);
  assert.deepEqual(res.map((r) => r.ok), urls.map((u) => !u.endsWith('=3')));
  peak = 0;
  await checkPhotos(urls, { fetch: f, concurrency: 2 });
  assert.equal(peak, 2);
  assert.deepEqual(await checkPhotos([], { fetch: f }), []);
});
