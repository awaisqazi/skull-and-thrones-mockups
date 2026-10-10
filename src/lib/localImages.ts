/**
 * Local drop-in images. Any file placed at
 *   src/assets/headshots/<barber-slug>.(jpg|jpeg|png|webp)   -> used as that barber's headshot
 *   src/assets/portfolio/<portfolio-id>.(jpg|jpeg|png|webp)  -> used as that tile's photo
 * is picked up automatically at build time, no data edits needed. A remote `headshot` /
 * `image` URL in the data (Supabase later) still wins when present.
 */
import type { ImageMetadata } from 'astro';

const headshotFiles = import.meta.glob<{ default: ImageMetadata }>('/src/assets/headshots/*.{jpg,jpeg,png,webp}', { eager: true });
const locationFiles = import.meta.glob<{ default: ImageMetadata }>('/src/assets/locations/*.{jpg,jpeg,png,webp}', { eager: true });
const portfolioFiles = import.meta.glob<{ default: ImageMetadata }>('/src/assets/portfolio/*.{jpg,jpeg,png,webp}', { eager: true });

function index(files: Record<string, { default: ImageMetadata }>): Map<string, ImageMetadata> {
  const m = new Map<string, ImageMetadata>();
  for (const [path, mod] of Object.entries(files)) {
    const key = path.split('/').pop()!.replace(/\.(jpg|jpeg|png|webp)$/i, '').toLowerCase();
    m.set(key, mod.default);
  }
  return m;
}

const headshots = index(headshotFiles);
const portfolio = index(portfolioFiles);
const locationsIdx = index(locationFiles);

export const localHeadshot = (slug: string): ImageMetadata | undefined => headshots.get(slug.toLowerCase());
export const localPortfolioImage = (id: string): ImageMetadata | undefined => portfolio.get(id.toLowerCase());
/** src/assets/locations/<location-slug>.jpg -> shop photo for that location (Google Business Profile photos for now). */
export const localLocationPhoto = (slug: string): ImageMetadata | undefined => locationsIdx.get(slug.toLowerCase());

/** src/assets/culture/<item-id>.jpg (or the file named in the item's `image`) -> /culture/ collage photo. */
const cultureFiles = import.meta.glob<{ default: ImageMetadata }>('/src/assets/culture/*.{jpg,jpeg,png,webp}', { eager: true });
const cultureIdx = index(cultureFiles);
export const localCultureImage = (idOrFile: string): ImageMetadata | undefined =>
  cultureIdx.get(idOrFile.toLowerCase().replace(/^.*\//, '').replace(/\.(jpg|jpeg|png|webp)$/i, ''));
