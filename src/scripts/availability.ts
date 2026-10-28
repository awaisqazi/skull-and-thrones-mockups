/* Live Square availability in the browser (spec §3). Progressive enhancement only: the build already
   rendered the chips from the baked snapshot (or left them hidden). This script
   1. re-applies the display rules to the baked data with the visitor's clock (a page built hours ago
      must not show stale times: data older than 2 h is hidden),
   2. fetches the live availability.json the 15-minute job publishes (branch `data`) and repaints if it
      is newer, then again every 5 minutes while the tab is visible,
   3. repaints every minute so "Today 3:15 PM" drops off once 3:15 has passed.
   Elements: [data-avail] chips, [data-avail-list] barber-page "Next openings", [data-first-chair] on /book.
   Any failure leaves the page as it is (no chips is a valid state). Included by Layout.astro only on
   pages that render chips. */
import { barberView, firstOpenChair, newer, parseFile, type AvailabilityFile, type BarberView } from '../lib/availability';

const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll<T>(s));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
}
const time = (iso: string, label: string) => el('time', { datetime: iso }, label);

/** Same markup as BarberCard.astro / the barber page render at build time. */
function chipText(v: BarberView): (Node | string)[] {
  return v.next ? [el('span', { class: 'avail__pre' }, 'Next: '), time(v.next.iso, v.next.label)] : [v.text];
}

function paintChip(chip: HTMLElement, v: BarberView | null) {
  chip.hidden = !v;
  if (!v) return;
  chip.dataset.state = v.state;
  chip.querySelector('.avail__text')?.replaceChildren(...chipText(v));
}

function paintList(box: HTMLElement, v: BarberView | null) {
  box.hidden = !v;
  if (!v) return;
  const href = box.dataset.href || '#';
  const name = box.dataset.name || 'this barber';
  box.querySelector('.openings__list')?.replaceChildren(...v.soon.map((s) => el('li', {},
    el('a', { class: 'openings__slot', href, target: '_blank', rel: 'noopener', 'aria-label': `Book ${name}, ${s.label} (opens Square)` },
      time(s.iso, s.label), ' ', el('span', { class: 'arr', 'aria-hidden': 'true' }, '↗')))));
  const empty = box.querySelector<HTMLElement>('.openings__empty');
  if (empty) empty.hidden = v.state !== 'grey';
}

function paintFirstChair(row: HTMLElement, file: AvailabilityFile, now: Date) {
  let roster: Record<string, [string, string]> = {};
  try { roster = JSON.parse(row.dataset.roster || '{}'); } catch { /* leave empty */ }
  const best = firstOpenChair(file, row.dataset.firstChair || '', Object.keys(roster), now);
  row.hidden = !best;
  if (!best) return;
  const [name, href] = roster[best.item_id]!;
  const chip = row.querySelector<HTMLElement>('.avail');
  if (chip) chip.dataset.state = best.view.state;
  const link = row.querySelector<HTMLAnchorElement>('.first-chair__link');
  if (link) {
    link.href = href;
    link.replaceChildren(el('span', { class: 'first-chair__name' }, name), ' · ', time(best.view.next!.iso, best.view.next!.label), ' ', el('span', { class: 'arr', 'aria-hidden': 'true' }, '↗'));
  }
}

function paint(file: AvailabilityFile) {
  const now = new Date();
  for (const chip of $$('[data-avail]')) paintChip(chip, barberView(file, chip.dataset.shop || '', chip.dataset.avail || '', now));
  for (const box of $$('[data-avail-list]')) paintList(box, barberView(file, box.dataset.shop || '', box.dataset.availList || '', now));
  for (const row of $$('[data-first-chair]')) paintFirstChair(row, file, now);
}

const cfgEl = document.getElementById('st-avail');
if (cfgEl) {
  let cfg: { src?: string; file?: unknown } = {};
  try { cfg = JSON.parse(cfgEl.textContent || '{}'); } catch { /* malformed: treat as no data */ }
  let current = parseFile(cfg.file);
  paint(current);

  const refresh = async () => {
    if (!cfg.src) return;
    try {
      const res = await fetch(cfg.src, { cache: 'no-cache' });
      if (!res.ok) return; // 404 until the job has published once (no production tokens yet): keep what we have
      const live = parseFile(await res.json());
      const next = newer(current, live);
      if (next !== current) { current = next; paint(current); }
    } catch { /* offline, blocked, bad JSON: keep what we have */ }
  };
  void refresh();
  setInterval(() => paint(current), 60_000);
  setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5 * 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { paint(current); void refresh(); } });
}
