/**
 * Site-wide JSON-LD (the @graph that Layout.astro prints on every page). No Astro imports, so `node --test` loads it
 * directly (schema.test.ts). Everything here is derived from data the pages already render: the locations collection
 * (src/data/locations.json merged with Square hours by the loader in src/content.config.ts) and SITE (src/lib/site.ts).
 *
 * What Google actually uses (checked 2026-10-30, see docs/GBP-BOOKING-INTEGRATION.md section 6):
 *   - Organization (name, url, logo, sameAs) and LocalBusiness subtypes (name, address, geo, openingHoursSpecification,
 *     priceRange, telephone, url): documented Search features. They describe the entity; Google does not promise any
 *     display, and the Business Profile itself is NOT created or changed by this markup.
 *   - schema.org has NO `BarberShop` type. `HairSalon` is the closest, most specific LocalBusiness subtype, so that is used.
 *   - `ReserveAction` / `potentialAction` is not part of any Google Search structured-data feature (it is not on the
 *     Search gallery nor in the Local business guide). In-search booking comes from Reserve with Google (Square's
 *     integration, set up in the Square Dashboard), not from page markup, so it is deliberately NOT emitted.
 */
import type { HoursRow } from './square-locations.ts';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export interface SchemaLocation {
  slug: string;
  name: string;
  /** Site-relative page path, already prefixed with the base (Location.href). */
  href: string;
  street: string;
  city: string;
  region: string;
  postal_code: string;
  phone_e164: string;
  hours: HoursRow[];
  /** Search-style Maps URL built from the address (always present; data.ts). Used for hasMap until google_maps_url is set. */
  maps_url: string;
  /**
   * The shop's real Google Maps place URL (Maps > Share > Copy link, or the Business Profile's Maps link). Paste it into
   * src/data/locations.json as `google_maps_url`; it then feeds `hasMap` and `sameAs` below. null = not set.
   */
  google_maps_url?: string | null;
  /** The name as the Google listing shows it; JSON-LD `name` uses it so the site and the profile agree. */
  google_listing_name?: string | null;
  /** Decimal degrees, 5+ decimals (Google's Local business guide). null/absent = unknown, so `geo` is left out (never guessed). */
  latitude?: number | null;
  longitude?: number | null;
}

export interface SchemaSite {
  name: string;
  alt_name: string;
  slogan: string;
  email: string;
  instagram: string;
  payment_accepted: string;
}

export interface SchemaContext {
  site: SchemaSite;
  /** Absolute URL for a site-relative path ("/addison/" with the base already applied). */
  abs: (path: string) => string;
  /** Absolute id/URL builders; `locationId` must stay stable across builds (it is referenced from Person nodes). */
  orgId: string;
  homeUrl: string;
  locationId: (slug: string) => string;
  logo: string;
  fallbackImage: string;
  /** Absolute URL of the shop's own photo, when it has one. */
  locationImage: (slug: string) => string | undefined;
}

/** One OpeningHoursSpecification per hours row, from the same `hours` rows the visible hours table renders. */
export function openingHoursSpecification(hours: HoursRow[]) {
  return hours.map((h) => ({
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: h.days.map((d) => DAY_NAMES[d]!),
    opens: h.opens,
    closes: h.closes,
  }));
}

export function locationNode(l: SchemaLocation, ctx: SchemaContext) {
  const mapsUrl = l.google_maps_url || null;
  const sameAs = [ctx.site.instagram, ...(mapsUrl ? [mapsUrl] : [])];
  const hasGeo = typeof l.latitude === 'number' && typeof l.longitude === 'number';
  return {
    '@type': 'HairSalon',
    '@id': ctx.locationId(l.slug),
    name: l.google_listing_name || ctx.site.name,
    alternateName: `${ctx.site.name} ${l.name}`,
    url: ctx.abs(l.href),
    image: ctx.locationImage(l.slug) ?? ctx.fallbackImage,
    parentOrganization: { '@id': ctx.orgId },
    telephone: l.phone_e164,
    email: ctx.site.email,
    priceRange: '$$',
    paymentAccepted: ctx.site.payment_accepted,
    address: {
      '@type': 'PostalAddress',
      streetAddress: l.street,
      addressLocality: l.city,
      addressRegion: l.region,
      postalCode: l.postal_code,
      addressCountry: 'US',
    },
    ...(hasGeo ? { geo: { '@type': 'GeoCoordinates', latitude: l.latitude, longitude: l.longitude } } : {}),
    openingHoursSpecification: openingHoursSpecification(l.hours),
    hasMap: mapsUrl ?? l.maps_url,
    sameAs,
  };
}

export function organizationNode(locations: SchemaLocation[], ctx: SchemaContext) {
  return {
    '@type': 'Organization',
    '@id': ctx.orgId,
    name: ctx.site.name,
    alternateName: ctx.site.alt_name,
    slogan: ctx.site.slogan,
    url: ctx.homeUrl,
    logo: ctx.logo,
    email: ctx.site.email,
    sameAs: [ctx.site.instagram],
    subOrganization: locations.map((l) => ({ '@id': ctx.locationId(l.slug) })),
  };
}

/**
 * The @graph printed on every page: the brand plus both shops. Every node is referenced by a stable @id (the brand lists
 * its shops in `subOrganization`, each shop points back with `parentOrganization`, barber pages point at their shop with
 * `worksFor`), so all references resolve inside the same document. The footer shows both addresses on every page, so
 * the markup matches visible content everywhere.
 */
export function buildJsonLd(locations: SchemaLocation[], ctx: SchemaContext) {
  return {
    '@context': 'https://schema.org',
    '@graph': [organizationNode(locations, ctx), ...locations.map((l) => locationNode(l, ctx))],
  };
}
