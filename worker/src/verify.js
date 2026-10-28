/**
 * Square webhook signature check (WebCrypto, runs in Workers and Node 20+).
 * Square sends `x-square-hmacsha256-signature` = base64(HMAC-SHA256(key = subscription signature key,
 * message = notification_url + raw_body)). The URL is the one typed into the subscription, byte for byte.
 */

const enc = new TextEncoder();

const fromBase64 = (s) => {
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

/** Constant-time equality for two byte arrays (length difference still returns false, after a full pass). */
export function timingSafeEqual(a, b) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** base64 HMAC-SHA256 of `notificationUrl + rawBody` (exported so tests and the README smoke test can mirror it). */
export async function signSquarePayload(signatureKey, notificationUrl, rawBody) {
  const key = await crypto.subtle.importKey('raw', enc.encode(signatureKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(notificationUrl + rawBody)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * @param {string} signatureKey      the subscription's signature key
 * @param {string} notificationUrl   the subscription's notification URL
 * @param {string} rawBody           the request body exactly as received
 * @param {string|null|undefined} headerValue  value of x-square-hmacsha256-signature
 * @returns {Promise<boolean>}
 */
export async function verifySquareSignature(signatureKey, notificationUrl, rawBody, headerValue) {
  if (!signatureKey || !notificationUrl || typeof rawBody !== 'string' || !headerValue) return false;
  const given = fromBase64(headerValue.trim());
  if (!given) return false;
  const expected = fromBase64(await signSquarePayload(signatureKey, notificationUrl, rawBody));
  return timingSafeEqual(expected, given);
}
