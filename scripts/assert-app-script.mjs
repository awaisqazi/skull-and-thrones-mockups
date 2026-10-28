/**
 * Build assertion (astro.config.mjs integration): every built HTML page must load the site script (src/scripts/app.ts:
 * menu, Book popover, "Open now", filters, map, "Show all"). QA 2026-10-28 found Astro serving the availability bundle
 * instead of app.ts on pages without chips (contact, shop, culture, 404); this fails the build if that ever comes back.
 * The app bundle is recognised by the `st-hours` marker it reads. Also exported as a function for the unit test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

/** Pages (relative paths) under `dir` whose module scripts do not include the app bundle. `base` = site base path. */
export function pagesWithoutApp(dir, base = '/') {
  const files = walk(dir);
  const appBundles = new Set(files.filter((f) => f.endsWith('.js') && readFileSync(f, 'utf8').includes('st-hours')).map((f) => relative(dir, f)));
  const prefix = base.replace(/\/?$/, '/');
  return files.filter((f) => f.endsWith('.html')).filter((f) => {
    const html = readFileSync(f, 'utf8');
    if (/http-equiv="refresh"/i.test(html) && html.length < 2000) return false; // redirect stubs
    const srcs = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1].startsWith(prefix) ? m[1].slice(prefix.length) : m[1].replace(/^\//, ''));
    return !srcs.some((s) => appBundles.has(s));
  }).map((f) => relative(dir, f));
}

export default function assertAppScript() {
  let base = '/';
  return {
    name: 'assert-app-script',
    hooks: {
      'astro:config:done': ({ config }) => { base = config.base || '/'; },
      'astro:build:done': ({ dir, logger }) => {
        const missing = pagesWithoutApp(fileURLToPath(dir), base);
        if (missing.length) throw new Error(`site script (app.ts) missing on ${missing.length} page(s): ${missing.join(', ')}`);
        logger.info('every page loads the site script (app.ts)');
      },
    },
  };
}
