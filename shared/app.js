/* Skull & Thrones — mockup behaviour. Vanilla JS, no dependencies.
   Tabs (location persists via URL hash), booking popover, barber slide-over,
   portfolio filters + lightbox, live "Open now" status from hours. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* CMS: `locations` collection. hours: day index (0 = Sun) -> [open, close] in minutes. */
  const WEEK = { 0: [540, 900], 1: [600, 1140], 2: [600, 1140], 3: [600, 1140], 4: [600, 1140], 5: [600, 1140], 6: [480, 960] };
  const LOCATIONS = {
    addison: { name: 'Addison', hours: WEEK },
    elmhurst: { name: 'Elmhurst', hours: WEEK }
  };
  const TZ = 'America/Chicago';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const params = new URLSearchParams(location.search);

  /* ---------- Location state (body[data-loc] drives CSS visibility) ---------- */
  function setLoc(key, writeHash) {
    if (!LOCATIONS[key]) return;
    const name = LOCATIONS[key].name;
    document.body.dataset.loc = key;
    $$('[data-loc-href]').forEach(a => { a.href = a.dataset.locHref.replace('{loc}', key); });
    $$('[data-loc-text]').forEach(el => { el.textContent = el.dataset.locText.replace('{Loc}', name); });
    $$('[data-loc-name]').forEach(el => { el.textContent = name; });
    $$('[data-loc-link]').forEach(a => {
      if (a.dataset.locLink === key) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (writeHash) history.replaceState(null, '', location.pathname + location.search + '#' + key);
    document.dispatchEvent(new CustomEvent('loc:change', { detail: key }));
  }
  if (params.get('location')) setLoc(params.get('location'));

  /* ---------- Tabs (WAI-ARIA tabs pattern) ---------- */
  function initTabs(list) {
    const tabs = $$('[role="tab"]', list);
    const usesHash = list.hasAttribute('data-hash');
    const select = (tab, opts = {}) => {
      tabs.forEach(t => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      if (opts.focus) tab.focus();
      if (list.dataset.sync === 'loc') setLoc(tab.dataset.key, opts.user && usesHash);
    };
    list._select = key => {
      const t = tabs.find(x => x.dataset.key === key);
      if (t) select(t);
    };
    tabs.forEach(t => t.addEventListener('click', () => select(t, { user: true })));
    list.addEventListener('keydown', e => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const map = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
      if (!(e.key in map)) return;
      e.preventDefault();
      select(tabs[(map[e.key] + tabs.length) % tabs.length], { focus: true, user: true });
    });
    const fromHash = usesHash && tabs.find(t => t.dataset.key === location.hash.slice(1));
    const fromQuery = list.dataset.sync === 'loc' && tabs.find(t => t.dataset.key === params.get('location'));
    select(fromHash || fromQuery || tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[0]);
  }
  $$('[role="tablist"]').forEach(initTabs);
  window.addEventListener('hashchange', () => {
    $$('[role="tablist"][data-hash]').forEach(l => l._select(location.hash.slice(1)));
  });

  /* ---------- Popovers (Book now chooser, mobile menu) ---------- */
  const popBtns = $$('[data-pop]');
  const popOf = b => document.getElementById(b.getAttribute('aria-controls'));
  const closePops = except => popBtns.forEach(b => {
    if (b === except) return;
    b.setAttribute('aria-expanded', 'false');
    popOf(b).hidden = true;
  });
  popBtns.forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = btn.getAttribute('aria-expanded') === 'true';
    closePops(btn);
    btn.setAttribute('aria-expanded', String(!open));
    popOf(btn).hidden = open;
    if (!open && e.detail === 0) { const first = $('a, button', popOf(btn)); if (first) first.focus(); }
  }));
  document.addEventListener('click', e => { if (!e.target.closest('.pop')) closePops(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const openBtn = popBtns.find(b => b.getAttribute('aria-expanded') === 'true');
    if (openBtn) { closePops(); openBtn.focus(); }
  });

  /* ---------- Dialog helpers ---------- */
  $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog.panel').forEach(d => d.addEventListener('click', e => {
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  }));

  /* ---------- Barber slide-over ---------- */
  const panel = $('#barber-panel');
  function openBarber(card) {
    if (!panel || !card) return;
    const d = card.dataset;
    const img = $('[data-p="img"]', panel);
    img.src = d.img; img.alt = 'Placeholder portrait for ' + d.name;
    $('[data-p="name"]', panel).textContent = d.name;
    $('[data-p="meta"]', panel).textContent = d.role + ' · ' + LOCATIONS[d.loc].name;
    $('[data-p="bio"]', panel).textContent = d.bio;
    $('[data-p="price"]', panel).textContent = '$' + d.price;
    $('[data-p="accepting"]', panel).hidden = d.accepting !== 'true';
    const chips = $('[data-p="chips"]', panel);
    chips.replaceChildren(...d.specs.split('|').map(s => {
      const li = document.createElement('li'); li.className = 'chip'; li.textContent = s; return li;
    }));
    const ig = $('[data-p="ig"]', panel);
    ig.hidden = !d.ig;
    if (d.ig) { ig.href = 'https://www.instagram.com/' + d.ig + '/'; $('span', ig).textContent = '@' + d.ig; }
    const book = $('[data-p="book"]', panel);
    book.href = d.book;
    $('span', book).textContent = 'Book with ' + d.name.split(' ')[0];
    const work = $('[data-p="work"]', panel);
    if (work) work.href = 'portfolio.html?location=' + d.loc;
    panel.scrollTop = 0;
    panel.showModal();
  }
  $$('.card__open').forEach(b => b.addEventListener('click', () => openBarber(b.closest('.card'))));

  // Deep link: barbers.html?barber=slug opens that profile on the right location tab
  const wanted = params.get('barber');
  if (wanted) {
    const card = $$('.card[data-slug]').find(c => c.dataset.slug === wanted);
    if (card) {
      $$('[role="tablist"][data-sync="loc"]').forEach(l => l._select(card.dataset.loc));
      setLoc(card.dataset.loc);
      openBarber(card);
    }
  }

  /* ---------- Portfolio filters ---------- */
  $$('[data-filters]').forEach(group => {
    const scope = document.getElementById(group.dataset.filters) || document;
    const btns = $$('[data-filter]', group);
    const apply = f => {
      btns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === f)));
      $$('.tile', scope).forEach(t => { t.hidden = !(f === 'all' || t.dataset.tags.split(' ').includes(f)); });
      $$('[data-filterable]', scope).forEach(c => {
        const empty = $('.empty', c);
        if (empty) empty.hidden = $$('.tile:not([hidden])', c).length > 0;
      });
    };
    btns.forEach(b => b.addEventListener('click', () => apply(b.dataset.filter)));
    apply('all');
  });

  /* ---------- Lightbox ---------- */
  const lb = $('#lightbox');
  let lbList = [], lbIdx = 0;
  function showTile(i) {
    lbIdx = (i + lbList.length) % lbList.length;
    const t = lbList[lbIdx], src = $('img', t), big = $('[data-lb="img"]', lb);
    big.src = t.dataset.full || src.src; big.alt = src.alt;
    $('[data-lb="cap"]', lb).innerHTML = $('.tile__cap', t).innerHTML;
    const [book, view] = $$('.tile__actions a', t);
    const lbBook = $('[data-lb="book"]', lb), lbView = $('[data-lb="view"]', lb);
    lbBook.href = book.href; lbBook.textContent = book.textContent;
    lbView.href = view.href; lbView.textContent = view.textContent;
    $('[data-lb="count"]', lb).textContent = (lbIdx + 1) + ' / ' + lbList.length;
  }
  if (lb) {
    $$('.tile__zoom').forEach(b => b.addEventListener('click', () => {
      const tile = b.closest('.tile');
      const scope = tile.closest('[data-filterable], .strip') || document;
      lbList = $$('.tile', scope).filter(t => !t.hidden && t.offsetParent !== null);
      showTile(lbList.indexOf(tile));
      lb.showModal();
    }));
    $('[data-lb="prev"]', lb).addEventListener('click', () => showTile(lbIdx - 1));
    $('[data-lb="next"]', lb).addEventListener('click', () => showTile(lbIdx + 1));
    lb.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') showTile(lbIdx - 1);
      if (e.key === 'ArrowRight') showTile(lbIdx + 1);
    });
    lb.addEventListener('click', e => { if (e.target.classList.contains('lightbox__stage')) lb.close(); });
  }

  /* ---------- Open-now status (computed in shop time zone) ---------- */
  function nowInShop() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = type => parts.find(p => p.type === type).value;
    return { day: DAYS.indexOf(get('weekday')), mins: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
  }
  const fmt = m => {
    const h = Math.floor(m / 60), mm = m % 60;
    return ((h + 11) % 12 + 1) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM');
  };
  function statusFor(key) {
    const H = LOCATIONS[key].hours, { day, mins } = nowInShop(), today = H[day];
    if (today && mins >= today[0] && mins < today[1]) return { open: true, text: 'Open now · til ' + fmt(today[1]) };
    if (today && mins < today[0]) return { open: false, text: 'Closed · opens ' + fmt(today[0]) };
    for (let i = 1; i <= 7; i++) {
      const d = (day + i) % 7;
      if (H[d]) return { open: false, text: 'Closed · opens ' + (i === 1 ? 'tomorrow ' : DAYS[d] + ' ') + fmt(H[d][0]) };
    }
    return { open: false, text: 'Closed' };
  }
  function paintStatus() {
    $$('[data-open-status]').forEach(el => {
      const s = statusFor(el.dataset.openStatus);
      el.dataset.state = s.open ? 'open' : 'closed';
      el.textContent = s.text;
    });
    const { day } = nowInShop();
    $$('[data-days]').forEach(row => row.classList.toggle('is-today', row.dataset.days.split(',').includes(String(day))));
  }
  paintStatus();
  setInterval(paintStatus, 60000);

  $$('[data-year]').forEach(el => { el.textContent = new Date().getFullYear(); });
})();
