/**
 * Barber photos from Square (build time only, spec §4 "Headshots from Square").
 *
 * Square has two photo slots per barber, both public URLs on Square's own hosts (checked read-only on both
 * production accounts 2026-10-29):
 *   1. the service item image (Items → Service library → the barber's service → image): IMAGE objects behind
 *      `item_data.image_ids`, `https://items-images-production.s3.us-west-2.amazonaws.com/files/<sha1>/original.jpeg`.
 *      This is the photo Square's public booking page shows next to each barber.
 *   2. the staff profile photo (Staff → team member → photo): `profile_image_url` on the team member booking
 *      profile, `https://appointments-production-f.squarecdn.com/files/<hash>/original.jpg` (1.6–3.4 MB JPEGs).
 *
 * The roster (roster.ts) only accepts URLs that pass `isSquarePhotoUrl`; astro.config.mjs builds
 * `image.remotePatterns` from the same list, so every accepted URL is one astro:assets downloads and optimises.
 * `checkPhotos` is the build's pre-check: Astro's remote image fetch throws (and fails the build) on a 404, a
 * timeout or a non-image, so each Square photo is HEAD-checked first and a failed one falls back to the local file.
 *
 * Pure fetch, no Astro imports, so `node --test` and astro.config.mjs load it directly.
 */

/** Exact hostnames Square serves barber photos from (no wildcards: a new host must be added here on purpose). */
export const SQUARE_IMAGE_HOSTS = [
  'items-images-production.s3.us-west-2.amazonaws.com',
  'appointments-production-f.squarecdn.com',
] as const;

/** Every Square photo path seen so far starts with /files/ (both hosts). Mirrored in astro.config.mjs `remotePatterns`. */
export const SQUARE_IMAGE_PATH_PREFIX = '/files/';

/** True for an absolute https URL on a Square photo host under /files/ (no credentials, no custom port). */
export function isSquarePhotoUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.port && !u.username && !u.password
    && (SQUARE_IMAGE_HOSTS as readonly string[]).includes(u.hostname)
    && u.pathname.startsWith(SQUARE_IMAGE_PATH_PREFIX);
}

export interface PhotoCheck {
  url: string;
  ok: boolean;
  /** Why it failed ("HTTP 404", "timed out after 8 s", "not an image (application/xml)"…). Absent when ok. */
  reason?: string;
}

export interface CheckOptions {
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Per URL, default 8000 ms. */
  timeoutMs?: number;
  /** Parallel requests, default 4. */
  concurrency?: number;
}

const isTimeout = (e: unknown) => ['TimeoutError', 'AbortError'].includes((e as Error)?.name);

/**
 * HEAD one photo URL: ok = a 2xx whose content-type is image/*. A host that refuses HEAD (405/501) gets one
 * `GET` with `Range: bytes=0-0` instead (body discarded). Never throws.
 */
export async function checkPhotoUrl(url: string, opts: CheckOptions = {}): Promise<PhotoCheck> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  try {
    let res = await doFetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 405 || res.status === 501) {
      res = await doFetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel().catch(() => {});
    }
    if (!res.ok) return { url, ok: false, reason: `HTTP ${res.status}` };
    const type = (res.headers.get('content-type') ?? '').trim();
    if (!/^image\//i.test(type)) return { url, ok: false, reason: `not an image (${type || 'no content-type'})` };
    return { url, ok: true };
  } catch (e) {
    return { url, ok: false, reason: isTimeout(e) ? `timed out after ${timeoutMs / 1000} s` : `network error (${(e as Error)?.message ?? e})` };
  }
}

/** checkPhotoUrl for each URL, at most `concurrency` (default 4) in flight. Results in input order. Never throws. */
export async function checkPhotos(urls: readonly string[], opts: CheckOptions = {}): Promise<PhotoCheck[]> {
  const out: PhotoCheck[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      out[i] = await checkPhotoUrl(urls[i]!, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, urls.length)) }, worker));
  return out;
}
