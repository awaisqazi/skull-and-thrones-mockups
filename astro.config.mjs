// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import assertAppScript from './scripts/assert-app-script.mjs';
import { SQUARE_IMAGE_HOSTS, SQUARE_IMAGE_PATH_PREFIX } from './src/lib/square-photos.ts';

// Production is https://skullandthrones.com/ (deploy.yml sets SITE_URL and BASE_PATH=/ and public/CNAME names the host).
// These defaults are only for a bare local `astro build` / `astro dev`: the old GitHub Pages project site,
// https://awaisqazi.github.io/skull-and-thrones-mockups/. Local dev at the root: BASE_PATH=/ SITE_URL=http://localhost:4321 npm run dev
const site = process.env.SITE_URL || 'https://awaisqazi.github.io';
const base = process.env.BASE_PATH || '/skull-and-thrones-mockups';
const root = base.replace(/\/$/, ''); // '' at the domain root, '/skull-and-thrones-mockups' on the project site

// Old Square Online (Weebly) URLs from https://www.skullandthrones.com/sitemap.xml (read 2026-10-29).
// GitHub Pages is static, so these become meta-refresh pages (Astro `redirects`). Anything not listed falls
// through to src/pages/404.astro, which links to the shop and the team.
// Per-product deep links do not exist on /shop/ (cards link out to Bodega; the brand filters are button state, not URLs),
// so every old product page lands on /shop/. Brands are not in the old sitemap or page HTML (JS-rendered), only the
// two slick-gorilla-* slugs are identifiable; when /shop/ gets per-product anchors, point those at them.
const legacyProducts = [
  '-5-basket/OARKR3ONWNKOCY6SZ2RZLUZO',
  'airy-texture-spray/192',
  'amplify-conditioner/190',
  'amplify-mousse/193',
  'beachy-texture-spray/198',
  'blow-dry-primer/199',
  'curl-glaze-mousse-13/202',
  'deep-cleansing-shampoo/191',
  'dry-shampoo/200',
  'hair-mask/203',
  'hydrate-spray-conditioner/194',
  'joiful-volumizing-conditioner/208',
  'joiful-volumizing-shampoo/207',
  'jrl-paddle-brush/213',
  'jrl-round-brush/214',
  'lightweight-clay/195',
  'mizutani-shears-yoshi/107',
  'moisture-recovery-conditioner/206',
  'moisture-recovery-shampoo/205',
  'nourishing-hair-oil/204',
  'rebel-shaver/183',
  'replenish-balm/201',
  'salsa-macha/211',
  'slick-gorilla-curl-creme/196', // Slick Gorilla: nearest current items are "Curl Cream" in /shop/
  'slick-gorilla-light-paste/197', // Slick Gorilla
  'snake-shirt/210',
];
const redirects = {
  // /shop (no slash) is handled by GitHub Pages itself (301 to /shop/), so it has no entry here.
  '/gallery': `${root}/addison/#portfolio`,
  '/s/shop': `${root}/shop/`,
  '/s/order': `${root}/shop/`,
  ...Object.fromEntries(legacyProducts.map((p) => [`/product/${p}`, `${root}/shop/`])),
};

export default defineConfig({
  output: 'static',
  site,
  base,
  trailingSlash: 'always',
  redirects,
  build: { format: 'directory' },
  integrations: [
    // Fails the build if any page is missing the site script (QA 2026-10-28, scripts/assert-app-script.mjs).
    assertAppScript(),
    sitemap({
      filter: (page) => !/\/(404|portfolio)\/?$/.test(page),
    }),
  ],
  image: {
    // Barber photos from Square (spec §4): astro:assets downloads and optimises them at build like the local
    // headshots. Exact hosts, shared with the roster's URL check (SQUARE_IMAGE_HOSTS in src/lib/square-photos.ts),
    // so a URL the roster accepts is always one Astro may fetch.
    // Add the Supabase Storage host here once headshots/portfolio photos move there:
    // { protocol: 'https', hostname: '<project-ref>.supabase.co' }
    remotePatterns: SQUARE_IMAGE_HOSTS.map((hostname) => ({ protocol: 'https', hostname, pathname: `${SQUARE_IMAGE_PATH_PREFIX}**` })),
  },
});
