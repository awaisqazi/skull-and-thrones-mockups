/**
 * Roster merge: Square says WHO exists (and their name, price, duration); barbers.json (the CMS
 * later) says how they look on the site (slug, headshot, bio, specialties, instagram, sort_order…).
 * Rows are joined on the Square service `item_id`.
 *
 * Pure function, no I/O and no Astro imports, so it is unit-tested with `npm test`
 * (src/lib/roster.test.ts). The content loader in src/content.config.ts calls it.
 */
import type { SquareItem } from './square.ts';

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
}

export interface MergeResult {
  rows: Row[];
  warnings: string[];
  stats: { matched: number; added: number; deactivated: number; passthrough: number };
}

/** Barber = a bookable service item that is not the "Any artist" item, not archived, not retail. */
export function isBarberItem(item: SquareItem, exclude: ReadonlySet<string>): boolean {
  if (exclude.has(item.item_id) || item.is_archived || !item.name) return false;
  return item.product_type == null || item.product_type === 'APPOINTMENTS_SERVICE';
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

export function mergeRoster({ rows, square: input, excludeItemIds = [], maxDeactivateShare = 0.5 }: MergeInput): MergeResult {
  const exclude = new Set(excludeItemIds);
  const warnings: string[] = [];
  const stats = { matched: 0, added: 0, deactivated: 0, passthrough: 0 };

  const square: Partial<Record<string, SquareItem[]>> = {};
  const allIds = new Set(Object.values(input).flatMap((items) => (items ?? []).filter((i) => isBarberItem(i, exclude)).map((i) => i.item_id)));
  for (const [location, items] of Object.entries(input)) {
    const active = rows.filter((r) => r.location === location && r.is_active !== false);
    const gone = active.filter((r) => !allIds.has(r.item_id)).length;
    if (active.length >= 4 && gone / active.length > maxDeactivateShare) {
      warnings.push(`${location}: Square would hide ${gone} of ${active.length} barbers at once; ignoring Square for this shop (check the token and square_location_id).`);
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
        haircut_from: dollars(item.price_from) ?? row.haircut_from,
        duration_minutes: item.duration_minutes ?? row.duration_minutes,
        square_note: item.description || row.square_note,
        needs_profile: false,
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
    const slug = uniqueSlug(slugify(item.name), taken, `barber-${id.toLowerCase()}`);
    nextSort[location] = (nextSort[location] ?? 0) + 1;
    stats.added++;
    warnings.push(`${slug}: new in Square (${location}, item ${id}); needs photo + bio. Add a barbers.json row with this item_id.`);
    out.push({
      slug,
      name: item.name,
      location,
      tier: 'barber',
      role: 'Barber',
      ...(dollars(item.price_from) != null ? { haircut_from: dollars(item.price_from) } : {}),
      ...(item.duration_minutes != null ? { duration_minutes: item.duration_minutes } : {}),
      item_id: id,
      specialties: [],
      bio: '',
      accepting_new_clients: true,
      sort_order: nextSort[location],
      is_active: true,
      ...(item.description ? { square_note: item.description } : {}),
      needs_profile: true,
      placeholder_fields: ['role', 'bio', 'specialties', 'headshot'],
    });
  }
  return { rows: out, warnings, stats };
}
