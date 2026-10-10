/* Skull & Thrones — site behaviour (ported from mockups/shared/app.js). Vanilla, no deps.
   Tabs (state in URL hash), booking/menu popovers, portfolio filters + lightbox,
   live "Open now" status from the locations collection (embedded as #st-hours). */

type Week = Record<string, [number, number]>;
type LocInfo = { name: string; hours: Week };

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s);
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll<T>(s));

const LOCATIONS: Record<string, LocInfo> = JSON.parse($('#st-hours')?.textContent || '{}');
const TZ = 'America/Chicago';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const params = new URLSearchParams(location.search);

/* ---------- Location state (body[data-loc] drives CSS visibility) ---------- */
function setLoc(key: string) {
  const loc = LOCATIONS[key];
  if (!loc) return;
  document.body.dataset.loc = key;
  $$<HTMLAnchorElement>('[data-loc-href]').forEach((a) => { a.href = a.dataset.locHref!.replace('{loc}', key); });
  $$('[data-loc-text]').forEach((el) => { el.textContent = el.dataset.locText!.replace('{Loc}', loc.name); });
  $$('[data-loc-name]').forEach((el) => { el.textContent = loc.name; });
  document.dispatchEvent(new CustomEvent('loc:change', { detail: key }));
}
if (params.get('location')) setLoc(params.get('location')!);

/* ---------- Remembered shop (localStorage "st-location"; wrapped: storage can be blocked) ---------- */
const STORE_KEY = 'st-location';
const recall = () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } };
const remember = (key: string) => { try { localStorage.setItem(STORE_KEY, key); } catch { /* private mode */ } };

/* ---------- Tabs (WAI-ARIA tabs pattern) ---------- */
type SelectOpts = { focus?: boolean; user?: boolean };
type TabList = HTMLElement & { _select?: (key: string, opts?: SelectOpts) => void };
function initTabs(list: TabList) {
  const tabs = $$<HTMLButtonElement>('[role="tab"]', list);
  const usesHash = list.hasAttribute('data-hash');
  const syncLoc = list.dataset.sync === 'loc';
  // Home page: no tab is pre-selected; a "Choose your shop" prompt shows until the visitor picks.
  const neutral = list.hasAttribute('data-neutral');
  const chooser = document.getElementById(list.dataset.chooser || '');
  const select = (tab: HTMLButtonElement, opts: SelectOpts = {}) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls') || '');
      if (panel) panel.hidden = !on;
    });
    if (opts.focus) tab.focus();
    const key = tab.dataset.key || '';
    if (syncLoc) setLoc(key);
    if (chooser) chooser.hidden = true;
    if (opts.user && syncLoc) remember(key);
    if (opts.user && usesHash) history.replaceState(null, '', location.pathname + location.search + '#' + key);
    // Links that should carry the current view across pages (e.g. Addison ↔ Elmhurst on the same tab)
    if (usesHash) $$<HTMLAnchorElement>('[data-hash-link]').forEach((a) => { a.hash = key; });
  };
  list._select = (key, opts) => {
    const t = tabs.find((x) => x.dataset.key === key);
    if (t) select(t, opts);
  };
  tabs.forEach((t) => t.addEventListener('click', () => select(t, { user: true })));
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const map: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    select(tabs[(map[e.key]! + tabs.length) % tabs.length]!, { focus: true, user: true });
  });
  const fromHash = usesHash && tabs.find((t) => t.dataset.key === location.hash.slice(1));
  const fromQuery = syncLoc && tabs.find((t) => t.dataset.key === params.get('location'));
  const stored = syncLoc ? recall() : null;
  const fromStore = stored && tabs.find((t) => t.dataset.key === stored);
  // A shared #addison / #elmhurst link always wins over the remembered shop.
  const chosen = fromHash || fromQuery || fromStore;
  if (chosen) return select(chosen);
  if (neutral) {
    // Nothing selected (aria-selected="false" on every tab, all panels hidden). The first tab
    // keeps tabindex 0 so the tablist is still reachable with Tab; arrow keys then select.
    tabs.forEach((t, i) => {
      t.setAttribute('aria-selected', 'false');
      t.tabIndex = i === 0 ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls') || '');
      if (panel) panel.hidden = true;
    });
    if (chooser) chooser.hidden = false;
    return;
  }
  const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
  if (initial) select(initial);
}
$$<TabList>('[role="tablist"]').forEach(initTabs);
// "Choose your shop" buttons: select that tab as if clicked (writes the hash + remembers it), then
// move focus to the selected tab, since the prompt the visitor was on disappears.
$$<HTMLButtonElement>('[data-choose]').forEach((b) => b.addEventListener('click', () => {
  const tab = $$<HTMLButtonElement>('[role="tab"]').find((t) => t.getAttribute('aria-controls') === b.getAttribute('aria-controls'));
  const list = tab?.closest<TabList>('[role="tablist"]');
  list?._select?.(tab!.dataset.key || '', { user: true, focus: true });
}));
window.addEventListener('hashchange', () => {
  $$<TabList>('[role="tablist"][data-hash]').forEach((l) => l._select?.(location.hash.slice(1)));
});

/* ---------- Popovers (Book now chooser, mobile menu) ---------- */
const popBtns = $$<HTMLButtonElement>('[data-pop]');
const popOf = (b: HTMLElement) => document.getElementById(b.getAttribute('aria-controls') || '')!;
const closePops = (except?: HTMLElement) => popBtns.forEach((b) => {
  if (b === except) return;
  b.setAttribute('aria-expanded', 'false');
  popOf(b).hidden = true;
});
popBtns.forEach((btn) => btn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = btn.getAttribute('aria-expanded') === 'true';
  closePops(btn);
  btn.setAttribute('aria-expanded', String(!open));
  popOf(btn).hidden = open;
  if (!open && e.detail === 0) $<HTMLElement>('a, button', popOf(btn))?.focus();
}));
document.addEventListener('click', (e) => { if (!(e.target as Element).closest('.pop')) closePops(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const openBtn = popBtns.find((b) => b.getAttribute('aria-expanded') === 'true');
  if (openBtn) { closePops(); openBtn.focus(); }
});

/* ---------- Dialog helpers ---------- */
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog')?.close()));

/* ---------- Portfolio filters ---------- */
$$('[data-filters]').forEach((group) => {
  const scope = document.getElementById(group.dataset.filters || '') || document;
  const btns = $$<HTMLButtonElement>('[data-filter]', group);
  const item = group.dataset.filterItem || '.tile'; // /shop/ uses data-filter-item=".pcard"
  const apply = (f: string) => {
    btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === f)));
    $$(item, scope).forEach((t) => { t.hidden = !(f === 'all' || (t.dataset.tags || '').split(' ').includes(f)); });
    $$('[data-filterable]', scope).forEach((c) => {
      const empty = $('.empty', c);
      if (empty) empty.hidden = $$(`${item}:not([hidden])`, c).length > 0;
    });
  };
  btns.forEach((b) => b.addEventListener('click', () => apply(b.dataset.filter || 'all')));
  apply('all');
});

/* ---------- Lightbox ---------- */
const lb = $<HTMLDialogElement>('#lightbox');
let lbList: HTMLElement[] = [];
let lbIdx = 0;
function showTile(i: number) {
  if (!lb || !lbList.length) return;
  lbIdx = (i + lbList.length) % lbList.length;
  const t = lbList[lbIdx]!;
  const src = $<HTMLImageElement>('img', t)!;
  const big = $<HTMLImageElement>('[data-lb="img"]', lb)!;
  big.src = t.dataset.full || src.src;
  big.alt = src.alt;
  $('[data-lb="cap"]', lb)!.innerHTML = $('.tile__cap', t)!.innerHTML;
  const [book, view] = $$<HTMLAnchorElement>('.tile__actions a', t);
  const lbBook = $<HTMLAnchorElement>('[data-lb="book"]', lb)!;
  const lbView = $<HTMLAnchorElement>('[data-lb="view"]', lb)!;
  if (book) { lbBook.href = book.href; lbBook.textContent = book.textContent; }
  if (view) { lbView.href = view.href; lbView.textContent = view.textContent; }
  // Culture tiles carry at most one link (the Instagram post) and no barber: hide unused buttons.
  lbBook.hidden = !book;
  lbView.hidden = !view;
  $('[data-lb="count"]', lb)!.textContent = `${lbIdx + 1} / ${lbList.length}`;
}
if (lb) {
  $$('.tile__zoom').forEach((b) => b.addEventListener('click', () => {
    const tile = b.closest<HTMLElement>('.tile')!;
    const scope = tile.closest('[data-filterable], .strip') || document;
    lbList = $$('.tile', scope).filter((t) => !t.hidden && t.offsetParent !== null && $('.tile__zoom', t) !== null);
    showTile(lbList.indexOf(tile));
    lb.showModal();
  }));
  $('[data-lb="prev"]', lb)!.addEventListener('click', () => showTile(lbIdx - 1));
  $('[data-lb="next"]', lb)!.addEventListener('click', () => showTile(lbIdx + 1));
  lb.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') showTile(lbIdx - 1);
    if (e.key === 'ArrowRight') showTile(lbIdx + 1);
  });
  lb.addEventListener('click', (e) => { if ((e.target as Element).classList.contains('lightbox__stage')) lb.close(); });
}

/* ---------- Open-now status (computed in shop time zone) ---------- */
function nowInShop() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '0';
  return { day: DAYS.indexOf(get('weekday')), mins: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}
const fmt = (m: number) => {
  const h = Math.floor(m / 60), mm = m % 60;
  return ((h + 11) % 12 + 1) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM');
};
function statusFor(key: string) {
  const H = LOCATIONS[key]?.hours;
  if (!H) return null;
  const { day, mins } = nowInShop();
  const today = H[day];
  if (today && mins >= today[0] && mins < today[1]) return { open: true, text: 'Open now · til ' + fmt(today[1]) };
  if (today && mins < today[0]) return { open: false, text: 'Closed · opens ' + fmt(today[0]) };
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    const next = H[d];
    if (next) return { open: false, text: 'Closed · opens ' + (i === 1 ? 'tomorrow ' : DAYS[d] + ' ') + fmt(next[0]) };
  }
  return { open: false, text: 'Closed' };
}
function paintStatus() {
  $$('[data-open-status]').forEach((el) => {
    const s = statusFor(el.dataset.openStatus || '');
    if (!s) return;
    el.dataset.state = s.open ? 'open' : 'closed';
    el.textContent = s.text;
  });
  const { day } = nowInShop();
  $$('[data-days]').forEach((row) => row.classList.toggle('is-today', (row.dataset.days || '').split(',').includes(String(day))));
}
paintStatus();
setInterval(paintStatus, 60000);

$$('[data-year]').forEach((el) => { el.textContent = String(new Date().getFullYear()); });

/* ---------- Product strip (home): prev/next scroll by one card; swipe is native scroll-snap ---------- */
$$('[data-pstrip]').forEach((strip) => {
  const nav = $(`[data-pstrip-nav="${strip.id}"]`);
  const prev = nav && $<HTMLButtonElement>('[data-pstrip-prev]', nav);
  const next = nav && $<HTMLButtonElement>('[data-pstrip-next]', nav);
  const step = () => {
    const card = strip.firstElementChild as HTMLElement | null;
    const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
    return card ? card.getBoundingClientRect().width + gap : strip.clientWidth;
  };
  const sync = () => {
    const max = strip.scrollWidth - strip.clientWidth - 2;
    if (prev) prev.disabled = strip.scrollLeft <= 2;
    if (next) next.disabled = strip.scrollLeft >= max;
  };
  const behavior: ScrollBehavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  prev?.addEventListener('click', () => strip.scrollBy({ left: -step(), behavior }));
  next?.addEventListener('click', () => strip.scrollBy({ left: step(), behavior }));
  strip.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  sync();
});
