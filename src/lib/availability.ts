/**
 * Live availability: display rules for the availability.json the 15-minute job writes (spec §3).
 *
 * Pure and dependency-free, so the same code runs at build time (the baked src/data/availability.json,
 * imported by the components) and in the browser (src/scripts/availability.ts with the live file).
 * Unit-tested in availability.test.ts.
 *
 *   next opening within 48 h  → green  "Next: Today 3:15 PM" / "Next: Tomorrow 10:00 AM" / "Next: Thu 9:00 AM"
 *   next opening in 2–7 days  → amber  "Next: Thu 11:30 AM"
 *   nothing open in 7 days    → grey   "Booked up this week"
 *   no data                   → null   (nothing rendered): no token, shop error, data older than 2 h,
 *                                       barber not in the file, or every listed time already passed
 */

export const TZ = 'America/Chicago';
/** A shop's data counts for this long after its last good fetch (spec §2.3, §3). */
export const STALE_MS = 2 * 60 * 60 * 1000;
const H48 = 48 * 60 * 60 * 1000;

/** Where the job publishes the file (branch `data`). Overridden at build by PUBLIC_AVAILABILITY_URL. */
export const DEFAULT_LIVE_URL = 'https://raw.githubusercontent.com/awaisqazi/skull-and-thrones-mockups/data/availability.json';

/* ---------- File shape (spec §3) ---------- */
export interface BarberAvailability {
  variation_id?: string;
  team_member_id?: string;
  /** null = nothing open in the window; absent = no data for this barber (see `error`). */
  next?: string | null;
  soon?: string[];
  slots_today?: number;
  slots_7d?: number;
  /** Why this barber has no data (no team member on the service, API error…). */
  error?: string;
}
export interface ShopAvailability {
  /** Time of the last GOOD fetch. A failed run keeps the previous value (and the previous barbers). */
  fetched_at?: string;
  ok: boolean;
  error?: string;
  barbers?: Record<string, BarberAvailability>;
}
export interface AvailabilityFile {
  generated_at: string | null;
  window_days: number;
  tz: string;
  shops: Record<string, ShopAvailability>;
}

export const EMPTY_FILE: AvailabilityFile = { generated_at: null, window_days: 7, tz: TZ, shops: {} };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Tolerant reader: anything that is not shaped like the file becomes EMPTY_FILE (never throws). */
export function parseFile(x: unknown): AvailabilityFile {
  if (!isObj(x) || !isObj(x.shops)) return EMPTY_FILE;
  return {
    generated_at: typeof x.generated_at === 'string' ? x.generated_at : null,
    window_days: typeof x.window_days === 'number' ? x.window_days : 7,
    tz: typeof x.tz === 'string' ? x.tz : TZ,
    shops: x.shops as Record<string, ShopAvailability>,
  };
}

/** The more recent of two files (by generated_at); `a` wins ties and unknowns. */
export function newer(a: AvailabilityFile, b: AvailabilityFile): AvailabilityFile {
  const ta = Date.parse(a.generated_at ?? ''), tb = Date.parse(b.generated_at ?? '');
  return Number.isFinite(tb) && (!Number.isFinite(ta) || tb > ta) ? b : a;
}

/** Only what the page needs (embedded in the HTML for the browser script): drops ids and diagnostics. */
export function slimFile(f: AvailabilityFile): AvailabilityFile {
  const shops: Record<string, ShopAvailability> = {};
  for (const [slug, s] of Object.entries(f.shops)) {
    const barbers: Record<string, BarberAvailability> = {};
    for (const [id, b] of Object.entries(s.barbers ?? {})) if (Array.isArray(b.soon)) barbers[id] = { next: b.next ?? null, soon: b.soon };
    shops[slug] = { ok: s.ok, ...(s.fetched_at ? { fetched_at: s.fetched_at } : {}), barbers };
  }
  return { ...f, shops };
}

/* ---------- Time formatting (shop-local) ---------- */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) fmtCache.set(key, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts })));
  return f;
}
/** Newer ICU puts a narrow no-break space before AM/PM; keep plain spaces so text and tests are stable. */
const spaces = (s: string) => s.replace(/[  ]/g, ' ');

/** Days between the shop-local calendar dates of `now` and `d` (0 = same day). */
function dayDiff(d: Date, now: Date, tz: string): number {
  const ymd = (x: Date) => {
    const p = fmt(tz, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(x);
    const n = (t: string) => Number(p.find((q) => q.type === t)!.value);
    return Date.UTC(n('year'), n('month') - 1, n('day'));
  };
  return Math.round((ymd(d) - ymd(now)) / 86400000);
}

/** "3:15 PM" in the shop's time zone. */
export const clock = (d: Date, tz = TZ) => spaces(fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(d));

/** "Today 3:15 PM" / "Tomorrow 10:00 AM" / "Thu 11:30 AM" / "Wed Nov 4 9:00 AM" (6+ days out, so a weekday never reads as this week's). */
export function slotLabel(iso: string, now: Date, tz = TZ): string {
  const d = new Date(iso);
  const diff = dayDiff(d, now, tz);
  const day = diff === 0 ? 'Today'
    : diff === 1 ? 'Tomorrow'
    : diff >= 6 ? spaces(fmt(tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(d)).replace(',', '')
    : fmt(tz, { weekday: 'short' }).format(d);
  return `${day} ${clock(d, tz)}`;
}

/* ---------- Display rules ---------- */

export type DotState = 'green' | 'amber' | 'grey';
export interface Slot { iso: string; label: string }
export interface BarberView {
  state: DotState;
  /** Chip text: "Next: Today 3:15 PM" or "Booked up this week". */
  text: string;
  /** Earliest upcoming opening, null when booked up. */
  next: Slot | null;
  /** Up to 3 upcoming openings (barber page list). */
  soon: Slot[];
}

/** A shop block is usable while its last good fetch is under 2 h old (ok:false with a fresh block still counts). */
export function shopIsFresh(shop: ShopAvailability | undefined, now: Date): shop is ShopAvailability {
  if (!shop?.barbers || !shop.fetched_at) return false;
  const age = now.getTime() - Date.parse(shop.fetched_at);
  return Number.isFinite(age) && age <= STALE_MS && age > -STALE_MS;
}

/** What to show for one barber, or null for "show nothing" (spec §3 "no data"). */
export function barberView(file: AvailabilityFile, shopSlug: string, itemId: string, now: Date): BarberView | null {
  const shop = file.shops[shopSlug];
  if (!shopIsFresh(shop, now)) return null;
  const b = shop.barbers![itemId];
  if (!b || !Array.isArray(b.soon) || b.next === undefined) return null;
  const tz = file.tz || TZ;
  if (b.next === null) return { state: 'grey', text: 'Booked up this week', next: null, soon: [] };
  const upcoming = [...new Set([b.next, ...b.soon])]
    .map((iso) => ({ iso, t: Date.parse(iso) }))
    .filter((x) => Number.isFinite(x.t) && x.t >= now.getTime())
    .sort((x, y) => x.t - y.t)
    .slice(0, 3)
    .map(({ iso }) => ({ iso, label: slotLabel(iso, now, tz) }));
  // Every listed time is already in the past (data up to 2 h old): we do not know the next one, so say nothing.
  if (!upcoming.length) return null;
  const first = upcoming[0]!;
  return {
    state: Date.parse(first.iso) - now.getTime() <= H48 ? 'green' : 'amber',
    text: `Next: ${first.label}`,
    next: first,
    soon: upcoming,
  };
}

/** /book "First open chair": the barber (of `itemIds`, the shop's site roster) with the earliest upcoming opening. */
export function firstOpenChair(file: AvailabilityFile, shopSlug: string, itemIds: string[], now: Date): { item_id: string; view: BarberView } | null {
  let best: { item_id: string; view: BarberView } | null = null;
  for (const id of itemIds) {
    const view = barberView(file, shopSlug, id, now);
    if (!view?.next) continue;
    if (!best || Date.parse(view.next.iso) < Date.parse(best.view.next!.iso)) best = { item_id: id, view };
  }
  return best;
}

/**
 * Copy for the shop-set `accepting_new_clients` switch (CMS-controlled, NOT live availability).
 * Relabelled from "Accepting new clients" / "Booked up" so it is never confused with the live dot.
 */
export const NEW_CLIENTS = {
  yes: { label: 'New clients welcome', tip: 'Set by the shop: this barber is taking new clients. Live open times come from Square.' },
  no: { label: 'Existing clients only', tip: 'Set by the shop: this barber is not taking new clients right now. Existing clients can still book in Square.' },
} as const;
