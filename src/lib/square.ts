/**
 * Square Catalog client (build time only, never imported by client code).
 *
 * Each shop is its own Square merchant account, so each call takes that shop's access token
 * (env SQUARE_TOKEN_ADDISON / SQUARE_TOKEN_ELMHURST) and its location id
 * (locations.json `square_location_id`). Every barber is one Square "service" ITEM; the
 * per-barber booking deep link is `<square_booking_url>/<item_id>`.
 *
 * Pure fetch, no SDK. Kept free of Astro imports so `node --test` and
 * scripts/check-square.mjs can load it directly (Node strips the types).
 */

export const SQUARE_API = 'https://connect.squareup.com';
export const SQUARE_VERSION = '2025-09-24';

/** What the roster needs from one Square catalog item. */
export interface SquareItem {
  item_id: string;
  name: string;
  /** Lowest-priced variation, in dollars (Square stores cents). null = no fixed price (variable pricing). */
  price_from: number | null;
  /** service_duration of that same variation, in minutes. null = not set. */
  duration_minutes: number | null;
  description: string;
  /** Square product_type, e.g. APPOINTMENTS_SERVICE (barbers) vs REGULAR (retail). */
  product_type: string | null;
  is_archived: boolean;
  /**
   * Every variation present at this location, in catalog order (the services: Haircut, Beard…).
   * Availability search needs one variation id plus the team member who performs it
   * (src/lib/bookings.ts `pickBookableVariation`).
   */
  variations: SquareVariation[];
  /** Catalog IMAGE object ids attached to the item (resolve with include_related_objects). */
  image_ids: string[];
}

/** One service variation of a barber item. */
export interface SquareVariation {
  id: string;
  name: string;
  /** Dollars. null = no fixed price (variable pricing) or price not set. */
  price: number | null;
  /** service_duration in minutes. null = not set. */
  duration_minutes: number | null;
  /** Team members who perform this service (item_variation_data.team_member_ids). */
  team_member_ids: string[];
  /** item_variation_data.available_for_booking; Square treats unset as bookable. */
  available_for_booking: boolean;
}

const NOT_STANDARD = /kid|child|teen|senior|long|mid|pixie|beard|perm|color|consult|lining|facial|braid/i;

/**
 * The barber's standard adult haircut, the service the site prices and probes availability for:
 * a variation named exactly "Haircut" (case/space-insensitive), else the cheapest priced variation whose
 * name contains "haircut" but is not a kids/senior/long-length/add-on service, else the cheapest priced
 * "haircut" of any kind, else null. Checked against both production catalogs 2026-10-29: every barber
 * has a plain "Haircut" variation, so the fallbacks only matter for future catalog edits.
 */
export function standardHaircut(variations: SquareVariation[]): SquareVariation | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const exact = variations.find((v) => norm(v.name) === 'haircut');
  if (exact) return exact;
  const priced = variations.filter((v) => /haircut/i.test(v.name) && v.price != null && v.price > 0).sort((a, b) => a.price! - b.price!);
  return priced.find((v) => !NOT_STANDARD.test(v.name)) ?? priced[0] ?? null;
}

/* Minimal shapes of the Catalog API objects we read (https://developer.squareup.com/reference/square/catalog-api/search-catalog-objects). */
interface Money { amount?: number | bigint | null; currency?: string }
interface CatalogVariation {
  id: string;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  is_deleted?: boolean;
  item_variation_data?: {
    name?: string;
    price_money?: Money | null;
    service_duration?: number | bigint | null;
    team_member_ids?: string[] | null;
    available_for_booking?: boolean | null;
    /** Per-location settings; a matching `price_money` (and `service_duration`, if Square ever sends one) wins over the base value. */
    location_overrides?: { location_id?: string; price_money?: Money | null; service_duration?: number | bigint | null }[] | null;
  };
}
export interface CatalogObject {
  type: string;
  id: string;
  is_deleted?: boolean;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_data?: {
    name?: string;
    description?: string;
    description_plaintext?: string;
    product_type?: string;
    is_archived?: boolean;
    image_ids?: string[] | null;
    variations?: CatalogVariation[];
  };
}
interface SearchResponse { objects?: CatalogObject[]; cursor?: string; errors?: { category: string; code: string; detail?: string }[] }

type Located = Pick<CatalogObject, 'present_at_all_locations' | 'present_at_location_ids' | 'absent_at_location_ids'>;

/** Square's rule: present_at_all_locations (minus absent_at_location_ids), or listed in present_at_location_ids. */
export function isAtLocation(o: Located, locationId: string): boolean {
  if (o.present_at_all_locations) return !(o.absent_at_location_ids ?? []).includes(locationId);
  return (o.present_at_location_ids ?? []).includes(locationId);
}

/**
 * Square service_duration (ms) → whole minutes, or null when it is missing, not a number, negative or under one
 * minute once rounded (the content schema needs a positive integer; a bad value must never fail the build).
 */
function minutesOf(ms: number | null | undefined): number | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const m = Math.round(ms / 60000);
  return m >= 1 ? m : null;
}

/** Pure: catalog ITEM object → SquareItem (null when it is not an item sold at this location). */
export function toSquareItem(o: CatalogObject, locationId: string): SquareItem | null {
  if (o.type !== 'ITEM' || o.is_deleted || !o.item_data || !isAtLocation(o, locationId)) return null;
  const d = o.item_data;
  const here = (d.variations ?? []).filter((v) => !v.is_deleted && isAtLocation(v, locationId));
  const priced = here.map((v) => {
    const vd = v.item_variation_data;
    // The shop's own price (Square "location override"), else the variation's base price. Carlos (Addison) is $60 at
    // the shop and $65 in the base variation (QA 2026-10-28): customers see the override on Square's booking page.
    const ov = Array.isArray(vd?.location_overrides) ? vd.location_overrides.find((o) => o?.location_id === locationId) : undefined;
    const amount = ov?.price_money?.amount ?? vd?.price_money?.amount;
    const duration = ov?.service_duration ?? vd?.service_duration;
    const cents = amount != null && Number.isFinite(Number(amount)) ? Number(amount) : null;
    return { cents, ms: duration != null ? Number(duration) : null };
  });
  const cheapest = priced
    .filter((v): v is { cents: number; ms: number | null } => v.cents != null && v.cents > 0)
    .sort((a, b) => a.cents - b.cents)[0];
  const durationMinutes = minutesOf(cheapest?.ms) ?? priced.map((v) => minutesOf(v.ms)).find((m) => m != null) ?? null;
  return {
    item_id: o.id,
    name: (d.name ?? '').trim(),
    price_from: cheapest ? cheapest.cents / 100 : null,
    duration_minutes: durationMinutes,
    description: (d.description_plaintext ?? d.description ?? '').trim(),
    product_type: d.product_type ?? null,
    is_archived: Boolean(d.is_archived),
    variations: here.map((v, i) => {
      const { cents, ms } = priced[i]!;
      return {
        id: v.id,
        name: (v.item_variation_data?.name ?? '').trim(),
        price: cents != null ? cents / 100 : null,
        duration_minutes: minutesOf(ms),
        team_member_ids: [...(v.item_variation_data?.team_member_ids ?? [])],
        available_for_booking: v.item_variation_data?.available_for_booking !== false,
      };
    }),
    image_ids: [...(d.image_ids ?? [])],
  };
}

/** Request headers for every Square API call (bookings.ts reuses them). */
export function squareHeaders(token: string, squareVersion = SQUARE_VERSION): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Square-Version': squareVersion,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export interface ListOptions {
  /** Injected for tests. */
  fetch?: typeof fetch;
  apiBase?: string;
  squareVersion?: string;
  /** Per attempt, default 20 s. */
  timeoutMs?: number;
  /** Extra attempts on HTTP 429 / 5xx / network errors / an unreadable 2xx body. Default 2 (spec §3). Timeouts are retried at most once. */
  retries?: number;
  /** Injected for tests; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/* ---------- Strict responses + one retry policy for every Square call ---------- */

/** Thrown for a failed Square call; `status` is the HTTP status (0 = network/timeout, no response). */
export class SquareApiError extends Error {
  // Plain fields, not constructor parameter properties: Node's type stripping rejects those.
  status: number;
  /** The call (or reading its body) was cut off by the timeout. */
  timeout: boolean;
  constructor(message: string, status: number, timeout = false) { super(message); this.status = status; this.timeout = timeout; }
}

export interface SquareErrorBody { errors?: { category?: string; code: string; detail?: string }[] }

const isTimeoutError = (e: unknown) => ['TimeoutError', 'AbortError'].includes((e as Error)?.name);
const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Reads a Square response body strictly: a body that cannot be read, is not JSON, or is not a JSON object throws
 * SquareApiError (`<label> failed (HTTP n): …`, status = the HTTP status). Never returns an empty stand-in, so a
 * proxy page or a truncated body can never read as "no results" (QA 2026-10-28, high finding).
 */
export async function readJson<T extends object = Record<string, unknown>>(res: Response, label: string): Promise<T & SquareErrorBody> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw new SquareApiError(`${label} failed (HTTP ${res.status}): body could not be read (${(e as Error).message})`, res.status, isTimeoutError(e));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SquareApiError(`${label} failed (HTTP ${res.status}): ${res.ok ? 'response is not JSON' : res.statusText || 'response is not JSON'}`, res.status);
  }
  if (!isPlainObject(json)) throw new SquareApiError(`${label} failed (HTTP ${res.status}): response is not a JSON object`, res.status);
  return json as T & SquareErrorBody;
}

/** Throws SquareApiError (status 200, not retried) when `body[key]` is present but not an array. */
export function arrayField<T>(body: Record<string, unknown>, key: string, label: string): T[] {
  const v = body[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SquareApiError(`${label} failed (HTTP 200): "${key}" is not a list`, 200);
  return v as T[];
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errorText = (b: SquareErrorBody | null) => b?.errors?.map((e) => `${e.code}${e.detail ? `: ${e.detail}` : ''}`).join('; ') || '';

/**
 * One Square call with the shared retry policy (spec §3): up to `retries` (default 2) extra attempts on HTTP 429,
 * 5xx, network errors and a 2xx whose body is unreadable or not a JSON object; a timeout (of the call or of its body)
 * is retried at most once. Retry-After is honoured up to 30 s, else 1 s, 2 s backoff. Anything else (401/403/4xx, a
 * 2xx carrying `errors`) throws at once. The message carries the label and the HTTP status, never the token.
 */
export async function squareCall<T extends object>(label: string, url: string, init: { method: string; token: string; body?: string }, opts: ListOptions = {}): Promise<T & SquareErrorBody> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? wait;
  const retries = opts.retries ?? 2;
  let timeouts = 0;
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let why = '';
    let retryable = true;
    let retryAfterMs: number | null = null;
    try {
      const res = await doFetch(url, {
        method: init.method,
        headers: squareHeaders(init.token, opts.squareVersion),
        ...(init.body != null ? { body: init.body } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      });
      status = res.status;
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra, 30) * 1000;
      let json: (T & SquareErrorBody) | null = null;
      try {
        json = await readJson<T>(res, label);
      } catch (e) {
        if ((e as SquareApiError).timeout) timeouts++;
        why = res.ok ? String((e as Error).message).replace(/^.*?\): /, '') : res.statusText || 'response is not JSON';
      }
      if (res.ok && json && !json.errors?.length) return json;
      if (json) why = errorText(json) || res.statusText;
      // A 2xx with a broken body is worth another try; a 2xx that carries `errors` is Square's answer.
      retryable = status === 429 || status >= 500 || (res.ok && !json);
    } catch (e) {
      if (isTimeoutError(e)) timeouts++;
      why = (e as Error).message;
    }
    if (attempt >= retries || !retryable || timeouts > 1) {
      throw new SquareApiError(`${label} failed (HTTP ${status || 'network'}): ${why}`, status, timeouts > 0);
    }
    await sleep(retryAfterMs ?? 1000 * 2 ** attempt);
  }
}

/**
 * Lists every catalog ITEM present at `locationId` for the merchant that owns `token`.
 * POST /v2/catalog/search, paginated via `cursor`, through `squareCall` (retries, strict bodies). Throws
 * SquareApiError so the caller can decide to fall back (the content loader never lets this fail the build).
 */
export async function listSquareItems(token: string, locationId: string, opts: ListOptions = {}): Promise<SquareItem[]> {
  const items: SquareItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const body = await squareCall<SearchResponse>('Square catalog search', `${opts.apiBase ?? SQUARE_API}/v2/catalog/search`, {
      method: 'POST',
      token,
      body: JSON.stringify({ object_types: ['ITEM'], include_deleted_objects: false, limit: 1000, ...(cursor ? { cursor } : {}) }),
    }, opts);
    for (const o of arrayField<CatalogObject>(body as Record<string, unknown>, 'objects', 'Square catalog search')) {
      const item = isPlainObject(o) ? toSquareItem(o, locationId) : null;
      if (item) items.push(item);
    }
    cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : undefined;
    if (++pages > 50) throw new Error('Square catalog search: more than 50 pages, giving up');
  } while (cursor);
  return items;
}

/* ---------- Both shops ---------- */

export interface SquareShop { slug: string; square_location_id: string; any_artist_item_id?: string }

/** Env var holding a shop's access token: addison → SQUARE_TOKEN_ADDISON, elmhurst → SQUARE_TOKEN_ELMHURST. */
export const tokenEnv = (slug: string) => `SQUARE_TOKEN_${slug.toUpperCase()}`;

/**
 * A shop's access token: `SQUARE_TOKEN_<SHOP>` when set, else the shared `SQUARE_TOKEN`.
 * Production (checked 2026-10-28, spec §9): the main "Skull & Thrones" account holds Addison (D11BVA91E8V3N)
 * and is `SQUARE_TOKEN`; Elmhurst's live booking page (L65DF5AG5BDAN) is a SEPARATE account, "Skull and Thrones
 * Elmhurst", so it needs `SQUARE_TOKEN_ELMHURST`. (The main account also has an "S&T Elmhurst" location,
 * L60NY7G2ZQ7B0, with duplicate barber services; it is not what customers book through today.)
 */
export const squareToken = (env: Record<string, string | undefined>, slug: string) => env[tokenEnv(slug)] || env.SQUARE_TOKEN;

/** Names of the token env vars still needed: [] when SQUARE_TOKEN is set, else each unset SQUARE_TOKEN_<SHOP>. */
export const missingTokens = (shops: { slug: string }[], env: Record<string, string | undefined>) =>
  shops.map((s) => tokenEnv(s.slug)).filter((k) => !env[k] && !env.SQUARE_TOKEN);

export interface ShopsResult {
  /** Items per shop slug, only for shops fetched successfully with at least one item. */
  square: Record<string, SquareItem[]>;
  /** Env vars that are not set. Non-empty = nothing was fetched. */
  missing: string[];
  /** One line per shop that failed (network, auth, empty catalog). Those shops fall back to barbers.json. */
  errors: string[];
}

/**
 * Fetches every shop's catalog, but only when ALL tokens are present (half a Square roster
 * would be confusing). Never throws: failures come back in `errors`.
 */
export async function fetchShops(shops: SquareShop[], env: Record<string, string | undefined>, opts: ListOptions = {}): Promise<ShopsResult> {
  const missing = missingTokens(shops, env);
  const result: ShopsResult = { square: {}, missing, errors: [] };
  if (missing.length) return result;
  await Promise.all(shops.map(async (s) => {
    try {
      const items = await listSquareItems(squareToken(env, s.slug)!, s.square_location_id, opts);
      // An empty catalog almost always means a wrong token/location or missing permission, not "everyone quit".
      if (!items.some((i) => i.item_id !== s.any_artist_item_id)) throw new Error(`no items at location ${s.square_location_id}`);
      result.square[s.slug] = items;
    } catch (e) {
      result.errors.push(`${s.slug}: ${(e as Error).message}`);
    }
  }));
  return result;
}
