/**
 * Roster merge: Square says WHO exists (and their name, price, duration); barbers.json (the CMS
 * later) says how they look on the site (slug, headshot, bio, specialties, instagram, sort_order…).
 * Rows are joined on the Square service `item_id`. Optionally, Square team member booking profiles supply
 * a bio for rows that have none (`profiles`, see `squareBio`).
 *
 * Headshots (spec §4): Square item image → Square staff profile photo → the row's own `headshot` (barbers.json /
 * CMS) and, at render time, the local file in src/assets/headshots → placeholder. A Square photo sets
 * `headshot` to its https URL and `headshot_source: 'square'` (see `squarePhoto`); the renderers
 * (BarberCard.astro, barbers/[slug].astro via `headshotFor` in localImages.ts) put a 'square' headshot ahead of
 * the local file, so a hand-placed file only shows when Square has no photo.
 *
 * Pure functions, no I/O and no Astro imports, so they are unit-tested with `npm test`
 * (src/lib/roster.test.ts). The content loader in src/content.config.ts calls `mergeRosterCheckingPhotos`
 * with the HEAD pre-check from square-photos.ts injected.
 */
import { standardHaircut, type SquareItem } from './square.ts';
import { isSquarePhotoUrl, type PhotoCheck } from './square-photos.ts';

export type Row = Record<string, unknown> & { slug: string; name: string; location: string; item_id: string };

export interface MergeInput {
  /** barbers.json rows, in file order. */
  rows: Row[];
  /** Square items per location slug. Only locations that were fetched successfully; others pass through unchanged. */
  square: Partial<Record<string, SquareItem[]>>;
  /** Item ids that are not barbers (each location's "Any artist available" item). */
  excludeItemIds?: string[];
  /**
   * Safety valve for the nightly build: if Square would hide more than this share of a shop's
   * active barbers at once (wrong token/location, permissions), ignore Square for that shop.
   * Default 0.5. Set 1 to disable.
   */
  maxDeactivateShare?: number;
  /**
   * Second safety valve: more than this many barbers new to barbers.json in one shop in one build (a catalog shape
   * change, retail items read as services…) ignores Square for that shop, like the share rule. Default 5.
   */
  maxNewcomers?: number;
  /**
   * Square team member booking profiles by team_member_id (GET /v2/bookings/team-member-booking-profiles, via
   * listTeamMemberBookingProfiles in bookings.ts). Only `description` (the bio typed in Square) is used: it fills
   * the bio of a matched or new row whose barbers.json bio is empty (or still flagged placeholder). Absent = no bios.
   * `profile_image_url` (the staff photo) is the second headshot source after the item image (`squarePhoto`);
   * `display_name` picks the right team member on a service several people perform.
   */
  profiles?: ReadonlyMap<string, { description?: string; profile_image_url?: string | null; display_name?: string }>;
  /** Square photo URLs that failed the build's HEAD pre-check: treated as absent (the next source is tried). */
  rejectPhotos?: ReadonlySet<string>;
}

export interface MergeResult {
  rows: Row[];
  warnings: string[];
  stats: { matched: number; added: number; deactivated: number; passthrough: number };
  /** slug → which Square slot supplied the headshot ('item' image or staff 'profile' photo), for the build log. */
  photos: Record<string, 'item' | 'profile'>;
}

/** Square's "No Show" fee item is an APPOINTMENTS_SERVICE too (both production accounts have one). */
const NOT_A_BARBER = /^no[ -]?shows?$/i;

/**
 * Barber = an APPOINTMENTS_SERVICE item (Square omits product_type on old REGULAR retail items, so a missing type is
 * NOT a barber) that is not the "Any artist" item, not archived, not the no-show fee, and has at least one variation
 * customers can book online (a fee-only item has none).
 */
export function isBarberItem(item: SquareItem, exclude: ReadonlySet<string>): boolean {
  if (exclude.has(item.item_id) || item.is_archived || !item.name || NOT_A_BARBER.test(item.name.trim())) return false;
  if (item.product_type !== 'APPOINTMENTS_SERVICE') return false;
  // Items from the roster tests/fixtures carry no variations; only reject when Square listed some and none is bookable.
  return !item.variations?.length || item.variations.some((v) => v.available_for_booking);
}

export function slugify(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function uniqueSlug(base: string, taken: Set<string>, fallback: string): string {
  const root = base || fallback;
  let slug = root;
  for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
  taken.add(slug);
  return slug;
}

const dollars = (price: number | null) => (price != null && price > 0 ? Math.round(price) : undefined);
/** "Haircuts from $X": the standard adult haircut's price, else Square's cheapest variation. */
const haircutFrom = (item: SquareItem) => dollars(standardHaircut(item.variations ?? [])?.price ?? item.price_from);
/** Minutes of that same service. */
const haircutMinutes = (item: SquareItem) => standardHaircut(item.variations ?? [])?.duration_minutes ?? item.duration_minutes;

/** Square bios are free text typed in the dashboard: one paragraph, at most this many characters. */
export const BIO_MAX = 400;

/** Trim, collapse whitespace (newlines included), cap at BIO_MAX on a word boundary with an ellipsis. '' when empty. */
export function cleanBio(text: string | undefined | null): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= BIO_MAX) return t;
  const cut = t.slice(0, BIO_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > BIO_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

/**
 * The bio Square holds for this barber item: the description of the team member on the standard-haircut
 * variation (the same service the price and availability use), else on the first variation that has a team
 * member. '' when there is none.
 */
export function squareBio(item: Pick<SquareItem, 'variations'>, profiles: ReadonlyMap<string, { description?: string }> | undefined): string {
  if (!profiles?.size) return '';
  const vars = item.variations ?? [];
  const tm = standardHaircut(vars)?.team_member_ids[0] ?? vars.find((v) => v.team_member_ids.length)?.team_member_ids[0];
  return tm ? cleanBio(profiles.get(tm)?.description) : '';
}

/** A barbers.json bio Square may fill: empty, or still invented placeholder copy (which never renders). */
const bioIsOpen = (row: Row) => !String(row.bio ?? '').trim() || (Array.isArray(row.placeholder_fields) && row.placeholder_fields.includes('bio'));

/** Row fields when Square supplies the bio: the text, its source, and 'bio' no longer a placeholder field. */
function withSquareBio(row: Row, bio: string): Partial<Row> {
  if (!bio || !bioIsOpen(row)) return {};
  const placeholder = Array.isArray(row.placeholder_fields) ? (row.placeholder_fields as string[]).filter((f) => f !== 'bio') : undefined;
  return { bio, bio_source: 'square', ...(placeholder ? { placeholder_fields: placeholder } : {}) };
}

type Profiles = NonNullable<MergeInput['profiles']>;

/**
 * The team member whose staff photo may stand for this barber item: the team member on the standard-haircut
 * variation (else on the first variation with one) when there is exactly one; when several people perform it,
 * the one whose profile display name starts with the item name's first word, if exactly one does. Otherwise
 * undefined: a shared service must never show a colleague's face.
 */
export function photoTeamMember(item: Pick<SquareItem, 'name' | 'variations'>, profiles: Profiles | undefined): string | undefined {
  const vars = item.variations ?? [];
  const haircut = standardHaircut(vars)?.team_member_ids;
  const ids = haircut?.length ? haircut : vars.find((v) => v.team_member_ids.length)?.team_member_ids ?? [];
  if (ids.length === 1) return ids[0];
  const first = (s: string | undefined) => (s ?? '').trim().split(/\s+/)[0]!.toLowerCase();
  const want = first(item.name);
  const named = want ? ids.filter((id) => first(profiles?.get(id)?.display_name) === want) : [];
  return named.length === 1 ? named[0] : undefined;
}

export interface SquarePhoto { url: string; from: 'item' | 'profile' }

/**
 * The headshot Square holds for this barber item: the item image (`image_url`), else the staff profile photo of
 * `photoTeamMember`. A URL that is not an absolute https URL on a Square photo host (`isSquarePhotoUrl`) is
 * ignored with a warning pushed to `warnings`; a URL in `reject` (failed the HEAD pre-check) is skipped quietly.
 * null = Square has no usable photo.
 */
export function squarePhoto(
  item: Pick<SquareItem, 'name' | 'variations' | 'image_url'>, profiles: Profiles | undefined,
  { reject, warnings, label }: { reject?: ReadonlySet<string>; warnings?: string[]; label?: string } = {},
): SquarePhoto | null {
  const tm = photoTeamMember(item, profiles);
  const candidates: [string | null | undefined, SquarePhoto['from']][] = [[item.image_url, 'item'], [tm ? profiles?.get(tm)?.profile_image_url : null, 'profile']];
  for (const [url, from] of candidates) {
    if (url == null || url === '') continue;
    if (!isSquarePhotoUrl(url)) {
      warnings?.push(`${label ?? item.name}: Square ${from === 'item' ? 'item image' : 'staff photo'} ignored (not an https URL on a Square photo host): ${String(url).slice(0, 120)}`);
      continue;
    }
    if (reject?.has(url)) continue;
    return { url, from };
  }
  return null;
}

/** Row fields when Square supplies the headshot: the URL, its source, and 'headshot' no longer a placeholder field. */
function withSquarePhoto(row: Row, photo: SquarePhoto | null): Partial<Row> {
  if (!photo) return {};
  const placeholder = Array.isArray(row.placeholder_fields) ? (row.placeholder_fields as string[]).filter((f) => f !== 'headshot') : undefined;
  return { headshot: photo.url, headshot_source: 'square', ...(placeholder ? { placeholder_fields: placeholder } : {}) };
}

export function mergeRoster({ rows, square: input, excludeItemIds = [], maxDeactivateShare = 0.5, maxNewcomers = 5, profiles, rejectPhotos }: MergeInput): MergeResult {
  const exclude = new Set(excludeItemIds);
  const warnings: string[] = [];
  const stats = { matched: 0, added: 0, deactivated: 0, passthrough: 0 };
  const photos: MergeResult['photos'] = {};
  const photoFor = (slug: string, item: SquareItem) => {
    const p = squarePhoto(item, profiles, { reject: rejectPhotos, warnings, label: slug });
    if (p) photos[slug] = p.from;
    return p;
  };

  const square: Partial<Record<string, SquareItem[]>> = {};
  const allIds = new Set(Object.values(input).flatMap((items) => (items ?? []).filter((i) => isBarberItem(i, exclude)).map((i) => i.item_id)));
  for (const [location, items] of Object.entries(input)) {
    const active = rows.filter((r) => r.location === location && r.is_active !== false);
    const gone = active.filter((r) => !allIds.has(r.item_id)).length;
    if (active.length >= 4 && gone / active.length > maxDeactivateShare) {
      warnings.push(`${location}: Square would hide ${gone} of ${active.length} barbers at once; ignoring Square for this shop (check the token and square_location_id).`);
      continue;
    }
    const known = new Set(rows.map((r) => r.item_id));
    const fresh = new Set((items ?? []).filter((i) => isBarberItem(i, exclude) && !known.has(i.item_id)).map((i) => i.item_id)).size;
    if (fresh > maxNewcomers) {
      warnings.push(`${location}: Square lists ${fresh} barbers that are not in barbers.json (more than ${maxNewcomers}); ignoring Square for this shop (check the catalog: retail items or a shape change?).`);
      continue;
    }
    square[location] = items;
  }

  // item_id → { location, item } across every fetched location (barber items only).
  const live = new Map<string, { location: string; item: SquareItem }>();
  for (const [location, items] of Object.entries(square)) {
    for (const item of items ?? []) if (isBarberItem(item, exclude) && !live.has(item.item_id)) live.set(item.item_id, { location, item });
  }
  const fetched = new Set(Object.keys(square));
  const seen = new Set<string>();
  const taken = new Set(rows.map((r) => r.slug));

  const out: Row[] = rows.map((row) => {
    const hit = live.get(row.item_id);
    if (hit) {
      seen.add(row.item_id);
      stats.matched++;
      const { item, location } = hit;
      if (location !== row.location) warnings.push(`${row.slug}: barbers.json says ${row.location} but Square lists item ${row.item_id} at ${location}; using Square.`);
      if (item.name && item.name !== row.name) warnings.push(`${row.slug}: name "${row.name}" in barbers.json, "${item.name}" in Square; using Square.`);
      return {
        ...row,
        name: item.name || row.name,
        location,
        haircut_from: haircutFrom(item) ?? row.haircut_from,
        duration_minutes: haircutMinutes(item) ?? row.duration_minutes,
        square_note: item.description || row.square_note,
        needs_profile: false,
        ...withSquareBio(row, squareBio(item, profiles)),
        ...withSquarePhoto(row, photoFor(row.slug, item)),
      };
    }
    if (!fetched.has(row.location)) {
      stats.passthrough++;
      return row;
    }
    // Its shop was fetched but the item is gone: hide it rather than ship a dead booking link.
    if (row.is_active !== false) {
      stats.deactivated++;
      warnings.push(`${row.slug}: item ${row.item_id} is no longer in Square (${row.location}); marked is_active: false. Remove or re-link the row.`);
    }
    return { ...row, is_active: false };
  });

  // In Square, not in barbers.json: render with the placeholder headshot and no bio until the CMS row exists.
  const newcomers = [...live.entries()].filter(([id]) => !seen.has(id));
  const nextSort: Record<string, number> = {};
  for (const r of out) {
    const s = typeof r.sort_order === 'number' ? r.sort_order : 0;
    nextSort[r.location] = Math.max(nextSort[r.location] ?? 0, s);
  }
  for (const [id, { location, item }] of newcomers) {
    const slug = uniqueSlug(slugify(item.name), taken, `barber-${slugify(id) || "item"}`);
    nextSort[location] = (nextSort[location] ?? 0) + 1;
    stats.added++;
    warnings.push(`${slug}: new in Square (${location}, item ${id}); needs photo + bio. Add a barbers.json row with this item_id.`);
    const fresh: Row = {
      slug,
      name: item.name,
      location,
      tier: 'barber',
      role: 'Barber',
      ...(haircutFrom(item) != null ? { haircut_from: haircutFrom(item) } : {}),
      ...(haircutMinutes(item) != null ? { duration_minutes: haircutMinutes(item) } : {}),
      item_id: id,
      specialties: [],
      bio: '',
      accepting_new_clients: true,
      sort_order: nextSort[location],
      is_active: true,
      ...(item.description ? { square_note: item.description } : {}),
      needs_profile: true,
      placeholder_fields: ['role', 'bio', 'specialties', 'headshot'],
    };
    const withBio = { ...fresh, ...withSquareBio(fresh, squareBio(item, profiles)) };
    out.push({ ...withBio, ...withSquarePhoto(withBio, photoFor(slug, item)) });
  }
  return { rows: out, warnings, stats, photos };
}

/**
 * mergeRoster plus the build's photo pre-check (spec §4): every Square headshot URL the merge picked is passed
 * to `check` (the loader injects `checkPhotos` from square-photos.ts: HEAD, 8 s timeout, 4 in flight); a URL that
 * fails is added to `rejectPhotos` and the merge runs again, so that barber falls to the next source (item image
 * → staff photo → barbers.json headshot / local file → placeholder). Each URL is checked once; it ends when a
 * merge picks no unchecked URL. `photoWarnings` has one line per failed photo. Never throws (a `check` that
 * throws counts as every URL in that batch failing).
 */
export async function mergeRosterCheckingPhotos(input: MergeInput, check: (urls: string[]) => Promise<PhotoCheck[]>): Promise<MergeResult & { photoWarnings: string[] }> {
  const rejected = new Set(input.rejectPhotos ?? []);
  const checked = new Set<string>();
  const photoWarnings: string[] = [];
  for (;;) {
    const merged = mergeRoster({ ...input, rejectPhotos: rejected });
    const bySlugs = new Map<string, string[]>();
    for (const r of merged.rows) {
      if (r.headshot_source !== 'square' || typeof r.headshot !== 'string' || checked.has(r.headshot)) continue;
      bySlugs.set(r.headshot, [...(bySlugs.get(r.headshot) ?? []), r.slug]);
    }
    const todo = [...bySlugs.keys()];
    if (!todo.length) return { ...merged, photoWarnings };
    let results: PhotoCheck[];
    try {
      results = await check(todo);
    } catch (e) {
      results = todo.map((url) => ({ url, ok: false, reason: `pre-check failed (${(e as Error)?.message ?? e})` }));
    }
    const byUrl = new Map(results.map((r) => [r.url, r]));
    for (const url of todo) {
      checked.add(url);
      const r = byUrl.get(url) ?? { url, ok: false, reason: 'not checked' };
      if (r.ok) continue;
      rejected.add(url);
      photoWarnings.push(`${bySlugs.get(url)!.join(', ')}: Square photo failed the pre-check (${r.reason}); falling back to the next source (staff photo, else the local file). ${url}`);
    }
  }
}
