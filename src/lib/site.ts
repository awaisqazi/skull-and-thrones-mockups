export const SITE = {
  name: 'Skull & Thrones',
  alt_name: 'S&T Hair Society',
  slogan: 'Progress through creativity',
  email: 'skullandthrones@gmail.com',
  instagram: 'https://www.instagram.com/skullandthrones/',
  instagram_handle: 'skullandthrones',
  // TODO: exact Facebook page URL from client (brief lists "skull&throneshairsociety").
  facebook: 'https://www.facebook.com/',
  timezone: 'America/Chicago',
  // TODO verify: rating/review count supplied by coordinator, not checked against Google yet.
  rating: { value: '4.9', count: '~1,000' },
} as const;

export const igUrl = (handle: string) => `https://www.instagram.com/${handle}/`;
