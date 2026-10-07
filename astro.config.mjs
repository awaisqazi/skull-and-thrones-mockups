// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Pages project site today: https://awaisqazi.github.io/skull-and-thrones-mockups/
// For the custom domain later, build with SITE_URL=https://skullandthrones.com BASE_PATH=/
const site = process.env.SITE_URL || 'https://awaisqazi.github.io';
const base = process.env.BASE_PATH || '/skull-and-thrones-mockups';

export default defineConfig({
  output: 'static',
  site,
  base,
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [
    sitemap({
      filter: (page) => !/\/(404|portfolio)\/?$/.test(page),
    }),
  ],
  image: {
    // Add the Supabase Storage host here once headshots/portfolio photos move there:
    // remotePatterns: [{ protocol: 'https', hostname: '<project-ref>.supabase.co' }],
  },
});
