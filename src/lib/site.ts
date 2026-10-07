export const SITE = {
  name: 'Skull & Thrones',
  alt_name: 'S&T Hair Society',
  slogan: 'Progress through creativity',
  email: 'skullandthrones@gmail.com',
  instagram: 'https://www.instagram.com/skullandthrones/',
  instagram_handle: 'skullandthrones',
  // Verified on @skullandthrones 2026-10-07: profile tagline, category and location line.
  // One shared Instagram account covers both shops (it has an "Elmhurst" story highlight).
  ig_tagline: 'Modern • Barbering',
  ig_location_line: 'Addison & Elmhurst IL',
  ig_highlights: ['Elmhurst', 'Our Art', 'Our Shop', 'Artist Spotlight', 'Our Team', 'You'],
  // Brand voice from shop captions: calls barbers "artists", the shop a "hair society";
  // "character and grit over everything" (2024 hiring post).
  brand_line: 'You cultivate a hair society.',
  // TODO: exact Facebook page URL from client (brief lists "skull&throneshairsociety").
  facebook: 'https://www.facebook.com/',
  timezone: 'America/Chicago',
  // TODO verify: rating/review count supplied by coordinator, not checked against Google yet.
  rating: { value: '4.9', count: '~1,000' },
} as const;

export const igUrl = (handle: string) => `https://www.instagram.com/${handle}/`;
