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
  /** Phase 2 (Square availability job), e.g. "Tue 2pm"; null = not shown. Shop-set accepting_new_clients is separate. */
  next_opening: string | null;
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

/**
 * Copy for `accepting_new_clients`: a shop-set statement (CMS toggle) about whether the barber
 * takes NEW customers. It is not live Square availability; that arrives later as `next_opening`.
 */
export const ACCEPTING = {
  yes: { label: 'Accepting new clients', tip: 'Set by the shop: this barber is taking new clients. Open times show in Square when you book.' },
  no: { label: 'Booked up', tip: 'Set by the shop: this barber is not taking new clients right now. Existing clients can still book in Square.' },
} as const;

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
      next_opening: data.next_opening ?? null,
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

/* ---------- Behind the scenes (/culture/) ---------- */
export type CultureCategory = CollectionEntry<'culture'>['data']['category'];
export type CultureItem = CollectionEntry<'culture'>['data'] & {
  id: string;
  /** Remote image URL, or null (local file in src/assets/culture/ or placeholder; resolved in CultureTile). */
  remote: string | null;
  /** Placeholder tile data URI (used when there is no photo yet). */
  placeholder_src: string;
  /** "Nov 2025" / null */
  date_label: string | null;
};
export type CultureStat = CollectionEntry<'cultureStats'>['data'] & { id: string };

/** Filter chips on /culture/ ('shop' items show under All only). */
export const CULTURE_CATEGORIES = [
  { key: 'education', label: 'Education' },
  { key: 'events', label: 'Events' },
  { key: 'community', label: 'Community' },
] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export async function getCultureItems(opts: { category?: CultureCategory } = {}): Promise<CultureItem[]> {
  const rows = await getCollection('culture', ({ data }) => !opts.category || data.category === opts.category);
  return rows
    .map(({ id, data }) => {
      const [y, m] = (data.date ?? '').split('-');
      return {
        ...data,
        id,
        remote: data.image && /^https?:\/\//.test(data.image) ? data.image : null,
        placeholder_src: placeholder(data.featured ? 1200 : 800, data.featured ? 1200 : 800, '', id),
        date_label: y && m ? `${MONTHS[Number(m) - 1]} ${y}` : null,
      };
    })
    .sort((a, b) => a.sort_order - b.sort_order);
}

export async function getCultureStats(): Promise<CultureStat[]> {
  return (await getCollection('cultureStats')).map(({ id, data }) => ({ ...data, id }));
}

/* ---------- Products (Bodega / bybodega.com, synced by scripts/sync-products.mjs) ---------- */
export type Product = CollectionEntry<'products'>['data'] & {
  /** Title without the leading brand name, ALL-CAPS titles title-cased ("WAHL CORDLESS MAGIC CLIP" → "Cordless Magic Clip"). */
  display_title: string;
  vendor_slug: string;
  price_label: string;
  compare_label: string | null;
  /** Shopify CDN resized copies (the CDN resizes on `width`, and serves WebP/AVIF when the browser accepts it). */
  src: string;
  srcset: string;
};

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Shopify CDN: append width=N to the image URL for a resized copy (never ship the multi-MB originals). */
export const shopifyImg = (src: string, width: number) => `${src}${src.includes('?') ? '&' : '?'}width=${width}`;
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

function displayTitle(title: string, vendor: string): string {
  let t = title.trim();
  for (const prefix of [vendor, vendor.split(/\s+/)[0]!]) {
    if (t.toLowerCase().startsWith(prefix.toLowerCase() + ' ')) { t = t.slice(prefix.length).trim(); break; }
  }
  return /[a-z]/.test(t) ? t : titleCase(t);
}
const usd = (p: string) => `$${p}`;

export async function getProducts(opts: { featured?: boolean; vendor?: string } = {}): Promise<Product[]> {
  const rows = await getCollection('products', ({ data }) =>
    data.available && (!opts.featured || data.featured) && (!opts.vendor || slugify(data.vendor) === opts.vendor),
  );
  return rows
    .map(({ data }) => ({
      ...data,
      // checkout route switch: buy_url comes straight from products.json (today = Bodega product page).
      // Switching to a Shopify Buy Button or Square Online checkout only changes that field (see README "Products").
      display_title: displayTitle(data.title, data.vendor),
      vendor_slug: slugify(data.vendor),
      price_label: usd(data.price),
      compare_label: data.compare_at_price ? usd(data.compare_at_price) : null,
      src: shopifyImg(data.image, 600),
      srcset: [300, 600, 900].map((w) => `${shopifyImg(data.image, w)} ${w}w`).join(', '),
    }))
    .sort((a, b) => a.sort_order - b.sort_order);
}

export const getFeaturedProducts = () => getProducts({ featured: true });

/** Vendor filter chips for /shop/: [{ slug, label, count }], A–Z. */
export function productVendors(list: Product[]) {
  const map = new Map<string, { slug: string; label: string; count: number }>();
  for (const p of list) {
    const v = map.get(p.vendor_slug) ?? { slug: p.vendor_slug, label: p.vendor, count: 0 };
    v.count++;
    map.set(p.vendor_slug, v);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
}
