/* Live Square availability in the browser (spec §3). Progressive enhancement only: the build already
   rendered the chips from the baked snapshot (or left them hidden). This script
   1. re-applies the display rules to the baked data with the visitor's clock (a page built hours ago
      must not show stale times: data older than 2 h is hidden),
   2. fetches the live availability.json the 15-minute job publishes (branch `data`) and repaints if it
      is newer, then again every 5 minutes while the tab is visible,
   3. repaints every minute so "Today 3:15 PM" drops off once 3:15 has passed.
   Elements: [data-avail] chips, [data-avail-list] barber-page "Next openings", [data-first-chair] on /book.
   States: green / amber / grey / offline (not bookable online: "Call the shop to book"), or hidden (no data).
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
  // The box always stays visible (reserved space); no data = an empty list plus the "show here during shop hours" line.
  const toggle = (sel: string, hide: boolean) => { const n = box.querySelector<HTMLElement>(sel); if (n) n.hidden = hide; };
  box.hidden = false;
  if (!v) box.dataset.empty = ''; else delete box.dataset.empty;
  toggle('.openings__wait', Boolean(v));
  if (!v) {
    box.querySelector('.openings__list')?.replaceChildren();
    toggle('.openings__empty', true);
    toggle('.openings__offline', true);
    toggle('.openings__note', false);
    return;
  }
  const href = box.dataset.href || '#';
  const name = box.dataset.name || 'this barber';
  box.querySelector('.openings__list')?.replaceChildren(...v.soon.map((s) => el('li', {},
    el('a', { class: 'openings__slot', href, target: '_blank', rel: 'noopener', 'aria-label': `Book ${name}, ${s.label} (opens Square)` },
      time(s.iso, s.label), ' ', el('span', { class: 'arr', 'aria-hidden': 'true' }, '↗')))));
  const offline = v.state === 'offline';
  toggle('.openings__empty', v.state !== 'grey');
  // Not bookable online: one line instead of times + the "live from Square" note (the Book button stays).
  toggle('.openings__offline', !offline);
  toggle('.openings__note', offline);
}

function paintFirstChair(row: HTMLElement, file: AvailabilityFile, now: Date) {
  let roster: Record<string, [string, string]> = {};
  try { roster = JSON.parse(row.dataset.roster || '{}'); } catch { /* leave empty */ }
  const best = firstOpenChair(file, row.dataset.firstChair || '', Object.keys(roster), now);
  // The row always stays (reserved space): the link when there is an open chair, else the muted "during shop hours" line.
  row.hidden = false;
  const link = row.querySelector<HTMLAnchorElement>('.first-chair__link');
  const wait = row.querySelector<HTMLElement>('.first-chair__wait');
  const chip = row.querySelector<HTMLElement>('.avail');
  if (link) link.hidden = !best;
  if (wait) wait.hidden = Boolean(best);
  if (!best) { row.dataset.empty = ''; if (chip) delete chip.dataset.state; return; }
  delete row.dataset.empty;
  const entry = roster[best.item_id];
  if (!Array.isArray(entry)) return;
  const [name, href] = entry;
  if (chip) chip.dataset.state = best.view.state;
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

  let inFlight = false;
  const refresh = async () => {
    if (!cfg.src || inFlight) return; // one request at a time (visibilitychange + the 5-minute timer can overlap)
    inFlight = true;
    try {
      // AbortSignal.timeout is missing before Safari 16: then the request simply has no client-side timeout.
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined;
      const res = await fetch(cfg.src, { cache: 'no-cache', signal });
      if (!res.ok) return; // 404 until the job has published once (no production tokens yet): keep what we have
      const live = parseFile(await res.json()); // sanitised: bad shapes and time zones never reach paint()
      const next = newer(current, live);
      if (next !== current) { current = next; paint(current); }
    } catch { /* offline, blocked, timed out, bad JSON: keep what we have */ } finally { inFlight = false; }
  };
  void refresh();
  setInterval(() => paint(current), 60_000);
  setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5 * 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { paint(current); void refresh(); } });
}
