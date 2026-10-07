/**
 * The only module pages import data from. Reads content collections (src/content.config.ts),
 * applies the CMS rules (active only, sort_order) and derives booking URLs.
 */
import { getCollection, type CollectionEntry } from 'astro:content';
import { placeholder } from './placeholder';
import { url } from './url';

export type LocationSlug = CollectionEntry<'locations'>['data']['slug'];
export type Location = CollectionEntry<'locations'>['data'] & {
  any_artist_url: string;
  address_line: string;
  maps_dir_url: string;
  maps_embed_url: string;
  maps_url: string;
  href: string;
};
export type Barber = CollectionEntry<'barbers'>['data'] & {
  booking_url: string;
  href: string;
  first_name: string;
  initials: string;
  headshot_src: string;
};
export type PortfolioItem = CollectionEntry<'portfolio'>['data'] & {
  id: string;
  src: string;
  full: string;
  barber_name: string;
  barber_first: string;
  barber_href: string;
  booking_url: string;
};

/** Square: per-barber deep link = location services page + '/' + item id. */
export function buildBookingUrl(base: string, itemId: string): string {
  return `${base.replace(/\/$/, '')}/${itemId}`;
}

const q = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');

export async function getLocations(): Promise<Location[]> {
  const rows = await getCollection('locations');
  return rows
    .map(({ data }) => ({
      ...data,
      any_artist_url: buildBookingUrl(data.square_booking_url, data.any_artist_item_id),
      address_line: `${data.street}, ${data.city}, ${data.region} ${data.postal_code}`,
      maps_dir_url: `https://www.google.com/maps/dir/?api=1&destination=${q(data.map_query)}`,
      maps_embed_url: `https://www.google.com/maps?q=${q(data.map_query)}&output=embed`,
      maps_url: `https://www.google.com/maps?q=${q(data.map_query)}`,
      href: url(`${data.slug}/`),
    }))
    .sort((a, b) => a.sort_order - b.sort_order);
}

export async function getLocationMap(): Promise<Record<LocationSlug, Location>> {
  const list = await getLocations();
  return Object.fromEntries(list.map((l) => [l.slug, l])) as Record<LocationSlug, Location>;
}

const initialsOf = (name: string) =>
  name.split(/\s+/).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

export async function getBarbers(location?: LocationSlug): Promise<Barber[]> {
  const locs = await getLocationMap();
  const rows = await getCollection('barbers', ({ data }) => data.is_active && (!location || data.location === location));
  return rows
    .map(({ data }) => ({
      ...data,
      booking_url: data.booking_url ?? buildBookingUrl(locs[data.location].square_booking_url, data.item_id),
      href: url(`barbers/${data.slug}/`),
      first_name: data.name.split(' ')[0]!,
      initials: initialsOf(data.name),
      headshot_src: data.headshot ?? placeholder(600, 750, data.name),
    }))
    .sort((a, b) => locs[a.location].sort_order - locs[b.location].sort_order || a.sort_order - b.sort_order);
}

export async function getPortfolio(opts: { location?: LocationSlug; barber?: string; featured?: boolean } = {}): Promise<PortfolioItem[]> {
  const barbers = Object.fromEntries((await getBarbers()).map((b) => [b.slug, b]));
  const rows = await getCollection('portfolio', ({ data }) =>
    (!opts.location || data.location === opts.location) &&
    (!opts.barber || data.barber === opts.barber) &&
    (!opts.featured || data.featured) &&
    Boolean(barbers[data.barber]),
  );
  return rows
    .map(({ id, data }) => {
      const b = barbers[data.barber]!;
      const label = `${data.location} work ${data.sort_order - 1}`;
      return {
        ...data,
        id,
        src: data.image ?? placeholder(data.width, data.height, label, id),
        full: data.image ?? placeholder(data.width * 2, data.height * 2, label, id),
        barber_name: b.name,
        barber_first: b.first_name,
        barber_href: b.href,
        booking_url: b.booking_url,
      };
    })
    .sort((a, b) => a.sort_order - b.sort_order);
}

export const TAGS = [
  { key: 'fades', label: 'Fades' },
  { key: 'scissor', label: 'Scissor' },
  { key: 'beards', label: 'Beards' },
  { key: 'kids', label: 'Kids' },
  { key: 'color', label: 'Color' },
] as const;

/** "10:00" → 600 (minutes after midnight). */
export const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h! * 60 + m!;
};

/** "19:00" → "7 PM", "09:30" → "9:30 AM" */
export function fmtTime(t: string): string {
  const mins = toMinutes(t);
  const h = Math.floor(mins / 60), mm = mins % 60;
  return `${((h + 11) % 12) + 1}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Client-side hours map for the "Open now" script: { slug: { name, hours: { [day]: [open, close] } } } */
export async function getHoursPayload() {
  const locs = await getLocations();
  return Object.fromEntries(
    locs.map((l) => {
      const week: Record<number, [number, number]> = {};
      for (const row of l.hours) for (const d of row.days) week[d] = [toMinutes(row.opens), toMinutes(row.closes)];
      return [l.slug, { name: l.name, hours: week }];
    }),
  );
}
