/**
 * Square Bookings client: "when is this barber next free?" and "is this barber bookable online?"
 * (build/job time only, never in the browser).
 *
 * POST /v2/bookings/availability/search with a buyer-level token (APPOINTMENTS_READ), free
 * Appointments plan. One call per barber: that barber's bookable service variation plus the team
 * member who performs it, both read from the catalog item (src/lib/square.ts).
 *
 * Pure fetch, no SDK, no Astro imports, so `node --test` and scripts/fetch-availability.mjs load it
 * directly. The pure helpers (pickBookableVariation, summarise) are unit-tested in bookings.test.ts.
 * listTeamMemberBookingProfiles reads GET /v2/bookings/team-member-booking-profiles (is_bookable + bio).
 */
import { SQUARE_API, squareHeaders, standardHaircut, type SquareItem, type SquareVariation } from './square.ts';

/** One entry of Square's `availabilities[]` (https://developer.squareup.com/reference/square/bookings-api/search-availability). */
export interface Availability {
  start_at: string;
  location_id?: string;
  appointment_segments?: {
    duration_minutes?: number;
    team_member_id?: string;
    service_variation_id?: string;
    service_variation_version?: number | bigint;
  }[];
}
interface SearchResponse { availabilities?: Availability[]; errors?: { category: string; code: string; detail?: string }[] }

export interface SearchOptions {
  /** Injected for tests. */
  fetch?: typeof fetch;
  apiBase?: string;
  squareVersion?: string;
  timeoutMs?: number;
  /** Extra attempts on HTTP 429 / 5xx / network errors. Default 2 (spec §3: never more than twice). */
  retries?: number;
  /** Injected for tests; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown for a failed search; `status` is the HTTP status (0 = network/timeout). */
export class SquareApiError extends Error {
  // A plain field, not a constructor parameter property: Node's type stripping rejects those.
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500 || status === 0;

interface SquareErrorBody { errors?: { category: string; code: string; detail?: string }[] }

/**
 * One Square call with the job's retry policy (spec §3): retries twice on 429 / 5xx / network errors
 * (Retry-After honoured up to 30 s, else 1 s, 2 s backoff); throws SquareApiError(`<label> failed (HTTP n): …`)
 * for anything else, so callers can tell auth failures (401/403) from outages.
 */
async function squareCall<T extends SquareErrorBody>(label: string, url: string, init: { method: string; token: string; body?: string }, opts: SearchOptions): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? wait;
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let why = '';
    let retryAfterMs: number | null = null;
    try {
      const res = await doFetch(url, {
        method: init.method,
        headers: squareHeaders(init.token, opts.squareVersion),
        ...(init.body != null ? { body: init.body } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      });
      status = res.status;
      const json = (await res.json().catch(() => ({}))) as T;
      if (res.ok && !json.errors?.length) return json;
      why = json.errors?.map((e) => `${e.code}${e.detail ? `: ${e.detail}` : ''}`).join('; ') || res.statusText;
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra, 30) * 1000;
    } catch (e) {
      why = (e as Error).message;
    }
    if (attempt >= retries || !retryable(status)) {
      throw new SquareApiError(`${label} failed (HTTP ${status || 'network'}): ${why}`, status);
    }
    await sleep(retryAfterMs ?? 1000 * 2 ** attempt);
  }
}

/** True for a rejected token or missing permission (HTTP 401/403): the job fails loudly on these (spec §3). */
export const isAuthFailure = (e: unknown): boolean => {
  if (e instanceof SquareApiError) return e.status === 401 || e.status === 403;
  // listSquareItems (square.ts) throws a plain Error whose message carries the status.
  return /\(HTTP (401|403)\)/.test(String((e as Error)?.message ?? e));
};

/**
 * Open start times for one barber between `window.start` and `window.end` (Square allows 24 h to 32 days).
 * Retry policy: `squareCall`. Throws SquareApiError so the job can record it per barber.
 */
export async function searchAvailability(
  token: string,
  locationId: string,
  variationId: string,
  teamMemberId: string,
  window: { start: Date; end: Date },
  opts: SearchOptions = {},
): Promise<Availability[]> {
  const body = JSON.stringify({
    query: {
      filter: {
        start_at_range: { start_at: window.start.toISOString(), end_at: window.end.toISOString() },
        location_id: locationId,
        segment_filters: [{ service_variation_id: variationId, team_member_id_filter: { any: [teamMemberId] } }],
      },
    },
  });
  const json = await squareCall<SearchResponse>('availability search', `${opts.apiBase ?? SQUARE_API}/v2/bookings/availability/search`, { method: 'POST', token, body }, opts);
  return json.availabilities ?? [];
}

/** What the site uses from one team member booking profile (GET /v2/bookings/team-member-booking-profiles). */
export interface BookingProfile {
  team_member_id: string;
  display_name: string;
  /** false = the barber is not bookable online (Square: Appointments → Staff → "Bookable by customers online"). */
  is_bookable: boolean;
  /** The bio typed in Square (optional; '' when not set). */
  description: string;
}
interface ProfilesResponse extends SquareErrorBody {
  team_member_booking_profiles?: { team_member_id?: string; display_name?: string; is_bookable?: boolean; description?: string }[];
  cursor?: string;
}

/**
 * Every team member booking profile at `locationId` (seller-level read, free plan; checked on both production
 * accounts 2026-10-29). Follows `cursor` (limit 100 per page, at most 20 pages). Same retry policy as
 * searchAvailability; throws SquareApiError (label "booking profiles") otherwise.
 */
export async function listTeamMemberBookingProfiles(token: string, locationId: string, opts: SearchOptions = {}): Promise<BookingProfile[]> {
  const out: BookingProfile[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const q = new URLSearchParams({ location_id: locationId, limit: '100', ...(cursor ? { cursor } : {}) });
    const json = await squareCall<ProfilesResponse>('booking profiles', `${opts.apiBase ?? SQUARE_API}/v2/bookings/team-member-booking-profiles?${q}`, { method: 'GET', token }, opts);
    for (const p of json.team_member_booking_profiles ?? []) {
      if (!p.team_member_id) continue;
      out.push({
        team_member_id: p.team_member_id,
        display_name: (p.display_name ?? '').trim(),
        // Square omits is_bookable only for profiles that are bookable; treat unset as bookable (never hide on doubt).
        is_bookable: p.is_bookable !== false,
        description: (p.description ?? '').trim(),
      });
    }
    cursor = json.cursor || undefined;
    if (++pages >= 20 && cursor) throw new SquareApiError('booking profiles: more than 20 pages, giving up', 0);
  } while (cursor);
  return out;
}

/** team_member_id → profile, for the roster loader and the job. */
export const profilesById = (list: BookingProfile[]): Map<string, BookingProfile> => new Map(list.map((p) => [p.team_member_id, p]));

/* ---------- Pure helpers ---------- */

export interface BookableChoice {
  variation: SquareVariation;
  /** variation.team_member_ids[0]; null = nobody assigned in Square (availability cannot be searched). */
  team_member_id: string | null;
}

const isHaircut = (v: SquareVariation) => /haircut/i.test(v.name);
const byPrice = (a: SquareVariation, b: SquareVariation) => (a.price ?? Infinity) - (b.price ?? Infinity);

/**
 * Which service to ask Square about for a barber (spec §3):
 * 1. only variations bookable online (available_for_booking not false);
 * 2. prefer variations that have a team member assigned (a variation with nobody on it cannot be searched);
 * 3. the standard adult haircut (`standardHaircut` in square.ts: a variation named "Haircut", else the cheapest
 *    "haircut" that is not a kids/senior/long-length service), else the cheapest priced variation whose name
 *    contains "haircut", else the cheapest priced variation, else the first variation in catalog order.
 * The team member is that variation's team_member_ids[0] (a barber item has one barber).
 * Returns null when the item has no bookable variation.
 */
export function pickBookableVariation(item: Pick<SquareItem, 'variations'>): BookableChoice | null {
  const bookable = item.variations.filter((v) => v.available_for_booking);
  if (!bookable.length) return null;
  const staffed = bookable.filter((v) => v.team_member_ids.length > 0);
  const pool = staffed.length ? staffed : bookable;
  const priced = pool.filter((v) => v.price != null && v.price > 0).sort(byPrice);
  const variation = standardHaircut(pool) ?? priced.find(isHaircut) ?? priced[0] ?? pool[0]!;
  return { variation, team_member_id: variation.team_member_ids[0] ?? null };
}

export interface Summary {
  /** Earliest open start time (UTC, second precision), null = nothing open in the window. */
  next: string | null;
  /** Up to the first 3 open start times, ascending. */
  soon: string[];
  /** Open start times on the shop-local calendar day of `now`. */
  slots_today: number;
  /** Open start times in the whole window (from `now` on). */
  slots_7d: number;
}

/** "2026-10-28T20:15:00.000Z" → "2026-10-28T20:15:00Z" (the file format in spec §3). */
export const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Calendar date (YYYY-MM-DD) of `d` in time zone `tz`. */
export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * Square availabilities → what the site shows. Ignores slots before `now` and anything unparsable,
 * de-duplicates identical start times (several segments can share one), sorts ascending.
 */
export function summarise(slots: Availability[], now: Date, tz: string, windowDays = 7): Summary {
  const end = now.getTime() + windowDays * 86400000;
  const times = [...new Set(slots.map((s) => Date.parse(s.start_at)).filter((t) => Number.isFinite(t) && t >= now.getTime() && t <= end))]
    .sort((a, b) => a - b)
    .map((t) => new Date(t));
  const today = localDate(now, tz);
  return {
    next: times[0] ? isoSeconds(times[0]) : null,
    soon: times.slice(0, 3).map(isoSeconds),
    slots_today: times.filter((t) => localDate(t, tz) === today).length,
    slots_7d: times.length,
  };
}

/**
 * Is this team member bookable online? `profiles` = the shop's booking profiles by id, or null when the profiles
 * call failed (unknown: undefined, the job then searches as before). A team member missing from the list counts
 * as bookable (spec §3: never hide a barber on doubt).
 */
export function bookableFrom(profiles: ReadonlyMap<string, Pick<BookingProfile, 'is_bookable'>> | null, teamMemberId: string): boolean | undefined {
  if (!profiles) return undefined;
  return profiles.get(teamMemberId)?.is_bookable ?? true;
}
