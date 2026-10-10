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
}

/* Minimal shapes of the Catalog API objects we read (https://developer.squareup.com/reference/square/catalog-api/search-catalog-objects). */
interface Money { amount?: number | bigint | null; currency?: string }
interface CatalogVariation {
  id: string;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_variation_data?: { price_money?: Money | null; service_duration?: number | null };
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

/** Pure: catalog ITEM object → SquareItem (null when it is not an item sold at this location). */
export function toSquareItem(o: CatalogObject, locationId: string): SquareItem | null {
  if (o.type !== 'ITEM' || o.is_deleted || !o.item_data || !isAtLocation(o, locationId)) return null;
  const d = o.item_data;
  const priced = (d.variations ?? [])
    .filter((v) => isAtLocation(v, locationId))
    .map((v) => ({
      cents: v.item_variation_data?.price_money?.amount != null ? Number(v.item_variation_data.price_money.amount) : null,
      ms: v.item_variation_data?.service_duration ?? null,
    }));
  const cheapest = priced
    .filter((v): v is { cents: number; ms: number | null } => v.cents != null && v.cents > 0)
    .sort((a, b) => a.cents - b.cents)[0];
  const durationMs = cheapest?.ms ?? priced.find((v) => v.ms)?.ms ?? null;
  return {
    item_id: o.id,
    name: (d.name ?? '').trim(),
    price_from: cheapest ? cheapest.cents / 100 : null,
    duration_minutes: durationMs ? Math.round(durationMs / 60000) : null,
    description: (d.description_plaintext ?? d.description ?? '').trim(),
    product_type: d.product_type ?? null,
    is_archived: Boolean(d.is_archived),
  };
}

export interface ListOptions {
  /** Injected for tests. */
  fetch?: typeof fetch;
  apiBase?: string;
  squareVersion?: string;
  timeoutMs?: number;
}

/**
 * Lists every catalog ITEM present at `locationId` for the merchant that owns `token`.
 * POST /v2/catalog/search, paginated via `cursor`. Throws on HTTP/API errors so the caller
 * can decide to fall back (the content loader never lets this fail the build).
 */
export async function listSquareItems(token: string, locationId: string, opts: ListOptions = {}): Promise<SquareItem[]> {
  const doFetch = opts.fetch ?? fetch;
  const items: SquareItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await doFetch(`${opts.apiBase ?? SQUARE_API}/v2/catalog/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Square-Version': opts.squareVersion ?? SQUARE_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ object_types: ['ITEM'], include_deleted_objects: false, limit: 1000, ...(cursor ? { cursor } : {}) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
    });
    const body = (await res.json().catch(() => ({}))) as SearchResponse;
    if (!res.ok || body.errors?.length) {
      const why = body.errors?.map((e) => `${e.code}${e.detail ? `: ${e.detail}` : ''}`).join('; ') || res.statusText;
      throw new Error(`Square catalog search failed (HTTP ${res.status}): ${why}`);
    }
    for (const o of body.objects ?? []) {
      const item = toSquareItem(o, locationId);
      if (item) items.push(item);
    }
    cursor = body.cursor || undefined;
    if (++pages > 50) throw new Error('Square catalog search: more than 50 pages, giving up');
  } while (cursor);
  return items;
}

/* ---------- Both shops ---------- */

export interface SquareShop { slug: string; square_location_id: string; any_artist_item_id?: string }

/** Env var holding a shop's access token: addison → SQUARE_TOKEN_ADDISON, elmhurst → SQUARE_TOKEN_ELMHURST. */
export const tokenEnv = (slug: string) => `SQUARE_TOKEN_${slug.toUpperCase()}`;

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
  const missing = shops.map((s) => tokenEnv(s.slug)).filter((k) => !env[k]);
  const result: ShopsResult = { square: {}, missing, errors: [] };
  if (missing.length) return result;
  await Promise.all(shops.map(async (s) => {
    try {
      const items = await listSquareItems(env[tokenEnv(s.slug)]!, s.square_location_id, opts);
      // An empty catalog almost always means a wrong token/location or missing permission, not "everyone quit".
      if (!items.some((i) => i.item_id !== s.any_artist_item_id)) throw new Error(`no items at location ${s.square_location_id}`);
      result.square[s.slug] = items;
    } catch (e) {
      result.errors.push(`${s.slug}: ${(e as Error).message}`);
    }
  }));
  return result;
}
