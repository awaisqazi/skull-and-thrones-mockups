/**
 * Shop hours from Square (build time only, never imported by client code).
 *
 * GET /v2/locations/<id> returns `business_hours.periods[] = { day_of_week: "MON", start_local_time: "10:00:00",
 * end_local_time: "19:00:00" }` and `timezone`. `periodsToHours` turns those into the site's `hours[]` shape
 * (the same one locations.json uses: `{ label, days[0=Sunday], opens "HH:MM", closes "HH:MM" }`) so the
 * location cards, the structured data and the "Open now" script need no change. `resolveHours` decides, per shop,
 * whether Square's hours or the file's hours win. Pure helpers are unit-tested in square-locations.test.ts.
 *
 * No Astro imports, so `node --test` loads it directly (Node strips the types).
 */
import { SQUARE_API, SquareApiError, squareCall, type ListOptions } from './square.ts';

/** The timezone the site's "Open now" script assumes (src/scripts/app.ts). */
export const SITE_TIMEZONE = 'America/Chicago';

export interface SquarePeriod { day_of_week?: string; start_local_time?: string; end_local_time?: string }
export interface SquareLocation {
  id: string;
  name?: string;
  timezone?: string;
  status?: string;
  business_hours?: { periods?: SquarePeriod[] };
}
export interface HoursRow { label: string; days: number[]; opens: string; closes: string }

/* ---------- Fetch ---------- */

/**
 * GET /v2/locations/<id> for the merchant that owns `token`, through the shared `squareCall` (retries on 429/5xx/
 * network, strict JSON bodies). Throws SquareApiError (message carries the HTTP status, never the token) so the
 * caller can fall back; the content loader never lets this fail the build.
 */
export async function fetchLocation(token: string, locationId: string, opts: ListOptions = {}): Promise<SquareLocation> {
  const label = `Square location ${locationId}`;
  const body = await squareCall<{ location?: unknown }>(label, `${opts.apiBase ?? SQUARE_API}/v2/locations/${encodeURIComponent(locationId)}`, { method: 'GET', token }, opts);
  const loc = body.location;
  if (typeof loc !== 'object' || loc === null || Array.isArray(loc)) throw new SquareApiError(`${label} failed (HTTP 200): no location in response`, 200);
  return loc as SquareLocation;
}

/* ---------- Periods -> hours[] ---------- */

/** Square day codes → locations.json numbering (0 = Sunday). */
const DAY_NUMBER: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
/** Week order used for labels and rows: Monday first, Sunday last (how the site shows hours today). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "10:00:00" / "10:00" / "9:00" → minutes after midnight, or null when it is not a time. */
function minutesOf(t: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  return h > 24 || mm > 59 || (h === 24 && mm > 0) ? null : h * 60 + mm;
}
const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** "Mon – Fri" for a run, "Saturday"/"Sunday" for a lone weekend day, "Tue" for any other lone day. */
function labelFor(days: number[]): string {
  if (days.length === 1) {
    const d = days[0]!;
    return d === 6 || d === 0 ? LONG[d]! : SHORT[d]!;
  }
  return `${SHORT[days[0]!]} – ${SHORT[days[days.length - 1]!]}`;
}

export interface PeriodsResult {
  hours: HoursRow[];
  warnings: string[];
  /** Periods dropped as unusable (bad day, unreadable time, close not after open). resolveHours keeps the file hours when > 0. */
  skipped: number;
}

/**
 * Converts Square's weekly periods into the site's hours rows.
 * - Consecutive days (Monday-first) with identical open/close times become one row.
 * - Two or more periods on one day (a lunch break): earliest open to latest close, plus a warning.
 * - A close of 00:00 (midnight) is shown as 23:59 with a warning; any other close that is not after the open,
 *   a bad day code or a bad time is skipped with a warning (so that day shows as closed, never wrongly open).
 * - `tz` other than the site's clock (America/Chicago) adds a warning: the "Open now" script would be off.
 */
export function periodsToHours(periods: SquarePeriod[] | undefined | null, tz?: string | null): PeriodsResult {
  const warnings: string[] = [];
  let skipped = 0;
  if (tz && tz !== SITE_TIMEZONE) warnings.push(`timezone is ${tz}, the site's "Open now" clock is ${SITE_TIMEZONE}`);

  const byDay = new Map<number, { open: number; close: number }[]>();
  for (const p of Array.isArray(periods) ? periods : []) {
    const day = DAY_NUMBER[String(p?.day_of_week ?? '').toUpperCase()];
    if (day === undefined) { warnings.push(`unknown day "${p?.day_of_week}", skipped`); skipped++; continue; }
    const open = minutesOf(p.start_local_time);
    let close = minutesOf(p.end_local_time);
    if (open === null || close === null) { warnings.push(`${LONG[day]}: unreadable times (${p.start_local_time}–${p.end_local_time}), skipped`); skipped++; continue; }
    if ((close === 0 || close === 24 * 60) && open > 0) {
      warnings.push(`${LONG[day]}: closes at midnight, shown as 23:59`);
      close = 24 * 60 - 1;
    }
    if (close <= open) { warnings.push(`${LONG[day]}: closes (${hhmm(close)}) before it opens (${hhmm(open)}), skipped`); skipped++; continue; }
    byDay.set(day, [...(byDay.get(day) ?? []), { open, close }]);
  }

  const perDay = new Map<number, { open: number; close: number }>();
  for (const [day, list] of byDay) {
    if (list.length > 1) {
      const shifts = [...list].sort((a, b) => a.open - b.open).map((s) => `${hhmm(s.open)}–${hhmm(s.close)}`).join(', ');
      warnings.push(`${LONG[day]} has split shifts (${shifts}); showing earliest open to latest close`);
    }
    perDay.set(day, { open: Math.min(...list.map((s) => s.open)), close: Math.max(...list.map((s) => s.close)) });
  }

  const hours: HoursRow[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const t = perDay.get(run[0]!)!;
    hours.push({ label: labelFor(run), days: run, opens: hhmm(t.open), closes: hhmm(t.close) });
    run = [];
  };
  for (const day of WEEK_ORDER) {
    const t = perDay.get(day);
    if (!t) { flush(); continue; }
    const prev = run.length ? perDay.get(run[run.length - 1]!)! : null;
    if (prev && (prev.open !== t.open || prev.close !== t.close)) flush();
    run.push(day);
  }
  flush();
  return { hours, warnings, skipped };
}

/* ---------- Short status text ---------- */

/**
 * The line shown next to the shop name before the live "Open now" status takes over.
 * Every day covered → `current` (the file's text, "Open 7 days"). Otherwise "Closed Mondays",
 * "Closed Sundays & Mondays", or abbreviations for three or more ("Closed Sun, Mon & Tue").
 * No rows at all → `current` (never claim "closed" from missing data).
 */
export function hoursShort(hours: Pick<HoursRow, 'days'>[], current = 'Open 7 days'): string {
  const open = new Set(hours.flatMap((h) => h.days));
  if (!open.size) return current;
  const closed = WEEK_ORDER.filter((d) => !open.has(d));
  if (!closed.length) return current;
  if (closed.length === 1) return `Closed ${LONG[closed[0]!]}s`;
  if (closed.length === 2) return `Closed ${LONG[closed[0]!]}s & ${LONG[closed[1]!]}s`;
  const names = closed.map((d) => SHORT[d]!);
  return `Closed ${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/* ---------- Square vs file ---------- */

export interface ResolvedHours {
  hours: HoursRow[];
  hours_short: string;
  hours_source: 'site' | 'square';
  warnings: string[];
  /** Plain-language reason when the file's hours were kept (not a warning: Addison has none set today). */
  note?: string;
}

/**
 * Square's hours when the Square location has fully usable `business_hours.periods`, else the file's hours.
 * The file wins on ANY doubt (QA 2026-10-28): a period that had to be skipped, a timezone other than the site's
 * clock (America/Chicago), or no usable day left. Split shifts and a midnight close are well defined and still apply.
 * Warnings are returned either way. `square` null = the fetch failed or no token (the caller logs that).
 */
export function resolveHours(file: { hours: HoursRow[]; hours_short: string }, square: SquareLocation | null): ResolvedHours {
  const keep = (note?: string, warnings: string[] = []): ResolvedHours => ({ hours: file.hours, hours_short: file.hours_short, hours_source: 'site', warnings, note });
  if (!square) return keep();
  const periods = square.business_hours?.periods;
  if (!Array.isArray(periods) || !periods.length) return keep('no business hours set in Square');
  const { hours, warnings, skipped } = periodsToHours(periods, square.timezone);
  if (!hours.length) return keep('Square business hours unusable', [...warnings, 'no usable periods, keeping the file hours']);
  if (skipped) return keep('Square business hours partly unusable', [...warnings, `${skipped} period(s) unusable, keeping the file hours`]);
  if (square.timezone && square.timezone !== SITE_TIMEZONE) return keep('Square location is in another timezone', [...warnings, 'keeping the file hours']);
  return { hours, hours_short: hoursShort(hours, file.hours_short), hours_source: 'square', warnings };
}
