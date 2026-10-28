/**
 * skull-thrones-square-relay, the logic (src/index.js is the Worker entry and only re-exports the handler:
 * workerd rejects an entry module with any other named export).
 * Square webhook in, GitHub repository_dispatch out.
 *
 *   POST /square   verify signature (any configured key) -> route -> dedupe -> dispatch to GitHub
 *   GET  /health   200 "ok"
 *   anything else  404
 *
 * Env: GITHUB_REPO (var), secrets GITHUB_TOKEN, SQUARE_SIGNATURE_KEYS (comma list), NOTIFICATION_URL.
 * Never logs request bodies or secrets. Spec: docs/SQUARE-INTEGRATION-SPEC.md section 10.
 */
import { verifySquareSignature } from './verify.js';
import { routeEvent, BOOKING_EVENT } from './route.js';

export const MAX_BODY_BYTES = 256 * 1024;
export const DEDUPE_SECONDS = 600;
const MEMORY_CAP = 500;

/** Per-isolate fallback for the Cache API (which can be a no-op on *.workers.dev). event_id -> expiry ms. */
const seenInMemory = new Map();

const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const log = (obj) => console.log(JSON.stringify(obj));

const dedupeKey = (eventId) => new Request(`https://dedupe.skull-thrones-square-relay.invalid/${encodeURIComponent(eventId)}`);

async function alreadySeen(eventId, cache, now) {
  const exp = seenInMemory.get(eventId);
  if (exp && exp > now) return true;
  try {
    if (cache && (await cache.match(dedupeKey(eventId)))) return true;
  } catch { /* cache unavailable: fall through */ }
  return false;
}

async function markSeen(eventId, cache, now) {
  if (seenInMemory.size >= MEMORY_CAP) {
    for (const [k, exp] of seenInMemory) if (exp <= now) seenInMemory.delete(k);
    if (seenInMemory.size >= MEMORY_CAP) seenInMemory.delete(seenInMemory.keys().next().value);
  }
  seenInMemory.set(eventId, now + DEDUPE_SECONDS * 1000);
  try {
    await cache?.put(dedupeKey(eventId), new Response('1', { headers: { 'cache-control': `max-age=${DEDUPE_SECONDS}` } }));
  } catch { /* best effort */ }
}

/** Test hook. */
export const _resetDedupe = () => seenInMemory.clear();

/**
 * Fires the GitHub repository_dispatch.
 * @returns {Promise<{ok: boolean, retryable: boolean, status: number|string}>}
 *   retryable = GitHub unreachable (network, timeout, 5xx, 429): worth asking Square to retry.
 */
export async function dispatchToGitHub(env, eventType, payload, fetchImpl) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return { ok: false, retryable: false, status: 'not-configured' };
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'skull-thrones-square-relay',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 204 || res.status === 200) return { ok: true, retryable: false, status: res.status };
    return { ok: false, retryable: res.status >= 500 || res.status === 429, status: res.status };
  } catch (e) {
    return { ok: false, retryable: true, status: e?.name === 'TimeoutError' ? 'timeout' : 'network-error' };
  }
}

/**
 * Cloudflare Cron Trigger (wrangler.toml [triggers]): the primary 15-minute clock for availability.yml, because
 * GitHub's own schedule is best-effort (QA 2026-10-28: 0 scheduled runs in 5.5 h). Fires `square-booking` with
 * client_payload { reason: "cron", scheduled_time }; the workflow applies its shop-hours guard to these.
 * @param {{ scheduledTime?: number, cron?: string }} event
 * @returns {Promise<{ok: boolean, retryable: boolean, status: number|string}>}
 */
export async function handleScheduled(event, env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const t = Number(event?.scheduledTime);
  const scheduled_time = new Date(Number.isFinite(t) ? t : (deps.now ?? Date.now)()).toISOString();
  const out = await dispatchToGitHub(env, BOOKING_EVENT, { reason: 'cron', scheduled_time }, fetchImpl);
  log({ msg: out.ok ? 'cron dispatched' : 'cron dispatch failed', route: BOOKING_EVENT, cron: event?.cron ?? null, scheduled_time, github: out.status });
  return out;
}

/**
 * @param {Request} request
 * @param {Record<string, string|undefined>} env
 * @param {{ fetch?: typeof fetch, cache?: Cache|null, now?: () => number }} [deps]
 */
export async function handleRequest(request, env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const cache = deps.cache === undefined ? (globalThis.caches?.default ?? null) : deps.cache;
  const now = (deps.now ?? Date.now)();
  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === '/health') return text('ok');
  if (request.method !== 'POST' || pathname !== '/square') return text('not found', 404);

  const keys = (env.SQUARE_SIGNATURE_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (!keys.length || !env.NOTIFICATION_URL) {
    log({ level: 'error', msg: 'relay not configured: SQUARE_SIGNATURE_KEYS and NOTIFICATION_URL are required' });
    return text('relay not configured', 500);
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return text('payload too large', 413);
  // Counted in bytes, not UTF-16 units (a chunked body has no content-length to trust).
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return text('payload too large', 413);
  const raw = new TextDecoder().decode(bytes);

  const signature = request.headers.get('x-square-hmacsha256-signature');
  // Check every key (no early exit): one subscription per Square account, each with its own key.
  const results = await Promise.all(keys.map((k) => verifySquareSignature(k, env.NOTIFICATION_URL, raw, signature)));
  if (!results.some(Boolean)) {
    log({ level: 'warn', msg: 'signature rejected' });
    return text('invalid signature', 401);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return text('invalid json', 400);
  }
  const type = typeof event?.type === 'string' ? event.type : '';
  const route = routeEvent(type);
  if (!route) {
    log({ msg: 'ignored', type });
    return text('ignored');
  }

  const eventId = typeof event.event_id === 'string' ? event.event_id : '';
  if (eventId && (await alreadySeen(eventId, cache, now))) {
    log({ msg: 'duplicate', type, event_id: eventId });
    return text('duplicate');
  }

  const payload = {
    type,
    merchant_id: event.merchant_id ?? null,
    event_id: eventId || null,
    created_at: event.created_at ?? null,
  };
  const out = await dispatchToGitHub(env, route, payload, fetchImpl);
  log({ msg: out.ok ? 'dispatched' : 'dispatch failed', type, route, event_id: eventId || null, github: out.status });

  if (!out.ok && out.retryable && route === BOOKING_EVENT) {
    // GitHub unreachable and a booking is waiting to show up: let Square retry. Not marked seen, so the retry runs.
    return text('github unavailable, retry', 502);
  }
  if (eventId) await markSeen(eventId, cache, now);
  return text(out.ok ? 'dispatched' : 'accepted');
}
