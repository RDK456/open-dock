// Open Dock clock faces. Generated from the clock-faces design artifact; edit here, then run
// `node scripts/sync-clock-faces.ts` to refresh the phone copy (phone-app/src/clock-faces-source.ts).
// Plain browser JavaScript with no imports: the desktop imports it and the phone runs it inside a WebView.
// It defines globalThis.OpenDockClock = { faces, mount(host, options), setPaused, setBackgroundPaused, setFrameRate }.
(function () {
'use strict';
let HOUR12 = true;
// Canvas resolution cap for the face being built; small previews pass 1 to draw a quarter of the pixels.
let MAX_PIXEL_RATIO = 2;
const pixelRatio = () => Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parts = (d) => {
  const h24 = d.getHours(), h12 = h24 % 12 || 12;
  return { h24, h12, hd: HOUR12 ? h12 : h24, m: d.getMinutes(), s: d.getSeconds() + d.getMilliseconds() / 1000, ap: HOUR12 ? (h24 < 12 ? 'AM' : 'PM') : '', day: DAYS[d.getDay()], date: `${MONTHS[d.getMonth()]} ${d.getDate()}` };
};
const hhmm = (p) => `${p.hd}:${String(p.m).padStart(2, '0')}`;

// Color helpers: faces derive their palette from one picked color.
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360} ${clamp(s, 0, 100)}% ${clamp(l, 0, 100)}%)`;

// --- Themes
// Most faces are typographic and follow the app's light or dark look (PALETTES). The scene faces (SCENE) are the
// point of being dark, like a Nixie tube, a CRT or an aurora, so they keep their dark plate in both themes.
// Dark is the original look, value for value.
const PALETTES = {
  dark: { light: false, plate: '#111215', plate2: '#0d0e12', fg: '#ececef', muted: '#a1a1aa', faint: '#5c5c66', line: '#2a2b31', line2: '#24252c', track: '#1f2026', dim: '#2c2d34', dim2: '#3a3b44', dial: '#16171b', dial2: '#16171c', stripDim: '#3f3f46', onAccent: '#0b0b0e', tile: '#f3f1ea', onWater: 'rgba(8,9,12,0.9)', fade: 'rgba(10,10,13,0.32)', cover: '#0a0a0d', thread: 'rgba(255,255,255,0.05)' },
  light: { light: true, plate: '#fafafa', plate2: '#f4f4f6', fg: '#18181b', muted: '#52525b', faint: '#8a8a94', line: '#d4d4da', line2: '#d4d4da', track: '#e6e6eb', dim: '#d9d9df', dim2: '#b4b4bd', dial: '#ffffff', dial2: '#ffffff', stripDim: '#b4b4bd', onAccent: '#ffffff', tile: '#ffffff', onWater: 'rgba(255,255,255,0.95)', fade: 'rgba(244,244,246,0.32)', cover: '#f4f4f6', thread: 'rgba(24,24,27,0.09)' },
};
const SCENE = new Set(['flip', 'orbit', 'led', 'nixie', 'sky', 'tape', 'radar', 'swarm', 'lava', 'aurora', 'slots', 'crt', 'ferro', 'pong', 'sand']);
let theme = 'dark';
// The palette of the face being built: a face reads it once at the top of build, so faces drawn in different
// themes (a scene face and a light one side by side) never share it.
let BUILD_PAL = PALETTES.dark;
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16), f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(n >> 16 & 255) + 0.7152 * f(n >> 8 & 255) + 0.0722 * f(n & 255);
};
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), ch = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [ch(0), ch(8), ch(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
// How bright a color may stay on a light plate depends on its hue: a yellow is bright at the luminance where a blue
// already looks dark. These are the luminances good light UIs give each hue (blue about 0.24, pink 0.22, orange 0.30,
// green 0.40, yellow 0.46), blended between the anchors, so every color the user picks comes out vivid, not muddy.
const CAPS = [[0, 0.2], [20, 0.24], [35, 0.3], [50, 0.4], [60, 0.46], [85, 0.46], [110, 0.42], [150, 0.4], [180, 0.36], [200, 0.3], [225, 0.24], [255, 0.19], [285, 0.19], [320, 0.22], [345, 0.22], [360, 0.2]];
function capFor(h) {
  h = ((h % 360) + 360) % 360;
  for (let i = 1; i < CAPS.length; i++) if (h <= CAPS[i][0]) { const [h0, c0] = CAPS[i - 1], [h1, c1] = CAPS[i]; return c0 + (c1 - c0) * (h - h0) / (h1 - h0); }
  return CAPS[CAPS.length - 1][1];
}
// The user's color made to sit on a light plate without turning to mud: its own hue, a little more saturation (never
// neon), and the yellow-green band leaning toward gold as it darkens. `k` scales the hue's allowance (derived shades).
function forLight(hex, k = 1) {
  let [h, s, l] = hexToHsl(hex);
  const cap = capFor(h) * k;
  if (h >= 46 && h <= 72) h -= 10;
  if (s > 15) s = Math.min(92, s + 8);
  else if (l > 50) l = 100 - l; // white and pale greys become dark ink: a white clock on a light screen would vanish
  while (l > 6 && lum(hslToHex(h, s, l)) > cap) l -= 1;
  return hslToHex(h, s, l);
}
// Dark or white, whichever reads better on a fill of this color.
const onColor = (hex) => (lum(hex) > 0.2 ? '#18181b' : '#ffffff');
const shades = (hex, onLight = false) => {
  const [h, s, l] = hexToHsl(hex);
  if (onLight) return { base: hex, light: forLight(hslToHex(h, s, Math.min(60, l + 8)), 1.15), shift: forLight(hslToHex(h + 38, s, l), 1.05), deep: forLight(hslToHex(h - 24, s, Math.max(18, l - 12)), 0.7) };
  return { base: hex, light: hsl(h, s, Math.min(88, l + 14)), shift: hsl(h + 38, s, l), deep: hsl(h - 24, s, Math.max(30, l - 10)) };
};

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const restart = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };

// Each face: build(root, w, h, color) -> tick(date). Sizes come from the block only.
const FIRST_FACES = [
  {
    id: 'digital', name: 'Digital', color: false,
    blurb: 'A large, clean time with the date. The everyday default.',
    motion: '<b>Motion:</b> the colon blinks each second; a digit rolls up when it changes.',
    build(root, w, h) {
      const f = el('div', 'f-digital'); root.append(f);
      const pad = Math.min(12, h * 0.12), strip = h < 70;
      const time = el('div', 'time'), date = el('div', 'date');
      // Width of "12:34" plus AM/PM in em, for sizing.
      const em = 4 * 0.6 + 0.3 + 0.75;
      let size;
      if (strip) {
        const showDate = w >= 200;
        size = Math.min((h - 2 * pad) * 0.86, (w - 2 * pad) * (showDate ? 0.6 : 1) / em);
        f.style.gap = `${size * 0.4}px`;
        f.append(time);
        if (showDate) { date.style.fontSize = `${Math.max(9, size * 0.34)}px`; f.append(date); }
      } else {
        const showDate = h >= 80;
        size = Math.min((h - 2 * pad) * (showDate ? 0.6 : 0.85), (w - 2 * pad) / em);
        f.style.flexDirection = 'column'; f.style.gap = `${size * 0.12}px`;
        f.append(time);
        if (showDate) { date.style.fontSize = `${Math.max(9, size * 0.2)}px`; f.append(date); }
      }
      time.style.fontSize = `${size}px`;
      const slots = [el('span', 'd'), el('span', 'd'), el('span', 'c', ':'), el('span', 'd'), el('span', 'd'), el('span', 'ap')];
      time.append(...slots);
      let last = '';
      return (d) => {
        const p = parts(d), str = `${String(p.hd).padStart(2, ' ')}${String(p.m).padStart(2, '0')}`;
        slots[2].classList.toggle('dim', Math.floor(p.s) % 2 === 1);
        if (str === last) return;
        [0, 1, 3, 4].forEach((slot, i) => {
          const ch = str[i] === ' ' ? '' : str[i];
          if (slots[slot].textContent !== ch) { slots[slot].textContent = ch; if (last) restart(slots[slot], 'roll'); }
        });
        slots[0].style.display = str[0] === ' ' ? 'none' : '';
        slots[5].textContent = p.ap;
        date.innerHTML = strip ? `${p.day}<br>${p.date}` : `${p.day}, ${p.date}`;
        last = str;
      };
    },
  },
  {
    id: 'analog', name: 'Analog', color: true,
    blurb: 'A minimal dial with a sweeping second hand. Your color marks the hours and the second hand.',
    motion: '<b>Motion:</b> the second hand sweeps smoothly instead of ticking.',
    build(root, w, h, color) {
      const PAL = BUILD_PAL;
      const f = el('div', 'f-analog'); root.append(f);
      const pad = Math.min(12, h * 0.1), wide = w / h >= 2;
      const dial = Math.max(20, wide ? h - 2 * pad : Math.min(w, h) - 2 * pad);
      const c = shades(color, PAL.light);
      const tickCount = dial < 70 ? 12 : 60;
      const ticks = Array.from({ length: tickCount }, (_, i) => {
        const major = tickCount === 12 || i % 5 === 0, a = i * (360 / tickCount);
        return `<line x1="50" y1="${major ? 6 : 5}" x2="50" y2="${major ? 13 : 8}" stroke="${major ? c.base : PAL.dim2}" stroke-width="${major ? 2.4 : 1}" stroke-linecap="round" transform="rotate(${a} 50 50)"/>`;
      }).join('');
      f.insertAdjacentHTML('beforeend', `<svg width="${dial}" height="${dial}" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="${PAL.dial}" stroke="${PAL.line}"/>${ticks}
        <line class="hh" x1="50" y1="54" x2="50" y2="27" stroke="${PAL.fg}" stroke-width="4.4" stroke-linecap="round"/>
        <line class="mh" x1="50" y1="55" x2="50" y2="15" stroke="${PAL.fg}" stroke-width="3" stroke-linecap="round"/>
        <line class="sh" x1="50" y1="60" x2="50" y2="11" stroke="${c.base}" stroke-width="1.4" stroke-linecap="round"/>
        <circle cx="50" cy="50" r="3.2" fill="${c.base}"/><circle cx="50" cy="50" r="1.3" fill="${PAL.dial}"/></svg>`);
      const svg = f.querySelector('svg'), hh = svg.querySelector('.hh'), mh = svg.querySelector('.mh'), sh = svg.querySelector('.sh');
      let t = null, s = null;
      if (wide) {
        const side = el('div', 'side'); f.append(side); f.style.gap = `${pad * 1.2}px`; f.style.justifyContent = 'flex-start'; f.style.paddingLeft = `${pad}px`;
        const room = w - 3 * pad - dial;
        const size = Math.min(dial * 0.42, room / 3.3);
        t = el('div', 't'); t.style.fontSize = `${size}px`; side.append(t);
        if (dial >= 40) { s = el('div', 's'); s.style.fontSize = `${Math.max(9, size * 0.36)}px`; side.append(s); }
      }
      return (d) => {
        const p = parts(d), m = p.m + p.s / 60, hr = (p.h24 % 12) + m / 60;
        sh.setAttribute('transform', `rotate(${p.s * 6} 50 50)`);
        mh.setAttribute('transform', `rotate(${m * 6} 50 50)`);
        hh.setAttribute('transform', `rotate(${hr * 30} 50 50)`);
        if (t) t.textContent = hhmm(p);
        if (s) s.textContent = `${p.day}, ${p.date}`;
      };
    },
  },
  {
    id: 'flip', name: 'Flip', color: false,
    blurb: 'Split-flap cards like an old departure board. Fixed graphite cards.',
    motion: '<b>Motion:</b> each card folds down to the next digit when it changes.',
    build(root, w, h) {
      const f = el('div', 'f-flip'); root.append(f);
      const pad = Math.min(12, h * 0.1);
      const showDate = h >= 140;
      const dateH = showDate ? Math.max(12, h * 0.1) : 0;
      const gap = Math.max(3, w * 0.012);
      const dotW = Math.max(6, w * 0.03);
      const byWidth = (w - 2 * pad - 3 * gap - dotW - 2 * gap) / 4 * 1.42;
      const cardH = Math.max(18, Math.min(h - 2 * pad - dateH * 1.6, byWidth));
      const cardW = cardH / 1.42;
      const row = el('div', 'row'); row.style.gap = `${gap}px`; f.append(row); f.style.gap = `${dateH * 0.5}px`;
      const font = cardH * 0.86, radius = Math.max(3, cardH * 0.08);
      const half = (cls, digit) => `<div class="half ${cls}"><span style="height:${cardH}px;line-height:${cardH}px">${digit}</span></div>`;
      const cards = [0, 1, 2, 3].map(() => {
        const c = el('div', 'card'); c.style.cssText = `width:${cardW}px;height:${cardH}px;font-size:${font}px;border-radius:${radius}px`;
        c.innerHTML = half('top', '') + half('bot', '') + half('ftop', '') + half('fbot', '') + '<div class="hinge"></div>';
        c.dataset.v = '';
        return c;
      });
      const dots = el('div', 'dots'); dots.style.gap = `${cardH * 0.18}px`; dots.style.width = `${dotW}px`; dots.style.alignItems = 'center';
      dots.innerHTML = `<i style="width:${dotW * 0.55}px;height:${dotW * 0.55}px"></i><i style="width:${dotW * 0.55}px;height:${dotW * 0.55}px"></i>`;
      row.append(cards[0], cards[1], dots, cards[2], cards[3]);
      let date = null;
      if (showDate) { date = el('div', 'date'); date.style.fontSize = `${dateH}px`; f.append(date); }
      const set = (card, v, animate) => {
        const old = card.dataset.v;
        if (old === v) return;
        const [top, bot, ftop, fbot] = card.querySelectorAll('.half span');
        card.dataset.v = v;
        if (!animate || old === '') { top.textContent = bot.textContent = v; ftop.textContent = fbot.textContent = ''; card.classList.remove('go'); return; }
        // New top waits underneath; the old top folds down, then the new bottom folds into place.
        top.textContent = v; ftop.textContent = old; fbot.textContent = v; bot.textContent = old;
        restart(card, 'go');
        clearTimeout(card._t);
        card._t = setTimeout(() => { bot.textContent = v; card.classList.remove('go'); ftop.textContent = fbot.textContent = ''; }, 560);
      };
      let first = true;
      return (d) => {
        const p = parts(d), str = `${String(p.hd).padStart(2, '0')}${String(p.m).padStart(2, '0')}`;
        cards.forEach((c, i) => set(c, str[i], !first));
        first = false;
        if (date) date.textContent = `${p.day} · ${p.date}`;
      };
    },
  },
  {
    id: 'rings', name: 'Rings', color: true,
    blurb: 'Three rings fill through the hour, minute and second. Shades come from your color.',
    motion: '<b>Motion:</b> the seconds ring sweeps continuously; the others creep forward.',
    build(root, w, h, color) {
      const PAL = BUILD_PAL;
      const f = el('div', 'f-rings'); root.append(f);
      const pad = Math.min(12, h * 0.1), wide = w / h >= 1.8;
      const size = Math.max(22, wide ? h - 2 * pad : Math.min(w, h) - 2 * pad);
      const c = shades(color, PAL.light);
      const R = [44, 33, 22], C = R.map((r) => 2 * Math.PI * r), stroke = size < 60 ? 9 : 7.5;
      const ring = (i, col) => `<circle cx="50" cy="50" r="${R[i]}" fill="none" stroke="${PAL.track}" stroke-width="${stroke}"/><circle class="r${i}" cx="50" cy="50" r="${R[i]}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${C[i]}" transform="rotate(-90 50 50)"/>`;
      const center = !wide && size >= 110;
      f.insertAdjacentHTML('beforeend', `<svg width="${size}" height="${size}" viewBox="0 0 100 100">${ring(0, c.base)}${ring(1, c.light)}${ring(2, c.shift)}${center ? '<text class="ct" x="50" y="54" text-anchor="middle" font-size="12" font-weight="600" fill="' + PAL.fg + '" font-family="IBM Plex Sans, system-ui">0:00</text>' : ''}</svg>`);
      const arcs = [0, 1, 2].map((i) => f.querySelector(`.r${i}`)), ct = f.querySelector('.ct');
      let t = null, s = null;
      if (wide) {
        const side = el('div', 'side'); f.append(side); f.style.gap = `${pad * 1.2}px`; f.style.justifyContent = 'flex-start'; f.style.paddingLeft = `${pad}px`;
        const fs = Math.min(size * 0.42, (w - 3 * pad - size) / 3.3);
        t = el('div', 't'); t.style.fontSize = `${fs}px`; side.append(t);
        if (size >= 40) { s = el('div', 's'); s.style.fontSize = `${Math.max(9, fs * 0.36)}px`; side.append(s); }
      }
      return (d) => {
        const p = parts(d), m = p.m + p.s / 60;
        const frac = [((p.h24 % 12) + m / 60) / 12, m / 60, p.s / 60];
        arcs.forEach((a, i) => a.setAttribute('stroke-dashoffset', C[i] * (1 - Math.max(0.002, frac[i]))));
        if (ct) ct.textContent = hhmm(p);
        if (t) t.textContent = hhmm(p);
        if (s) s.textContent = `${p.day}, ${p.date}`;
      };
    },
  },
  {
    id: 'word', name: 'Words', color: true,
    blurb: 'Tells the time in words. Big blocks get a lit letter grid, small ones a sentence.',
    motion: '<b>Motion:</b> letters glow on and fade off every five minutes; corner dots count the minutes between.',
    build(root, w, h, color) {
      const f = el('div', 'f-word'); f.style.setProperty('--wc', color); root.append(f);
      const pad = Math.min(14, h * 0.1);
      const ROWS = ['ITLISASAMPM', 'ACQUARTERDC', 'TWENTYFIVEX', 'HALFSTENFTO', 'PASTERUNINE', 'ONESIXTHREE', 'FOURFIVETWO', 'EIGHTELEVEN', 'SEVENTWELVE', 'TENSEOCLOCK'];
      const W = { IT: [0, 0, 2], IS: [0, 3, 2], A: [1, 0, 1], QUARTER: [1, 2, 7], TWENTY: [2, 0, 6], FIVE: [2, 6, 4], HALF: [3, 0, 4], TEN: [3, 5, 3], TO: [3, 9, 2], PAST: [4, 0, 4], OCLOCK: [9, 5, 6] };
      const HOURS = [[5, 0, 3], [6, 8, 3], [5, 6, 5], [6, 0, 4], [6, 4, 4], [5, 3, 3], [8, 0, 5], [7, 0, 5], [4, 7, 4], [9, 0, 3], [7, 5, 6], [8, 5, 6]];
      const NAMES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
      const MIN = { 0: [], 5: ['FIVE', 'PAST'], 10: ['TEN', 'PAST'], 15: ['A', 'QUARTER', 'PAST'], 20: ['TWENTY', 'PAST'], 25: ['TWENTY', 'FIVE', 'PAST'], 30: ['HALF', 'PAST'], 35: ['TWENTY', 'FIVE', 'TO'], 40: ['TWENTY', 'TO'], 45: ['A', 'QUARTER', 'TO'], 50: ['TEN', 'TO'], 55: ['FIVE', 'TO'] };
      const PHRASE = { 0: '', 5: 'five past', 10: 'ten past', 15: 'quarter past', 20: 'twenty past', 25: 'twenty-five past', 30: 'half past', 35: 'twenty-five to', 40: 'twenty to', 45: 'quarter to', 50: 'ten to', 55: 'five to' };
      const now5 = (p) => { const m5 = Math.floor(p.m / 5) * 5, hr = ((p.h24 + (m5 > 30 ? 1 : 0)) % 12 + 11) % 12; return { m5, hr, extra: p.m % 5 }; };
      if (w >= 170 && h >= 150) {
        const cell = Math.min((w - 2 * pad) / 11.6, (h - 2 * pad) / 10.6);
        const grid = el('div', 'grid'); grid.style.cssText = `grid-template-columns:repeat(11,${cell}px);grid-auto-rows:${cell}px;font-size:${cell * 0.6}px`;
        const cells = ROWS.map((row) => [...row].map((ch) => { const s = el('span', '', ch); grid.append(s); return s; }));
        const dots = [[-0.45, -0.45], [11.05, -0.45], [11.05, 9.85], [-0.45, 9.85]].map(([x, y]) => { const d = el('i', 'mdot'); const r = Math.max(3, cell * 0.18); d.style.cssText = `width:${r}px;height:${r}px;left:${x * cell + cell * 0.2}px;top:${y * cell + cell * 0.25}px`; grid.append(d); return d; });
        f.append(grid);
        let last = '';
        return (d) => {
          const { m5, hr, extra } = now5(parts(d)), key = `${m5}:${hr}:${extra}`;
          if (key === last) return; last = key;
          const lit = new Set();
          const mark = ([r, c, n]) => { for (let i = 0; i < n; i++) lit.add(`${r}:${c + i}`); };
          ['IT', 'IS', ...MIN[m5]].forEach((k) => mark(W[k]));
          mark(HOURS[hr]); if (m5 === 0) mark(W.OCLOCK);
          cells.forEach((row, r) => row.forEach((s, c) => s.classList.toggle('on', lit.has(`${r}:${c}`))));
          dots.forEach((dot, i) => dot.classList.toggle('on', i < extra));
        };
      }
      const phrase = el('div', 'phrase'); f.append(phrase);
      const twoLines = h >= 70;
      let last = '';
      return (d) => {
        const { m5, hr } = now5(parts(d)), key = `${m5}:${hr}`;
        if (key === last) return;
        const lead = m5 === 0 ? NAMES[hr] : PHRASE[m5], tail = m5 === 0 ? "o'clock" : NAMES[hr];
        const longest = twoLines ? Math.max(lead.length, tail.length) : lead.length + tail.length + 1;
        const size = twoLines ? Math.min((h - 2 * pad) / 2.4, (w - 2 * pad) / (longest * 0.5)) : Math.min((h - 2 * pad) * 0.62, (w - 2 * pad) / (longest * 0.5));
        phrase.style.fontSize = `${size}px`;
        phrase.innerHTML = `<em>${lead}</em>${twoLines ? '<br>' : ' '}${tail}`;
        if (last) restart(phrase, 'swap');
        last = key;
      };
    },
  },
  {
    id: 'glow', name: 'Glow', color: true,
    blurb: 'Heavy numerals filled with a slow-moving gradient built from your color.',
    motion: '<b>Motion:</b> the gradient drifts through the digits and a soft aura breathes behind them.',
    build(root, w, h, color) {
      const PAL = BUILD_PAL;
      const f = el('div', 'f-glow'); root.append(f);
      const c = shades(color, PAL.light), pad = Math.min(12, h * 0.1);
      const grad = `linear-gradient(100deg, ${c.base}, ${c.shift}, ${c.light}, ${c.deep}, ${c.base})`;
      const aura = el('div', 'aura'); aura.style.background = `radial-gradient(closest-side, ${c.base}, transparent)`; aura.style.filter = `blur(${Math.max(8, h * 0.12)}px)`;
      const showDate = h >= 80;
      const size = Math.min((h - 2 * pad) * (showDate ? 0.66 : 0.88), (w - 2 * pad) / 2.75);
      const t = el('div', 't'); t.style.fontSize = `${size}px`; t.style.backgroundImage = grad;
      f.append(aura, t);
      let s = null;
      if (showDate) { s = el('div', 's'); s.style.fontSize = `${Math.max(9, size * 0.17)}px`; s.style.marginTop = `${size * 0.06}px`; f.append(s); }
      return (d) => { const p = parts(d); t.textContent = hhmm(p); if (s) s.textContent = `${p.day}, ${p.date}`; };
    },
  },
];

// --- Second set: canvas helpers
function canvasFace(root, w, h) {
  const dpr = pixelRatio();
  const cv = el('canvas');
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.cssText = `position:absolute;inset:0;width:${w}px;height:${h}px`;
  root.append(cv);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}
// Largest font size (px) at which `text` fits maxW x maxH.
function fitFont(ctx, text, font, maxW, maxH) {
  ctx.font = `${font} 100px ${font.includes('800') ? 'Bricolage Grotesque' : 'IBM Plex Sans'}, system-ui, sans-serif`;
  const wAt100 = ctx.measureText(text).width || 1;
  return Math.max(6, Math.min(maxH, maxW / wAt100 * 100));
}
const setFont = (ctx, weight, size, family = 'IBM Plex Sans') => { ctx.font = `${weight} ${size}px ${family}, system-ui, sans-serif`; };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
const seconds = () => performance.now() / 1000;

const LED_DIGITS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], 3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

// Sky colours through the day: [hour, top, horizon].
const SKY = [[0, '#060918', '#0d1430'], [5, '#0a1030', '#1d2752'], [6.2, '#2b2f63', '#e98a64'], [7.5, '#4f86d6', '#f4c896'], [12, '#3a7ad6', '#a5cff3'], [16.8, '#4677c4', '#f2b47c'], [18.4, '#3a2d6c', '#e66d5a'], [19.8, '#121637', '#2b2453'], [24, '#060918', '#0d1430']];
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) + ((((pb >> s) & 255) - ((pa >> s) & 255)) * t));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
function skyAt(hour) {
  for (let i = 0; i < SKY.length - 1; i++) {
    const [h0, t0, b0] = SKY[i], [h1, t1, b1] = SKY[i + 1];
    if (hour >= h0 && hour <= h1) { const t = (hour - h0) / (h1 - h0); return [mixHex(t0, t1, t), mixHex(b0, b1, t)]; }
  }
  return [SKY[0][1], SKY[0][2]];
}

const NEW_FACES = [
  {
    id: 'tide', name: 'Tide', color: true,
    blurb: 'Water rises through the hour and drains at the top of the next. The digits invert where the water covers them.',
    motion: '<b>Motion:</b> two wave layers roll across the surface and bubbles drift up.',
    build(root, w, h, color) {
      const PAL = BUILD_PAL;
      const ctx = canvasFace(root, w, h), c = shades(color, PAL.light), pad = Math.min(12, h * 0.1), strip = h < 80;
      const bubbles = Array.from({ length: Math.max(3, Math.round(w / 60)) }, () => ({ x: Math.random() * w, y: h + Math.random() * h, r: 1 + Math.random() * 2.2, v: 8 + Math.random() * 14 }));
      let lastT = seconds();
      const surface = (level, t, phase, amp) => {
        ctx.beginPath(); ctx.moveTo(0, h);
        for (let x = 0; x <= w + 4; x += 4) ctx.lineTo(x, level + Math.sin(x * 0.035 + t * 1.7 + phase) * amp + Math.sin(x * 0.013 - t * 0.9 + phase) * amp * 0.7);
        ctx.lineTo(w, h); ctx.closePath();
      };
      return (d) => {
        const p = parts(d), t = seconds(), dt = Math.min(0.1, t - lastT); lastT = t;
        const fill = (p.m + p.s / 60) / 60, level = h - (h - 4) * (0.04 + fill * 0.92), amp = Math.max(1.5, h * 0.022);
        const time = hhmm(p), dateText = `${p.day}, ${p.date}`;
        const showDate = !strip && h >= 110;
        const size = fitFont(ctx, time, '600', w - 2 * pad, (h - 2 * pad) * (showDate ? 0.5 : 0.78));
        const cy = showDate ? h * 0.46 : h / 2;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = PAL.plate2; ctx.fillRect(0, 0, w, h);
        const drawText = (style) => {
          ctx.fillStyle = style; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          setFont(ctx, 600, size); ctx.fillText(time, w / 2, cy);
          if (showDate) { setFont(ctx, 500, Math.max(10, size * 0.2)); ctx.fillText(dateText, w / 2, cy + size * 0.62); }
        };
        drawText(PAL.fg);
        surface(level - amp, t, 2.1, amp * 0.8); ctx.fillStyle = rgba(c.base, 0.28); ctx.fill();
        surface(level, t, 0, amp);
        const g = ctx.createLinearGradient(0, level, 0, h); g.addColorStop(0, c.light); g.addColorStop(1, c.deep);
        ctx.fillStyle = g; ctx.fill();
        ctx.save(); surface(level, t, 0, amp); ctx.clip(); drawText(PAL.light ? onColor(color) : PAL.onWater);
        for (const b of bubbles) {
          b.y -= b.v * dt; b.x += Math.sin(t * 2 + b.r) * 0.2;
          if (b.y < level) { b.y = h + Math.random() * 20; b.x = Math.random() * w; }
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1; ctx.stroke();
        }
        ctx.restore();
      };
    },
  },
  {
    id: 'orbit', name: 'Orbit', color: true,
    blurb: 'A tiny solar system: the hour planet and minute moon circle the time, and a comet laps every minute.',
    motion: '<b>Motion:</b> the comet streaks round with a fading tail; the planets drift into place.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), c = shades(color), pad = Math.min(12, h * 0.1), wide = w / h >= 1.8;
      const size = wide ? h - 2 * pad : Math.min(w, h) - 2 * pad, R = size / 2;
      const cx = wide ? pad + R : w / 2, cy = h / 2;
      const stars = Array.from({ length: Math.round(w * h / 900) }, () => [Math.random() * w, Math.random() * h, Math.random() * 6]);
      const at = (deg, r) => [cx + Math.cos((deg - 90) * Math.PI / 180) * r, cy + Math.sin((deg - 90) * Math.PI / 180) * r];
      const glow = (x, y, r, col) => { ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = r * 3; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore(); };
      return (d) => {
        const p = parts(d), m = p.m + p.s / 60, hr = (p.h24 % 12) + m / 60, t = seconds();
        ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#0a0b10'; ctx.fillRect(0, 0, w, h);
        for (const [x, y, ph] of stars) { ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.25 * (0.5 + 0.5 * Math.sin(t * 1.3 + ph))})`; ctx.fillRect(x, y, 1, 1); }
        ctx.lineWidth = 1;
        [[0.46, []], [0.72, []], [0.95, [2, 4]]].forEach(([f, dash]) => { ctx.setLineDash(dash); ctx.strokeStyle = '#272832'; ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); });
        ctx.setLineDash([]);
        // Comet: one lap per minute with a fading tail.
        const sDeg = p.s * 6;
        for (let i = 24; i >= 0; i--) {
          const [x, y] = at(sDeg - i * 1.6, R * 0.95);
          ctx.fillStyle = rgba(color, (1 - i / 24) * 0.5); ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, R * 0.03 * (1 - i / 24)), 0, Math.PI * 2); ctx.fill();
        }
        glow(...at(sDeg, R * 0.95), Math.max(1.5, R * 0.03), c.light);
        glow(...at(m * 6, R * 0.72), Math.max(2, R * 0.065), c.light);
        glow(...at(hr * 30, R * 0.46), Math.max(3, R * 0.1), c.base);
        const center = !wide && size >= 110;
        if (center) {
          ctx.fillStyle = '#ececef'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          setFont(ctx, 600, R * 0.24); ctx.fillText(hhmm(p), cx, cy);
        } else glow(cx, cy, Math.max(2, R * 0.08), c.shift);
        if (wide) {
          const x = cx + R + pad * 1.4, room = w - x - pad;
          const size2 = fitFont(ctx, '12:59', '600', room, size * 0.42);
          ctx.fillStyle = '#ececef'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          setFont(ctx, 600, size2); ctx.fillText(hhmm(p), x, cy - (size >= 40 ? size2 * 0.18 : 0));
          if (size >= 40) { ctx.fillStyle = '#a1a1aa'; setFont(ctx, 500, Math.max(9, size2 * 0.36)); ctx.fillText(`${p.day}, ${p.date}`, x, cy + size2 * 0.5); }
        }
      };
    },
  },
  {
    id: 'led', name: 'LED Board', color: true,
    blurb: 'A dot-matrix display like a station board. On big blocks a row of dots counts the seconds.',
    motion: '<b>Motion:</b> dots fade on and off as digits change; the colon blinks; the seconds row fills.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), pad = Math.min(12, h * 0.1);
      const COLS = 25, showSec = h >= 110;
      const pitch = Math.min((w - 2 * pad) / COLS, (h - 2 * pad) / (showSec ? 10 : 7));
      const x0 = (w - pitch * COLS) / 2 + pitch / 2, y0 = (h - pitch * (showSec ? 10 : 7)) / 2 + pitch / 2;
      const glowOn = pitch >= 4;
      const level = Array.from({ length: 7 }, () => new Float32Array(COLS));
      const target = Array.from({ length: 7 }, () => new Uint8Array(COLS));
      let first = true;
      return (d) => {
        const p = parts(d), str = `${String(p.hd).padStart(2, ' ')}${String(p.m).padStart(2, '0')}`;
        for (const row of target) row.fill(0);
        const put = (ch, col) => LED_DIGITS[ch].forEach((bits, r) => [...bits].forEach((b, i) => { if (b === '1') target[r][col + i] = 1; }));
        put(str[0], 0); put(str[1], 6); put(str[2], 14); put(str[3], 20);
        if (p.s % 1 < 0.6) { target[2][12] = 1; target[4][12] = 1; }
        ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#0b0b0e'; ctx.fillRect(0, 0, w, h);
        const r = pitch * 0.36;
        for (let row = 0; row < 7; row++) for (let col = 0; col < COLS; col++) {
          const v = level[row][col] = first ? target[row][col] : level[row][col] + (target[row][col] - level[row][col]) * 0.18;
          const x = x0 + col * pitch, y = y0 + row * pitch;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = '#1b1c22'; ctx.fill();
          if (v > 0.02) {
            ctx.save(); ctx.globalAlpha = v; if (glowOn) { ctx.shadowColor = color; ctx.shadowBlur = pitch * 0.9; }
            ctx.fillStyle = color; ctx.fill(); ctx.restore();
          }
        }
        if (showSec) {
          const lit = Math.floor(p.s / 60 * COLS);
          for (let col = 0; col < COLS; col++) {
            const x = x0 + col * pitch, y = y0 + 9 * pitch;
            ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
            ctx.fillStyle = col <= lit ? rgba(color, col === lit ? 1 : 0.55) : '#1b1c22'; ctx.fill();
          }
        }
        first = false;
      };
    },
  },
  {
    id: 'nixie', name: 'Nixie', color: false,
    blurb: 'Glass tubes with glowing filament digits stacked inside. Warm orange, the way the real ones look.',
    motion: '<b>Motion:</b> the new digit flickers to life as the old cathode fades.',
    build(root, w, h) {
      const f = el('div', 'f-nixie'); root.append(f);
      const pad = Math.min(12, h * 0.08), gap = Math.max(3, w * 0.014), colonW = Math.max(6, w * 0.035);
      const tubeH = Math.max(20, Math.min(h - 2 * pad, (w - 2 * pad - 4 * gap - colonW) / 4 * 1.7));
      const tubeW = tubeH / 1.7;
      f.style.gap = `${gap}px`;
      const tubes = [0, 1, 2, 3].map(() => {
        const t = el('div', 'tube'); t.style.cssText = `width:${tubeW}px;height:${tubeH}px;font-size:${tubeH * 0.66}px;border-radius:${tubeW * 0.42}px ${tubeW * 0.42}px ${tubeW * 0.16}px ${tubeW * 0.16}px`;
        t.innerHTML = '<i class="mesh"></i>' + [1, 6, 9, 2, 8, 3, 0, 5, 7, 4].map((n) => `<span data-n="${n}">${n}</span>`).join('');
        return t;
      });
      const colon = el('div', 'ncolon'); colon.style.cssText = `width:${colonW}px;gap:${tubeH * 0.2}px`;
      colon.innerHTML = `<i style="width:${colonW * 0.5}px;height:${colonW * 0.5}px"></i><i style="width:${colonW * 0.5}px;height:${colonW * 0.5}px"></i>`;
      f.append(tubes[0], tubes[1], colon, tubes[2], tubes[3]);
      let last = '';
      return (d) => {
        const p = parts(d), str = `${String(p.hd).padStart(2, '0')}${String(p.m).padStart(2, '0')}`;
        colon.classList.toggle('dim', p.s % 1 > 0.5);
        if (str === last) return;
        tubes.forEach((t, i) => {
          if (last && last[i] === str[i]) return;
          t.querySelectorAll('span').forEach((s) => { s.classList.remove('lit', 'flick'); });
          const on = t.querySelector(`[data-n="${str[i]}"]`);
          on.classList.add('lit'); if (last) restart(on, 'flick');
        });
        last = str;
      };
    },
  },
  {
    id: 'sky', name: 'Daylight', color: false,
    blurb: 'The sun travels an arc from sunrise to sunset over a sky that changes through the day. At night the moon and stars take over.',
    motion: '<b>Motion:</b> the sky shifts colour by the hour; stars twinkle. Try the 1 h/s speed.',
    build(root, w, h) {
      const ctx = canvasFace(root, w, h), pad = Math.min(12, h * 0.1), strip = h < 90;
      const stars = Array.from({ length: Math.round(w * h / 500) }, () => [Math.random() * w, Math.random(), Math.random() * 6, Math.random() < 0.15 ? 1.6 : 1]);
      return (d) => {
        const p = parts(d), hour = p.h24 + (p.m + p.s / 60) / 60, t = seconds();
        const time = hhmm(p);
        const textSize = strip ? fitFont(ctx, time, '600', w * 0.38, (h - 2 * pad) * 0.7) : fitFont(ctx, time, '600', w * 0.5, Math.min(h * 0.2, 60));
        const groundH = strip ? 3 : Math.max(textSize * 1.5, h * 0.2);
        const hy = h - groundH;
        const arcW = strip ? w - textSize * 3.2 - 3 * pad : w - 2 * pad;
        const cx = strip ? pad + arcW / 2 : w / 2, rx = arcW / 2 * 0.92, ry = Math.max(8, hy - pad - Math.min(w, h) * 0.06) * 0.95;
        const [top, bottom] = skyAt(hour);
        const g = ctx.createLinearGradient(0, 0, 0, hy); g.addColorStop(0, top); g.addColorStop(1, bottom);
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        const night = hour < 5.5 || hour > 19.5 ? 1 : hour < 6.5 ? (6.5 - hour) : hour > 18.5 ? (hour - 18.5) : 0;
        if (night > 0) for (const [x, fy, ph, s] of stars) {
          const y = fy * hy * 0.9;
          ctx.fillStyle = `rgba(255,255,255,${night * (0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t * 1.5 + ph)))})`; ctx.fillRect(x, y, s, s);
        }
        ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(cx, hy, rx, ry, 0, Math.PI, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
        const body = Math.max(3, Math.min(w, h) * 0.055);
        const place = (f) => { const a = Math.PI * (1 - f); return [cx + Math.cos(a) * rx, hy - Math.sin(a) * ry]; };
        if (hour >= 6 && hour <= 18) {
          const [x, y] = place((hour - 6) / 12);
          ctx.save(); ctx.shadowColor = '#ffd27a'; ctx.shadowBlur = body * 4; ctx.fillStyle = '#ffe2a1'; ctx.beginPath(); ctx.arc(x, y, body, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        } else {
          const [x, y] = place((((hour + 6) % 24)) / 12 % 1);
          ctx.save(); ctx.shadowColor = '#cfd8ff'; ctx.shadowBlur = body * 2; ctx.fillStyle = '#e8ecff'; ctx.beginPath(); ctx.arc(x, y, body * 0.85, 0, Math.PI * 2); ctx.fill(); ctx.restore();
          ctx.fillStyle = top; ctx.beginPath(); ctx.arc(x + body * 0.35, y - body * 0.2, body * 0.75, 0, Math.PI * 2); ctx.fill();
        }
        if (!strip) {
          const gg = ctx.createLinearGradient(0, hy, 0, h); gg.addColorStop(0, '#15161c'); gg.addColorStop(1, '#0b0c10');
          ctx.fillStyle = gg; ctx.fillRect(0, hy, w, groundH);
          ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(0, hy, w, 1);
        }
        ctx.fillStyle = '#f4f4f5'; ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8;
        setFont(ctx, 600, textSize);
        if (strip) { ctx.textAlign = 'right'; ctx.fillText(time, w - pad, h / 2); }
        else {
          ctx.textAlign = 'left'; ctx.fillText(time, pad, hy + groundH / 2);
          ctx.textAlign = 'right'; ctx.fillStyle = '#a1a1aa'; setFont(ctx, 500, Math.max(9, textSize * 0.36)); ctx.fillText(`${p.day}, ${p.date}`, w - pad, hy + groundH / 2);
        }
        ctx.shadowBlur = 0;
      };
    },
  },
  {
    id: 'tape', name: 'Tuning Dial', color: true,
    blurb: 'Time scrolls past a fixed needle like an old radio dial. Works especially well in one-row strips.',
    motion: '<b>Motion:</b> the scale glides continuously under the needle.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), pad = Math.min(12, h * 0.1), strip = h < 90;
      const tapeH = strip ? h : Math.max(40, h * 0.42), tapeY = h - tapeH;
      const windowMin = strip ? 90 : 120, ppm = w / windowMin, cx = w / 2;
      return (d) => {
        const p = parts(d), nowMin = p.h24 * 60 + p.m + p.s / 60;
        ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#121318'; ctx.fillRect(0, tapeY, w, tapeH);
        const base = tapeY + tapeH * (strip ? 0.62 : 0.55);
        const labelSize = Math.max(8, Math.min(14, tapeH * 0.2));
        for (let mi = Math.floor(nowMin - windowMin / 2) - 1; mi <= nowMin + windowMin / 2 + 1; mi++) {
          const x = cx + (mi - nowMin) * ppm;
          const isHour = mi % 60 === 0, isQ = mi % 15 === 0, is5 = mi % 5 === 0;
          if (!is5 && ppm < 3) continue;
          const len = isHour ? tapeH * 0.36 : isQ ? tapeH * 0.24 : is5 ? tapeH * 0.15 : tapeH * 0.08;
          ctx.fillStyle = isHour ? '#d4d4d8' : isQ ? '#71717a' : '#3f3f46';
          ctx.fillRect(Math.round(x), base - len, isHour ? 2 : 1, len);
          if (isHour || (isQ && ppm > 4 && !strip)) {
            const hh = ((Math.floor(((mi % 1440) + 1440) % 1440 / 60)) % 12) || 12, mm = ((mi % 60) + 60) % 60;
            ctx.fillStyle = isHour ? '#d4d4d8' : '#71717a'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            setFont(ctx, isHour ? 600 : 500, isHour ? labelSize : labelSize * 0.82);
            ctx.fillText(isHour ? String(hh) : `:${String(mm).padStart(2, '0')}`, x, base + tapeH * 0.08);
          }
        }
        const fade = (x0, x1) => { const g = ctx.createLinearGradient(x0, 0, x1, 0); g.addColorStop(0, '#121318'); g.addColorStop(1, 'rgba(18,19,24,0)'); ctx.fillStyle = g; ctx.fillRect(Math.min(x0, x1), tapeY, Math.abs(x1 - x0), tapeH); };
        fade(0, w * 0.18); fade(w, w * 0.82);
        ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.fillStyle = color;
        ctx.fillRect(cx - 1, tapeY + 2, 2, tapeH - 4);
        ctx.beginPath(); ctx.moveTo(cx - 5, tapeY + 2); ctx.lineTo(cx + 5, tapeY + 2); ctx.lineTo(cx, tapeY + 9); ctx.fill(); ctx.restore();
        if (!strip) {
          const top = tapeY, size = fitFont(ctx, hhmm(p), '600', w - 2 * pad, top * 0.62);
          ctx.fillStyle = '#ececef'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          setFont(ctx, 600, size); ctx.fillText(hhmm(p), w / 2, top * 0.44);
          if (top > 70) { ctx.fillStyle = '#a1a1aa'; setFont(ctx, 500, Math.max(9, size * 0.2)); ctx.fillText(`${p.day}, ${p.date}`, w / 2, top * 0.44 + size * 0.62); }
        } else {
          ctx.fillStyle = 'rgba(12,13,16,0.85)'; const label = hhmm(p); setFont(ctx, 600, Math.max(10, h * 0.26));
          const tw = ctx.measureText(label).width + 10; ctx.fillRect(cx - tw / 2, 2, tw, h * 0.3);
          ctx.fillStyle = '#ececef'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(label, cx, 3);
        }
      };
    },
  },
  {
    id: 'poster', name: 'Poster', color: true,
    blurb: 'Editorial type: a huge outlined hour runs off the edges and the minutes sit on top in solid colour.',
    motion: '<b>Motion:</b> the hour drifts slowly; new minutes slide up into place.',
    build(root, w, h, color) {
      const PAL = BUILD_PAL;
      const f = el('div', 'f-poster'); root.append(f);
      const strip = h < 80, c = shades(color, PAL.light);
      const hourSize = h * (strip ? 1.5 : 1.25);
      const hourEl = el('div', 'ph'); hourEl.style.cssText = `font-size:${hourSize}px;-webkit-text-stroke:${Math.max(1, hourSize * 0.012)}px ${c.base};left:${-hourSize * 0.04}px;top:${(h - hourSize) / 2 - hourSize * 0.06}px`;
      const minSize = Math.min(h * (strip ? 0.82 : 0.5), w * 0.34);
      const minEl = el('div', 'pm'); minEl.style.cssText = `font-size:${minSize}px;color:${c.light};right:${Math.max(6, w * 0.04)}px;bottom:${strip ? (h - minSize) / 2 : h * 0.06}px`;
      f.append(hourEl, minEl);
      let tag = null;
      if (!strip && h >= 100) { tag = el('div', 'ptag'); tag.style.fontSize = `${Math.max(9, h * 0.06)}px`; f.append(tag); }
      let last = '';
      return (d) => {
        const p = parts(d), mm = String(p.m).padStart(2, '0');
        hourEl.textContent = String(p.hd);
        if (mm !== last) { minEl.textContent = mm; if (last) restart(minEl, 'slide'); last = mm; }
        if (tag) tag.textContent = [p.day, p.date, p.ap].filter(Boolean).join(' · ');
      };
    },
  },
  {
    id: 'radar', name: 'Radar', color: true,
    blurb: 'A sonar scope. The beam sweeps once a minute and lights up the hour and minute blips as it passes.',
    motion: '<b>Motion:</b> continuous sweep with an afterglow; blips flare then fade.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), c = shades(color), pad = Math.min(12, h * 0.1), wide = w / h >= 1.8;
      const size = wide ? h - 2 * pad : Math.min(w, h) - 2 * pad, R = size / 2;
      const cx = wide ? pad + R : w / 2, cy = h / 2;
      const at = (deg, r) => [cx + Math.cos((deg - 90) * Math.PI / 180) * r, cy + Math.sin((deg - 90) * Math.PI / 180) * r];
      return (d) => {
        const p = parts(d), m = p.m + p.s / 60, hr = (p.h24 % 12) + m / 60, sweep = p.s * 6;
        ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#090a0d'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = rgba(color, 0.06); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = rgba(color, 0.22); ctx.lineWidth = 1;
        [1, 0.66, 0.33].forEach((f) => { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); });
        ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
        for (let i = 0; i < 40; i++) {
          const a0 = (sweep - i * 1.5 - 90) * Math.PI / 180, a1 = (sweep - (i + 1) * 1.5 - 90) * Math.PI / 180;
          ctx.fillStyle = rgba(color, 0.35 * (1 - i / 40) ** 2);
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a1, a0); ctx.closePath(); ctx.fill();
        }
        ctx.strokeStyle = c.light; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(...at(sweep, R)); ctx.stroke();
        const blip = (deg, r, big) => {
          const since = ((sweep - deg) % 360 + 360) % 360, glow = Math.exp(-since / 70);
          const [x, y] = at(deg, r), rad = Math.max(2, R * (big ? 0.075 : 0.05));
          ctx.save(); ctx.shadowColor = c.light; ctx.shadowBlur = rad * (2 + glow * 4);
          ctx.fillStyle = rgba(color, 0.35 + glow * 0.65); ctx.beginPath(); ctx.arc(x, y, rad * (1 + glow * 0.35), 0, Math.PI * 2); ctx.fill(); ctx.restore();
        };
        blip(hr * 30, R * 0.45, true); blip(m * 6, R * 0.8, false);
        if (wide) {
          const x = cx + R + pad * 1.4, size2 = fitFont(ctx, '12:59', '600', w - x - pad, size * 0.42);
          ctx.fillStyle = '#ececef'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          setFont(ctx, 600, size2, 'IBM Plex Mono'); ctx.fillText(hhmm(p), x, cy - (size >= 40 ? size2 * 0.18 : 0));
          if (size >= 40) { ctx.fillStyle = rgba(color, 0.8); setFont(ctx, 500, Math.max(9, size2 * 0.34), 'IBM Plex Mono'); ctx.fillText(`${p.day.toUpperCase()} ${p.date.toUpperCase()}`, x, cy + size2 * 0.5); }
        } else if (size >= 110) {
          ctx.fillStyle = 'rgba(9,10,13,0.75)'; setFont(ctx, 600, R * 0.17, 'IBM Plex Mono');
          const label = hhmm(p), tw = ctx.measureText(label).width + 10;
          ctx.fillRect(cx - tw / 2, cy + R * 0.5, tw, R * 0.24);
          ctx.fillStyle = '#ececef'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, cx, cy + R * 0.62);
        }
      };
    },
  },
];

// --- Third set: motion-led faces
// Samples the pixels of `text` drawn at `size` and returns points centred in a w x h box.
function textPoints(text, size, w, h, step, weight = 700, family = 'Bricolage Grotesque') {
  const off = document.createElement('canvas'); off.width = Math.ceil(w); off.height = Math.ceil(h);
  const o = off.getContext('2d');
  o.fillStyle = '#fff'; o.textAlign = 'center'; o.textBaseline = 'middle';
  o.font = `${weight} ${size}px ${family}, system-ui, sans-serif`;
  o.fillText(text, w / 2, h / 2);
  const data = o.getImageData(0, 0, off.width, off.height).data, pts = [];
  for (let y = 0; y < off.height; y += step) for (let x = 0; x < off.width; x += step) if (data[(y * off.width + x) * 4 + 3] > 128) pts.push([x, y]);
  return pts;
}
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const MOTION_FACES = [
  {
    id: 'swarm', name: 'Swarm', color: true,
    blurb: 'Hundreds of glowing particles hold the shape of the time. When the minute changes they burst apart and regroup into the new digits.',
    motion: '<b>Motion:</b> particles shimmer in place, then explode and fly to their new spots each minute.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), c = shades(color), pad = Math.min(10, h * 0.08);
      const size = fitFont(ctx, '12:59', '800', w - 2 * pad, (h - 2 * pad) * 0.9);
      const step = Math.max(2, Math.round(size / 26));
      const dot = Math.max(0.8, step * 0.42);
      let parts_ = [], last = '';
      const retarget = (text, burst) => {
        const pts = shuffle(textPoints(text, size, w, h, step));
        if (!pts.length) return;
        while (parts_.length < pts.length) parts_.push({ x: Math.random() * w, y: Math.random() * h, vx: 0, vy: 0, tx: 0, ty: 0, ph: Math.random() * 6 });
        parts_.length = Math.min(parts_.length, Math.max(pts.length, 40));
        parts_.forEach((q, i) => {
          [q.tx, q.ty] = pts[i % pts.length];
          if (burst) { const a = Math.random() * Math.PI * 2, f = 2 + Math.random() * 6; q.vx += Math.cos(a) * f; q.vy += Math.sin(a) * f; }
        });
      };
      return (d) => {
        const p = parts(d), text = hhmm(p), t = seconds();
        if (text !== last) { retarget(text, last !== ''); if (!last) parts_.forEach((q) => { q.x = q.tx; q.y = q.ty; }); last = text; }
        ctx.fillStyle = 'rgba(9,10,13,0.35)'; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        for (const q of parts_) {
          q.vx += (q.tx - q.x) * 0.045; q.vy += (q.ty - q.y) * 0.045;
          q.vx *= 0.84; q.vy *= 0.84;
          q.x += q.vx + Math.sin(t * 2.2 + q.ph) * 0.15; q.y += q.vy + Math.cos(t * 1.9 + q.ph) * 0.15;
          const speed = Math.min(1, Math.hypot(q.vx, q.vy) / 4);
          ctx.fillStyle = speed > 0.2 ? c.shift : (q.ph > 3 ? c.base : c.light);
          ctx.beginPath(); ctx.arc(q.x, q.y, dot * (1 + speed * 0.6), 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      };
    },
  },
  {
    id: 'lava', name: 'Lava', color: true,
    blurb: 'Soft blobs drift, merge and split like a lava lamp. The time inverts wherever it crosses a blob.',
    motion: '<b>Motion:</b> blobs ooze together and pull apart continuously.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), c = shades(color), pad = Math.min(12, h * 0.1);
      const cell = Math.max(3, Math.round(Math.min(w, h) / 40));
      const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
      const field = document.createElement('canvas'); field.width = gw; field.height = gh;
      const fctx = field.getContext('2d'), img = fctx.createImageData(gw, gh);
      const n = parseInt(c.base.slice(1), 16), [sr, sg, sb] = [n >> 16 & 255, n >> 8 & 255, n & 255];
      const blobs = Array.from({ length: 6 }, (_, i) => ({ ax: 0.2 + Math.random() * 0.6, ay: 0.2 + Math.random() * 0.6, fx: 0.07 + Math.random() * 0.1, fy: 0.05 + Math.random() * 0.1, ph: i * 1.7, r: (0.16 + Math.random() * 0.1) * Math.min(gw, gh) }));
      const size = fitFont(ctx, '12:59', '800', w - 2 * pad, (h - 2 * pad) * 0.8);
      return (d) => {
        const p = parts(d), t = seconds();
        const pos = blobs.map((b) => [gw * (0.5 + (b.ax - 0.5) * Math.sin(t * b.fx * 2 + b.ph) * 1.4), gh * (0.5 + (b.ay - 0.5) * Math.cos(t * b.fy * 2 + b.ph * 0.7) * 1.6), b.r * b.r]);
        const data = img.data;
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
          let v = 0;
          for (const [bx, by, r2] of pos) { const dx = x - bx, dy = y - by; v += r2 / (dx * dx + dy * dy + 1); }
          const a = Math.max(0, Math.min(1, (v - 0.9) * 3)), i = (y * gw + x) * 4, shade = 0.75 + 0.25 * (y / gh);
          data[i] = sr * shade; data[i + 1] = sg * shade; data[i + 2] = sb * shade; data[i + 3] = a * 255;
        }
        fctx.putImageData(img, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#120f16'); bg.addColorStop(1, '#0a0a0d');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true; ctx.save(); ctx.shadowColor = c.base; ctx.shadowBlur = cell * 4;
        ctx.drawImage(field, 0, 0, w, h); ctx.restore();
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = '#f4f4f5'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        setFont(ctx, 800, size, 'Bricolage Grotesque'); ctx.fillText(hhmm(p), w / 2, h / 2);
        ctx.globalCompositeOperation = 'source-over';
      };
    },
  },
  {
    id: 'aurora', name: 'Aurora', color: true,
    blurb: 'Northern-light curtains ripple behind thin, elegant numerals.',
    motion: '<b>Motion:</b> layered light ribbons wave and shimmer; faint stars twinkle above.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), c = shades(color), pad = Math.min(12, h * 0.1);
      const stars = Array.from({ length: Math.round(w * h / 700) }, () => [Math.random() * w, Math.random() * h * 0.6, Math.random() * 6]);
      const showDate = h >= 100;
      const size = fitFont(ctx, '12:59', '300', w - 2 * pad, (h - 2 * pad) * (showDate ? 0.5 : 0.78));
      const [hue, sat, lig] = hexToHsl(color);
      // Three curtains in neighbouring hues: [hue offset, height, speed, phase].
      const ribbons = [[0, 0.55, 1.0, 0], [40, 0.42, 0.7, 2.2], [-30, 0.68, 1.3, 4.1]];
      return (d) => {
        const p = parts(d), t = seconds();
        ctx.clearRect(0, 0, w, h);
        const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#05070d'); bg.addColorStop(1, '#0b1018');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
        for (const [x, y, ph] of stars) { ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.4 + ph))})`; ctx.fillRect(x, y, 1, 1); }
        ctx.globalCompositeOperation = 'lighter';
        for (const [dh, base, speed, ph] of ribbons) {
          // Vertical light streaks hanging from a wavy line make the curtain.
          for (let x = -4; x <= w + 4; x += 3) {
            const y = h * base + Math.sin(x * 0.012 + t * 0.6 * speed + ph) * h * 0.12 + Math.sin(x * 0.031 - t * 0.9 * speed) * h * 0.05;
            const len = h * (0.22 + 0.12 * Math.sin(x * 0.02 + t * speed + ph));
            const a = 0.1 + 0.08 * Math.sin(x * 0.05 + t * 2 * speed + ph);
            const g = ctx.createLinearGradient(0, y - len, 0, y);
            g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `hsla(${hue + dh} ${sat}% ${Math.min(80, lig + 5)}% / ${Math.max(0, a)})`);
            ctx.fillStyle = g; ctx.fillRect(x, y - len, 3, len);
          }
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#f8fafc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = rgba(c.base, 0.8); ctx.shadowBlur = size * 0.25;
        setFont(ctx, 300, size); ctx.fillText(hhmm(p), w / 2, showDate ? h * 0.45 : h / 2);
        ctx.shadowBlur = 0;
        if (showDate) { ctx.fillStyle = 'rgba(226,232,240,0.7)'; setFont(ctx, 400, Math.max(9, size * 0.17)); ctx.fillText(`${p.day.toUpperCase()}  ${p.date.toUpperCase()}`, w / 2, h * 0.45 + size * 0.62); }
      };
    },
  },
  {
    id: 'slots', name: 'Slot Reels', color: true,
    blurb: 'Each digit is a slot-machine reel. When the time changes the reels spin, blur and land with a bounce.',
    motion: '<b>Motion:</b> reels spin a full turn with motion blur, staggered left to right, and overshoot as they stop.',
    build(root, w, h, color) {
      const f = el('div', 'f-slots'); root.append(f);
      const c = shades(color), pad = Math.min(12, h * 0.1), gap = Math.max(3, w * 0.014), colonW = Math.max(6, w * 0.03);
      const reelH = Math.max(20, Math.min(h - 2 * pad, (w - 2 * pad - 4 * gap - colonW) / 4 * 1.25));
      const reelW = reelH / 1.25, font = reelH * 0.78;
      f.style.gap = `${gap}px`;
      const DIGITS = '0123456789'.repeat(3);
      const reels = [0, 1, 2, 3].map(() => {
        const r = el('div', 'reel'); r.style.cssText = `width:${reelW}px;height:${reelH}px;border-radius:${reelH * 0.12}px;box-shadow:0 0 0 1.5px ${c.base}, 0 0 ${reelH * 0.25}px ${rgba(color, 0.35)}`;
        const strip = el('div', 'strip'); strip.style.cssText = `font-size:${font}px;line-height:${reelH}px`;
        strip.innerHTML = [...DIGITS].map((n) => `<span style="height:${reelH}px">${n}</span>`).join('');
        r.append(strip, el('i', 'gloss'));
        r._strip = strip; r._v = null;
        return r;
      });
      const colon = el('div', 'scolon'); colon.style.cssText = `width:${colonW}px;gap:${reelH * 0.22}px`;
      colon.innerHTML = `<i style="width:${colonW * 0.5}px;height:${colonW * 0.5}px;background:${c.light}"></i><i style="width:${colonW * 0.5}px;height:${colonW * 0.5}px;background:${c.light}"></i>`;
      f.append(reels[0], reels[1], colon, reels[2], reels[3]);
      const place = (r, index, animate, delay) => {
        r._strip.style.transition = animate ? `transform .95s cubic-bezier(.25,1.35,.45,1) ${delay}ms` : 'none';
        r._strip.style.transform = `translateY(${-index * reelH}px)`;
      };
      return (d) => {
        const p = parts(d), str = `${String(p.hd).padStart(2, '0')}${String(p.m).padStart(2, '0')}`;
        reels.forEach((r, i) => {
          const v = +str[i];
          if (r._v === v) return;
          if (r._v === null) { place(r, 10 + v, false, 0); r._v = v; return; }
          r._v = v;
          const delay = i * 90;
          place(r, 20 + v, true, delay);
          r._strip.classList.remove('spin'); void r._strip.offsetWidth; r._strip.style.animationDelay = `${delay}ms`; r._strip.classList.add('spin');
          clearTimeout(r._t);
          r._t = setTimeout(() => { place(r, 10 + v, false, 0); r._strip.classList.remove('spin'); }, 1000 + delay);
        });
      };
    },
  },
  {
    id: 'crt', name: 'CRT', color: true,
    blurb: 'A phosphor terminal on an old tube monitor: scanlines, glow and a blinking block cursor.',
    motion: '<b>Motion:</b> a glitch tears the picture with RGB split and sliced rows when the minute changes, plus the odd random hiccup.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), pad = Math.min(12, h * 0.1), big = h >= 110;
      const off = document.createElement('canvas'), dpr = pixelRatio();
      off.width = Math.round(w * dpr); off.height = Math.round(h * dpr);
      const o = off.getContext('2d'); o.scale(dpr, dpr);
      o.font = '600 100px IBM Plex Mono, monospace';
      const per100 = o.measureText('12:59_').width;
      const size = Math.min((h - 2 * pad) * (big ? 0.5 : 0.78), (w - 2 * pad) / per100 * 100);
      let glitchUntil = 0, nextRandom = seconds() + 4 + Math.random() * 6, last = '';
      return (d) => {
        const p = parts(d), t = seconds(), text = hhmm(p);
        if (text !== last) { if (last) glitchUntil = t + 0.45; last = text; }
        if (t > nextRandom) { glitchUntil = t + 0.18; nextRandom = t + 5 + Math.random() * 8; }
        const glitch = t < glitchUntil;
        o.clearRect(0, 0, w, h);
        o.fillStyle = '#050605'; o.fillRect(0, 0, w, h);
        const flicker = 0.92 + Math.random() * 0.08;
        const draw = (dx, col, alpha) => {
          o.globalAlpha = alpha * flicker; o.fillStyle = col; o.textBaseline = 'middle'; o.textAlign = 'left';
          o.shadowColor = col; o.shadowBlur = size * 0.18;
          o.font = `600 ${size}px IBM Plex Mono, monospace`;
          const tw = o.measureText(text + '_').width, x = (w - tw) / 2 + dx, y = big ? h * 0.55 : h / 2;
          o.fillText(text, x, y);
          if (Math.floor(t * 1.6) % 2 === 0) o.fillRect(x + o.measureText(text).width + size * 0.06, y - size * 0.38, size * 0.5, size * 0.76);
          if (big) { o.font = `500 ${Math.max(9, size * 0.2)}px IBM Plex Mono, monospace`; o.fillText(`> ${p.day.toUpperCase()} ${p.date.toUpperCase()}`, x, h * 0.55 - size * 0.75); }
          o.shadowBlur = 0; o.globalAlpha = 1;
        };
        if (glitch) {
          o.globalCompositeOperation = 'lighter';
          const k = size * 0.06;
          draw(-k, '#ff2a4f', 0.9); draw(k, '#28e0ff', 0.9); draw(0, color, 0.6);
          o.globalCompositeOperation = 'source-over';
        } else draw(0, color, 1);
        ctx.clearRect(0, 0, w, h);
        if (glitch) {
          // Tear the picture into horizontal slices shifted sideways.
          const slices = 7;
          for (let i = 0; i < slices; i++) {
            const y0 = (h / slices) * i, sh = h / slices, shift = (Math.random() - 0.5) * size * 0.5;
            ctx.drawImage(off, 0, y0 * dpr, off.width, sh * dpr, shift, y0, w, sh);
          }
        } else ctx.drawImage(off, 0, 0, w, h);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        for (let y = (t * 20) % 3; y < h; y += 3) ctx.fillRect(0, y, w, 1);
        const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
        v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.65)');
        ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
        const band = ((t * 0.25) % 1.4 - 0.2) * h;
        const bandG = ctx.createLinearGradient(0, band - 20, 0, band + 20); bandG.addColorStop(0, 'rgba(255,255,255,0)'); bandG.addColorStop(0.5, 'rgba(255,255,255,0.035)'); bandG.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = bandG; ctx.fillRect(0, band - 20, w, 40);
      };
    },
  },
  {
    id: 'pendulum', name: 'Pendulum Wave', color: true,
    blurb: 'A row of pendulums with slightly different lengths. They drift in and out of step, making snakes, waves and chaos, and line up again every 30 seconds.',
    motion: '<b>Motion:</b> hypnotic, always-moving wave patterns with soft trails.',
    build(root, w, h, color) {
      const PAL = BUILD_PAL;
      const ctx = canvasFace(root, w, h), c = shades(color, PAL.light), pad = Math.min(12, h * 0.1), strip = h < 90;
      const [hue, sat, lig] = hexToHsl(color);
      const textSize = strip ? fitFont(ctx, '12:59', '600', w * 0.3, (h - 2 * pad) * 0.62) : fitFont(ctx, '12:59', '600', w - 2 * pad, h * 0.26);
      const fieldX = pad, fieldW = strip ? w - textSize * 3 - 3 * pad : w - 2 * pad;
      const fieldTop = strip ? pad : textSize * 1.35 + pad, fieldH = h - fieldTop - pad;
      const N = Math.round(clamp(fieldW / 16, 8, 26));
      const T = 30;
      return (d) => {
        const p = parts(d), t = (d.getTime() / 1000) % 3600;
        ctx.fillStyle = PAL.fade; ctx.fillRect(0, 0, w, h);
        const cy = fieldTop + fieldH / 2, amp = fieldH * 0.42, r = Math.max(2, Math.min(fieldW / N * 0.32, fieldH * 0.08));
        for (let i = 0; i < N; i++) {
          const x = fieldX + (i + 0.5) * (fieldW / N);
          const y = cy + Math.sin((2 * Math.PI * (18 + i) / T) * t) * amp;
          const col = hsl(hue + (i / N) * 50 - 25, sat, lig);
          ctx.strokeStyle = PAL.thread; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, fieldTop); ctx.lineTo(x, y); ctx.stroke();
          ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = r * 3; ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        }
        ctx.fillStyle = PAL.cover;
        if (strip) ctx.fillRect(w - textSize * 3 - pad, 0, textSize * 3 + pad, h); else ctx.fillRect(0, 0, w, fieldTop - 2);
        ctx.fillStyle = PAL.fg; ctx.textBaseline = 'middle'; setFont(ctx, 600, textSize);
        if (strip) { ctx.textAlign = 'right'; ctx.fillText(hhmm(p), w - pad, h / 2); }
        else {
          ctx.textAlign = 'left'; ctx.fillText(hhmm(p), pad, pad + textSize * 0.6);
          ctx.textAlign = 'right'; ctx.fillStyle = PAL.light ? PAL.muted : c.light; setFont(ctx, 500, Math.max(9, textSize * 0.32)); ctx.fillText(`${p.day}, ${p.date}`, w - pad, pad + textSize * 0.6);
        }
      };
    },
  },
];

// --- Fourth set: inspired by real kinetic clocks and objects
const easeInOut = (x) => x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
// ClockClock-style digits: 2 columns x 3 rows of dials, each dial = two hand angles (0 = up, clockwise).
const U = 0, R_ = 90, D = 180, L = 270, I = 225;
const DIAL_DIGITS = {
  0: [[R_, D], [L, D], [U, D], [U, D], [U, R_], [U, L]],
  1: [[I, I], [D, D], [I, I], [U, D], [I, I], [U, U]],
  2: [[R_, R_], [L, D], [R_, D], [U, L], [U, R_], [L, L]],
  3: [[R_, R_], [L, D], [R_, R_], [U, D], [R_, R_], [U, L]],
  4: [[D, D], [D, D], [U, R_], [U, D], [I, I], [U, U]],
  5: [[R_, D], [L, L], [U, R_], [L, D], [R_, R_], [U, L]],
  6: [[R_, D], [L, L], [U, D], [L, D], [U, R_], [U, L]],
  7: [[R_, R_], [L, D], [I, I], [U, D], [I, I], [U, U]],
  8: [[R_, D], [L, D], [U, R_], [U, L], [R_, U], [L, U]],
  9: [[R_, D], [L, D], [U, R_], [U, D], [R_, R_], [U, L]],
};

// Fibonacci clock: squares of size 1,1,2,3,5 in an 8 x 5 rectangle: [x, y, size].
const FIB = [[7, 3, 1], [7, 4, 1], [5, 3, 2], [5, 0, 3], [0, 0, 5]];
const FIB_VALUES = [1, 1, 2, 3, 5];
function fibSubset(target) {
  const options = [];
  for (let mask = 0; mask < 32; mask++) { let sum = 0; for (let i = 0; i < 5; i++) if (mask & (1 << i)) sum += FIB_VALUES[i]; if (sum === target) options.push(mask); }
  return options[Math.floor(Math.random() * options.length)] ?? 0;
}

const INSPIRED_FACES = [
  {
    id: 'clockclock', name: 'Clock of Clocks', color: true,
    blurb: 'Twenty-four tiny analog dials whose hands line up to draw the digits. Inspired by ClockClock 24 by Humans Since 1982.',
    motion: '<b>Motion:</b> every minute (and every 20 s here) the hands spin in a wave across the dials, sweep into diagonal patterns, then lock back into the time.',
    build(root, w, h, color) {
      const PAL = BUILD_PAL;
      const ctx = canvasFace(root, w, h), c = shades(color, PAL.light), pad = Math.min(10, h * 0.08);
      const gapX = Math.max(2, w * 0.012);
      const dial = Math.min((w - 2 * pad - gapX * 1.5) / 8, (h - 2 * pad) / 3);
      const ox = (w - dial * 8 - gapX * 1.5) / 2, oy = (h - dial * 3) / 2;
      // 48 hands, each with a queue of timed moves.
      const hands = Array.from({ length: 8 * 3 * 2 }, () => ({ angle: I, moves: [] }));
      const handIndex = (col, row, k) => ((row * 8 + col) * 2 + k);
      const dialPos = (col) => ox + col * dial + (col >= 4 ? gapX * 1.5 : 0) + dial / 2;
      const targetsFor = (str) => {
        const out = new Array(48);
        for (let digit = 0; digit < 4; digit++) DIAL_DIGITS[str[digit]].forEach((pair, cell) => {
          const col = digit * 2 + (cell % 2), row = Math.floor(cell / 2);
          pair.forEach((a, k) => { out[handIndex(col, row, k)] = a; });
        });
        return out;
      };
      const plan = (t0, targets, spin, colDelay, dur) => {
        hands.forEach((hand, i) => {
          const col = Math.floor(i / 2) % 8, k = i % 2;
          const start = t0 + col * colDelay;
          const last = hand.moves.length ? hand.moves[hand.moves.length - 1].to : hand.angle;
          // First hand turns clockwise, second counter-clockwise, each with extra full turns.
          const to = k === 0
            ? last + (((targets[i] - last) % 360) + 360) % 360 + 360 * spin
            : last - (((last - targets[i]) % 360) + 360) % 360 - 360 * spin;
          hand.moves.push({ start, dur, from: last, to });
        });
      };
      const pattern = (fn) => hands.map((_, i) => fn(Math.floor(i / 2) % 8, Math.floor(Math.floor(i / 2) / 8), i % 2));
      let lastStr = '', nextShow = Infinity, first = true;
      return (d) => {
        const p = parts(d), t = seconds(), str = `${String(p.hd).padStart(2, '0')}${String(p.m).padStart(2, '0')}`;
        if (first) { targetsFor(str).forEach((a, i) => { hands[i].angle = a; }); lastStr = str; first = false; }
        else if (str !== lastStr || t > nextShow) {
          // Choreography: spin into diagonal stripes, then sweep into the digits.
          const diag = pattern((col, row, k) => (k ? 45 : 225) + col * 15);
          plan(t, diag, 1, 0.07, 1.6);
          plan(t + 2.4, targetsFor(str), 1, 0.07, 1.9);
          lastStr = str;
        }
        ctx.clearRect(0, 0, w, h); ctx.fillStyle = PAL.plate2; ctx.fillRect(0, 0, w, h);
        const r = dial * 0.46;
        for (let row = 0; row < 3; row++) for (let col = 0; col < 8; col++) {
          const x = dialPos(col), y = oy + row * dial + dial / 2;
          ctx.fillStyle = PAL.dial2; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = PAL.line2; ctx.lineWidth = 1; ctx.stroke();
          for (let k = 0; k < 2; k++) {
            const hand = hands[handIndex(col, row, k)];
            while (hand.moves.length && t >= hand.moves[0].start + hand.moves[0].dur) { hand.angle = hand.moves[0].to; hand.moves.shift(); }
            let a = hand.angle;
            const mv = hand.moves[0];
            if (mv && t >= mv.start) a = mv.from + (mv.to - mv.from) * easeInOut((t - mv.start) / mv.dur);
            const rad = (a - 90) * Math.PI / 180;
            ctx.strokeStyle = k ? c.light : PAL.fg; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.2, dial * 0.075);
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(rad) * r * 0.86, y + Math.sin(rad) * r * 0.86); ctx.stroke();
          }
          ctx.fillStyle = c.base; ctx.beginPath(); ctx.arc(x, y, Math.max(1, dial * 0.05), 0, Math.PI * 2); ctx.fill();
        }
      };
    },
  },
  {
    id: 'ferro', name: 'Ferrofluid', color: true,
    blurb: 'Black magnetic liquid pulled into the shape of the digits, like Zelf Koelman\'s Ferrolic clock. Your color tints the plate behind it.',
    motion: '<b>Motion:</b> the surface wobbles and spikes; on each minute the liquid flows into the new digits.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), pad = Math.min(10, h * 0.08);
      const [hue, sat] = hexToHsl(color);
      const goo = document.createElement('canvas'); goo.width = Math.ceil(w); goo.height = Math.ceil(h);
      const g = goo.getContext('2d');
      const size = fitFont(ctx, '12:59', '800', w - 2 * pad * 2, (h - 2 * pad) * 0.86);
      const step = Math.max(3, Math.round(size / 13));
      const blob = step * 0.75, blur = Math.max(2, step * 0.55);
      let drops = [], last = '';
      const retarget = (text) => {
        const pts = shuffle(textPoints(text, size, w, h, step, 800));
        while (drops.length < pts.length) drops.push({ x: w / 2, y: h * 1.2, tx: 0, ty: 0, ph: Math.random() * 6 });
        drops.length = Math.max(pts.length, 1);
        drops.forEach((q, i) => { [q.tx, q.ty] = pts[i % pts.length]; });
      };
      return (d) => {
        const p = parts(d), t = seconds(), text = hhmm(p);
        if (text !== last) { retarget(text); if (!last) drops.forEach((q) => { q.x = q.tx; q.y = q.ty; }); last = text; }
        g.filter = 'none'; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.filter = `blur(${blur}px)`; g.fillStyle = '#000';
        for (const q of drops) {
          q.x += (q.tx - q.x) * 0.06; q.y += (q.ty - q.y) * 0.06;
          const r = blob * (1 + 0.22 * Math.sin(t * 3.1 + q.ph) + 0.12 * Math.sin(t * 7.3 + q.ph * 2));
          g.beginPath(); g.arc(q.x, q.y, r, 0, Math.PI * 2); g.fill();
        }
        const plate = ctx.createLinearGradient(0, 0, w, h);
        plate.addColorStop(0, hsl(hue, Math.min(sat, 35), 86)); plate.addColorStop(1, hsl(hue, Math.min(sat, 30), 70));
        ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
        ctx.fillStyle = plate; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'multiply';
        ctx.filter = 'contrast(22)'; ctx.drawImage(goo, 0, 0, w, h); ctx.filter = 'none';
        // A soft sheen sweeping across sells the glossy surface.
        ctx.globalCompositeOperation = 'screen';
        const sx = ((t * 0.12) % 1.6 - 0.3) * w;
        const sheen = ctx.createLinearGradient(sx - w * 0.15, 0, sx + w * 0.15, h);
        sheen.addColorStop(0, 'rgba(255,255,255,0)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0.18)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sheen; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      };
    },
  },
  {
    id: 'pong', name: 'Pong', color: true,
    blurb: 'Two paddles play Pong forever. The left score is the hour, the right score is the minute. Inspired by Sander Mulder\'s Pong Clock.',
    motion: '<b>Motion:</b> a live rally; when the minute changes the left paddle deliberately misses so the right player scores.',
    build(root, w, h, color) {
      const ctx = canvasFace(root, w, h), c = shades(color);
      const px = Math.max(1.5, Math.min(h / 34, w / 70));
      const paddleH = Math.max(px * 4, h * 0.22), paddleW = px * 1.6, margin = px * 3;
      const ball = { x: w / 2, y: h / 2, vx: w * 0.42, vy: h * 0.33 };
      const pads = [{ y: h / 2 }, { y: h / 2 }];
      let shown = null, pending = null, miss = false, lastT = seconds();
      const drawDigits = (str, cx, top, cell) => {
        const width = str.length * 6 * cell - cell;
        let x = cx - width / 2;
        for (const ch of str) {
          LED_DIGITS[ch].forEach((bits, r) => [...bits].forEach((b, i) => { if (b === '1') ctx.fillRect(x + i * cell, top + r * cell, cell, cell); }));
          x += 6 * cell;
        }
      };
      return (d) => {
        const p = parts(d), t = seconds(), dt = Math.min(0.05, t - lastT); lastT = t;
        const score = { left: String(p.hd), right: String(p.m).padStart(2, '0') };
        if (!shown) shown = score;
        if (score.left !== shown.left || score.right !== shown.right) { if (!pending) { pending = score; miss = true; } }
        ball.x += ball.vx * dt; ball.y += ball.vy * dt;
        if (ball.y < px) { ball.y = px; ball.vy = Math.abs(ball.vy); }
        if (ball.y > h - px) { ball.y = h - px; ball.vy = -Math.abs(ball.vy); }
        pads.forEach((pad, i) => {
          const chasing = i === 0 ? ball.vx < 0 : ball.vx > 0;
          const aim = miss && i === 0 ? (ball.y < h / 2 ? h - paddleH / 2 : paddleH / 2) : chasing ? ball.y : h / 2;
          pad.y += clamp(aim - pad.y, -h * 1.6 * dt, h * 1.6 * dt);
          pad.y = clamp(pad.y, paddleH / 2, h - paddleH / 2);
        });
        const hit = (i) => Math.abs(ball.y - pads[i].y) <= paddleH / 2 + px;
        if (ball.vx < 0 && ball.x <= margin + paddleW && ball.x > margin - px * 2) {
          if (!(miss) && hit(0)) { ball.x = margin + paddleW; ball.vx = Math.abs(ball.vx); ball.vy += (ball.y - pads[0].y) * 1.5; }
        }
        if (ball.vx > 0 && ball.x >= w - margin - paddleW && ball.x < w - margin + px * 2) {
          if (hit(1)) { ball.x = w - margin - paddleW; ball.vx = -Math.abs(ball.vx); ball.vy += (ball.y - pads[1].y) * 1.5; }
          else { ball.vx = -Math.abs(ball.vx); }
        }
        ball.vy = clamp(ball.vy, -h * 0.9, h * 0.9);
        if (ball.x < -px * 4) {
          if (pending) { shown = pending; pending = null; }
          miss = false; ball.x = w / 2; ball.y = h * (0.3 + Math.random() * 0.4); ball.vx = w * 0.42; ball.vy = (Math.random() - 0.5) * h * 0.8;
        }
        ctx.fillStyle = '#060607'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#2a2b31';
        for (let y = px; y < h; y += px * 3) ctx.fillRect(w / 2 - px / 2, y, px, px * 1.5);
        const cell = Math.max(1, Math.min(h * 0.045, w * 0.022));
        ctx.fillStyle = '#5c5c66'; drawDigits(shown.left, w * 0.27, Math.max(px, h * 0.1), cell); drawDigits(shown.right, w * 0.73, Math.max(px, h * 0.1), cell);
        ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = px * 4; ctx.fillStyle = c.light;
        ctx.fillRect(margin, pads[0].y - paddleH / 2, paddleW, paddleH);
        ctx.fillRect(w - margin - paddleW, pads[1].y - paddleH / 2, paddleW, paddleH);
        ctx.fillStyle = '#fff'; ctx.fillRect(ball.x - px, ball.y - px, px * 2, px * 2);
        ctx.restore();
      };
    },
  },
  {
    id: 'sand', name: 'Zen Sand', color: false,
    blurb: 'A steel ball draws endless patterns in fine sand around the time pressed into the middle. Inspired by kinetic sand tables like Sandsara.',
    motion: '<b>Motion:</b> the ball traces a slowly evolving rose curve; older grooves gradually smooth away.',
    build(root, w, h) {
      const ctx = canvasFace(root, w, h), pad = Math.min(10, h * 0.08);
      const dpr = pixelRatio();
      const sandTone = '#d9c9a8';
      const grain = document.createElement('canvas'); grain.width = Math.ceil(w); grain.height = Math.ceil(h);
      const gctx = grain.getContext('2d'); gctx.fillStyle = sandTone; gctx.fillRect(0, 0, w, h);
      for (let i = 0; i < w * h * 0.25; i++) { gctx.fillStyle = Math.random() < 0.5 ? 'rgba(120,95,60,0.12)' : 'rgba(255,250,235,0.18)'; gctx.fillRect(Math.random() * w, Math.random() * h, 1, 1); }
      const trail = document.createElement('canvas'); trail.width = Math.round(w * dpr); trail.height = Math.round(h * dpr);
      const tctx = trail.getContext('2d'); tctx.scale(dpr, dpr); tctx.drawImage(grain, 0, 0);
      const groove = Math.max(1.5, Math.min(w, h) * 0.02);
      const size = fitFont(ctx, '12:59', '600', w * 0.5, h * 0.36);
      let theta = 0, prev = null, lastT = seconds();
      const at = (th) => {
        const k = 5 / 3, R = Math.min(w, h) * 0.46, rx = w / 2 - pad, ry = h / 2 - pad;
        const r = 0.55 + 0.45 * Math.cos(k * th);
        return [w / 2 + Math.cos(th) * r * Math.min(rx, R * (w / h > 1.4 ? w / h : 1)), h / 2 + Math.sin(th) * r * ry];
      };
      return (d) => {
        const p = parts(d), t = seconds(), dt = Math.min(0.05, t - lastT); lastT = t;
        theta += dt * 0.55;
        const pos = at(theta);
        if (prev) {
          tctx.lineCap = 'round';
          tctx.strokeStyle = 'rgba(110,88,55,0.35)'; tctx.lineWidth = groove; tctx.beginPath(); tctx.moveTo(prev[0] + 0.6, prev[1] + 0.8); tctx.lineTo(pos[0] + 0.6, pos[1] + 0.8); tctx.stroke();
          tctx.strokeStyle = 'rgba(255,248,230,0.55)'; tctx.lineWidth = groove * 0.45; tctx.beginPath(); tctx.moveTo(prev[0] - 0.6, prev[1] - 0.6); tctx.lineTo(pos[0] - 0.6, pos[1] - 0.6); tctx.stroke();
        }
        prev = pos;
        tctx.globalAlpha = 0.004; tctx.drawImage(grain, 0, 0); tctx.globalAlpha = 1;
        ctx.drawImage(trail, 0, 0, w, h);
        // Time pressed into the sand: a dark lower edge and a light upper edge.
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; setFont(ctx, 600, size);
        const text = hhmm(p);
        ctx.fillStyle = 'rgba(255,250,235,0.7)'; ctx.fillText(text, w / 2 + 1, h / 2 + 1.5);
        ctx.fillStyle = 'rgba(105,82,50,0.55)'; ctx.fillText(text, w / 2 - 1, h / 2 - 1);
        ctx.fillStyle = sandTone; ctx.fillText(text, w / 2, h / 2);
        const ball = Math.max(3, groove * 1.4);
        ctx.fillStyle = 'rgba(60,45,25,0.35)'; ctx.beginPath(); ctx.ellipse(pos[0] + ball * 0.4, pos[1] + ball * 0.6, ball, ball * 0.7, 0, 0, Math.PI * 2); ctx.fill();
        const steel = ctx.createRadialGradient(pos[0] - ball * 0.35, pos[1] - ball * 0.4, ball * 0.1, pos[0], pos[1], ball);
        steel.addColorStop(0, '#ffffff'); steel.addColorStop(0.35, '#c9ccd3'); steel.addColorStop(1, '#4b4f58');
        ctx.fillStyle = steel; ctx.beginPath(); ctx.arc(pos[0], pos[1], ball, 0, Math.PI * 2); ctx.fill();
        const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
        v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(40,28,10,0.35)');
        ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
      };
    },
  },
  {
    id: 'fibonacci', name: 'Fibonacci', color: false,
    blurb: 'Squares of 1, 1, 2, 3 and 5. Red adds to the hour, green to the minutes (×5), blue to both. A puzzle for your desk.',
    motion: '<b>Motion:</b> tiles flip to their new colours one after another every five minutes, picking a fresh combination each time.',
    build(root, w, h) {
      const PAL = BUILD_PAL;
      const f = el('div', 'f-fib'); root.append(f);
      const pad = Math.min(10, h * 0.08), side = w / h >= 2.4;
      const textW = side ? Math.min(w * 0.36, (h - 2 * pad) * 2.2) : 0;
      const unit = Math.min((w - 2 * pad - textW - (side ? pad : 0)) / 8, (h - 2 * pad - (h >= 160 ? h * 0.12 : 0)) / 5);
      const board = el('div', 'fboard'); board.style.cssText = `width:${unit * 8}px;height:${unit * 5}px`;
      const tiles = FIB.map(([x, y, s]) => { const t = el('div', 'ftile'); t.style.cssText = `left:${x * unit}px;top:${y * unit}px;width:${s * unit}px;height:${s * unit}px`; board.append(t); return t; });
      f.append(board);
      let readout = null, legend = null;
      if (side) { readout = el('div', 'fread'); readout.style.fontSize = `${Math.min(textW / 3.2, h * 0.4)}px`; f.append(readout); f.style.gap = `${pad}px`; }
      if (h >= 160) {
        legend = el('div', 'flegend', '<span><i style="background:#e5484d"></i>hours</span><span><i style="background:#30a46c"></i>minutes</span><span><i style="background:#3e63dd"></i>both</span>');
        legend.style.fontSize = `${Math.max(9, h * 0.045)}px`; f.style.flexDirection = 'column'; f.style.gap = `${h * 0.03}px`; f.append(legend);
      }
      const COLORS = [PAL.tile, '#e5484d', '#30a46c', '#3e63dd'];
      let last = '';
      return (d) => {
        const p = parts(d), m5 = Math.floor(p.m / 5), key = `${p.hd}:${m5}`;
        if (readout) readout.textContent = hhmm(p);
        if (key === last) return;
        const hm = fibSubset(p.h12), mm = fibSubset(m5);
        tiles.forEach((tile, i) => {
          const state = ((hm >> i) & 1) + ((mm >> i) & 1) * 2;
          const delay = last ? i * 110 : 0;
          setTimeout(() => { tile.style.background = COLORS[state]; if (last) restart(tile, 'flip'); }, delay);
        });
        last = key;
      };
    },
  },
  {
    id: 'strips', name: 'Number Strips', color: true,
    blurb: 'Columns of digits glide up and down so the current time lines up on a highlighted row of dots.',
    motion: '<b>Motion:</b> the strips slide with an easing glide; on big blocks a seconds pair keeps everything moving.',
    build(root, w, h, color) {
      const PAL = BUILD_PAL;
      const f = el('div', 'f-strips'); root.append(f);
      const c = shades(color, PAL.light), pad = Math.min(10, h * 0.08);
      const showSec = h >= 150 && w >= 300;
      const ranges = showSec ? [HOUR12 ? 2 : 3, 10, 6, 10, 6, 10] : [HOUR12 ? 2 : 3, 10, 6, 10];
      const cols = ranges.length, gapExtra = Math.max(4, w * 0.02);
      const cell = Math.max(10, Math.min((h - 2 * pad) / 3.1, (w - 2 * pad - gapExtra * (cols / 2 - 1)) / (cols * 1.08)));
      const band = el('div', 'sband'); band.style.cssText = `height:${cell}px;top:${(h - cell) / 2}px;background:${rgba(color, 0.07)};border-color:${rgba(color, 0.25)}`;
      f.append(band);
      const row = el('div', 'srow'); row.style.gap = `${cell * 0.08}px`; f.append(row);
      const strips = ranges.map((n, i) => {
        const col = el('div', 'scol'); col.style.cssText = `width:${cell}px;height:${h}px;${i > 0 && i % 2 === 0 ? `margin-left:${gapExtra}px` : ''}`;
        const list = el('div', 'slist');
        list.innerHTML = Array.from({ length: n }, (_, k) => `<span style="height:${cell}px;font-size:${cell * 0.5}px">${k}</span>`).join('');
        col.append(list); row.append(col); col._list = list; col._v = -1;
        return col;
      });
      const dotSize = cell * 0.84;
      return (d) => {
        const p = parts(d);
        const values = [Math.floor(p.hd / 10), p.hd % 10, Math.floor(p.m / 10), p.m % 10, Math.floor(p.s / 10), Math.floor(p.s) % 10];
        strips.forEach((col, i) => {
          const v = values[i];
          if (col._v === v) return;
          const firstTime = col._v === -1;
          col._v = v;
          col._list.style.transition = firstTime ? 'none' : 'transform .9s cubic-bezier(.65,0,.35,1)';
          col._list.style.transform = `translateY(${(h - cell) / 2 - v * cell}px)`;
          col._list.querySelectorAll('span').forEach((s, k) => {
            const on = k === v;
            s.classList.toggle('on', on);
            s.style.setProperty('--dot', `${dotSize}px`);
            s.style.setProperty('--dc', on ? c.base : 'transparent');
          });
        });
      };
    },
  },
];

const FACES = [...INSPIRED_FACES, ...MOTION_FACES, ...NEW_FACES, ...FIRST_FACES];


const CATEGORY = {"digital": "classic", "analog": "classic", "flip": "classic", "glow": "classic", "word": "classic", "poster": "classic", "nixie": "retro", "led": "retro", "crt": "retro", "pong": "retro", "slots": "retro", "tape": "retro", "tide": "ambient", "sky": "ambient", "aurora": "ambient", "lava": "ambient", "sand": "ambient", "pendulum": "ambient", "orbit": "ambient", "clockclock": "kinetic", "ferro": "kinetic", "swarm": "kinetic", "rings": "kinetic", "radar": "kinetic", "fibonacci": "kinetic", "strips": "kinetic"};
const DEFAULT_COLOR = '#93c5fd';
const CSS = ".fc-root{--fg:#ececef;--muted:#a1a1aa;--faint:#5c5c66;--line:#2a2b31;--display:\"Bricolage Grotesque\",\"Segoe UI\",system-ui,sans-serif;--body:\"IBM Plex Sans\",\"Segoe UI\",system-ui,sans-serif;--mono:\"IBM Plex Mono\",ui-monospace,Consolas,monospace;--flip:\"Barlow Condensed\",\"Arial Narrow\",system-ui,sans-serif;position:relative;overflow:hidden;background:var(--plate,#111215);font-family:var(--body);}\n.fc-root .f-digital{position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--fg);}\n.fc-root .f-digital .time{font-family: var(--body); font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; display: flex; align-items: baseline; line-height: 1;}\n.fc-root .f-digital .d{display: inline-block; width: .6em; text-align: center;}\n.fc-root .f-digital .d.roll{animation: roll .45s cubic-bezier(.2, .8, .2, 1);}\n.fc-root .f-digital .c{display: inline-block; width: .3em; text-align: center; transition: opacity .2s;}\n.fc-root .f-digital .c.dim{opacity: .25;}\n.fc-root .f-digital .ap{font-size: .32em; color: var(--muted); margin-left: .25em; letter-spacing: .04em;}\n.fc-root .f-digital .date{color: var(--muted); line-height: 1.2;}\n@keyframes roll{ from { transform: translateY(45%); opacity: 0; filter: blur(2px); } to { transform: none; opacity: 1; filter: none; } }\n@keyframes pulse{ 0% { opacity: 1; } 50% { opacity: .25; } }\n.fc-root .f-analog, .fc-root .f-rings{position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;}\n.fc-root .f-analog svg, .fc-root .f-rings svg{display: block; flex: 0 0 auto; overflow: visible;}\n.fc-root .side{display: flex; flex-direction: column; justify-content: center; min-width: 0;}\n.fc-root .side .t{font-family: var(--body); font-weight: 500; font-variant-numeric: tabular-nums; color: var(--fg); line-height: 1.05; white-space: nowrap;}\n.fc-root .side .s{color: var(--muted); line-height: 1.25; white-space: nowrap;}\n.fc-root .f-flip{position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;}\n.fc-root .f-flip .row{display: flex; align-items: center;}\n.fc-root .card{position: relative; perspective: 400px; font-family: var(--flip); font-weight: 600; color: #f4f4f5;}\n.fc-root .half{position: absolute; left: 0; right: 0; height: 50%; overflow: hidden; background: #1f2026; backface-visibility: hidden;}\n.fc-root .half span{position: absolute; left: 0; right: 0; text-align: center;}\n.fc-root .half.top{top: 0; border-radius: inherit; border-bottom-left-radius: 0; border-bottom-right-radius: 0; background: #23242b;}\n.fc-root .half.bot{bottom: 0; border-radius: inherit; border-top-left-radius: 0; border-top-right-radius: 0;}\n.fc-root .half.bot span{bottom: 0;}\n.fc-root .half.top span{top: 0;}\n.fc-root .half.ftop{top: 0; transform-origin: bottom; background: #23242b; border-radius: inherit; border-bottom-left-radius: 0; border-bottom-right-radius: 0; z-index: 2;}\n.fc-root .half.ftop span{top: 0;}\n.fc-root .half.fbot{bottom: 0; transform-origin: top; border-radius: inherit; border-top-left-radius: 0; border-top-right-radius: 0; z-index: 2; transform: rotateX(90deg);}\n.fc-root .half.fbot span{bottom: 0;}\n.fc-root .half.ftop, .fc-root .half.fbot{visibility: hidden;}\n.fc-root .card.go .half.ftop, .fc-root .card.go .half.fbot{visibility: visible;}\n.fc-root .card .hinge{position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: #0b0b0d; z-index: 3;}\n.fc-root .card.go .ftop{animation: flipTop .26s ease-in forwards;}\n.fc-root .card.go .fbot{animation: flipBot .26s .26s ease-out forwards;}\n@keyframes flipTop{ to { transform: rotateX(-90deg); } }\n@keyframes flipBot{ from { transform: rotateX(90deg); } to { transform: rotateX(0); } }\n.fc-root .f-flip .dots{display: flex; flex-direction: column; justify-content: center;}\n.fc-root .f-flip .dots i{display: block; border-radius: 50%; background: #3a3b44;}\n.fc-root .f-flip .date{color: var(--muted); font-family: var(--body); line-height: 1.2;}\n.fc-root .f-word{position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;}\n.fc-root .f-word .grid{display: grid; position: relative; font-family: var(--mono); font-weight: 500;}\n.fc-root .f-word .grid span{display: grid; place-items: center; color: var(--dim, #2c2d34); transition: color .7s ease, text-shadow .7s ease;}\n.fc-root .f-word .grid span.on{color: var(--wc); text-shadow: 0 0 .6em color-mix(in srgb, var(--wc) 55%, transparent);}\n.fc-root .f-word .mdot{position: absolute; border-radius: 50%; background: var(--dim, #2c2d34); transition: background .7s ease;}\n.fc-root .f-word .mdot.on{background: var(--wc);}\n.fc-root .f-word .phrase{font-family: var(--display); font-weight: 600; line-height: 1.08; text-align: center; color: var(--fg);}\n.fc-root .f-word .phrase em{font-style: normal; color: var(--wc);}\n.fc-root .f-word .phrase.swap{animation: fadeUp .7s ease;}\n@keyframes fadeUp{ from { opacity: 0; transform: translateY(12%); } to { opacity: 1; transform: none; } }\n.fc-root .f-glow{position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;}\n.fc-root .f-glow .aura{position: absolute; inset: 15% 20%; border-radius: 50%; opacity: .32; animation: breathe 6s ease-in-out infinite;}\n.fc-root .f-glow .t{position: relative; font-family: var(--display); font-weight: 800; letter-spacing: -0.04em; line-height: 1; font-variant-numeric: tabular-nums; background-size: 300% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: drift 9s linear infinite; white-space: nowrap;}\n.fc-root .f-glow .s{position: relative; color: var(--muted); line-height: 1.2;}\n@keyframes drift{ to { background-position: 300% 0; } }\n@keyframes breathe{ 50% { transform: scale(1.12); opacity: .45; } }\n.fc-root .f-nixie{position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: radial-gradient(ellipse at 50% 120%, #1a0e06, #0b0908 70%);}\n.fc-root .tube{position: relative; overflow: hidden; background: linear-gradient(90deg, rgba(255,255,255,.07), rgba(255,255,255,.16) 18%, rgba(255,255,255,.03) 45%, rgba(255,255,255,.02) 75%, rgba(255,255,255,.1)), #140d09; box-shadow: inset 0 0 0 1px rgba(255,255,255,.08), inset 0 -6px 14px rgba(0,0,0,.6); font-family: \"IBM Plex Sans\", system-ui, sans-serif; font-weight: 300;}\n.fc-root .tube .mesh{position: absolute; inset: 8% 10%; background: repeating-linear-gradient(60deg, rgba(255,255,255,.035) 0 1px, transparent 1px 5px), repeating-linear-gradient(-60deg, rgba(255,255,255,.035) 0 1px, transparent 1px 5px);}\n.fc-root .tube span{position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255, 150, 70, .06); line-height: 1; transition: color .25s ease, text-shadow .25s ease;}\n.fc-root .tube span.lit{color: #ffc27d; text-shadow: 0 0 .05em #fff1d6, 0 0 .14em #ff9a3c, 0 0 .4em #ff6a10, 0 0 .9em rgba(255, 80, 0, .6);}\n.fc-root .tube span.flick{animation: flick .5s steps(1);}\n@keyframes flick{ 0% { opacity: .2; } 15% { opacity: 1; } 25% { opacity: .35; } 40% { opacity: 1; } 55% { opacity: .7; } 70% { opacity: 1; } }\n.fc-root .ncolon{display: flex; flex-direction: column; align-items: center; justify-content: center;}\n.fc-root .ncolon i{display: block; border-radius: 50%; background: #ffb067; box-shadow: 0 0 6px #ff7a1a, 0 0 14px rgba(255, 90, 0, .6); transition: opacity .3s;}\n.fc-root .ncolon.dim i{opacity: .35;}\n.fc-root .f-poster{position: absolute; inset: 0; overflow: hidden; background: var(--plate2, #0d0e12);}\n.fc-root .f-poster .ph{position: absolute; font-family: var(--display); font-weight: 800; line-height: 1; color: transparent; letter-spacing: -0.06em; white-space: nowrap; animation: posterDrift 24s ease-in-out infinite alternate;}\n.fc-root .f-poster .pm{position: absolute; font-family: var(--display); font-weight: 800; line-height: .9; letter-spacing: -0.04em; font-variant-numeric: tabular-nums;}\n.fc-root .f-poster .pm.slide{animation: slideUp .6s cubic-bezier(.2, .8, .2, 1);}\n.fc-root .f-poster .ptag{position: absolute; top: 8%; right: 5%; font-family: var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted);}\n@keyframes posterDrift{ to { transform: translateX(4%); } }\n@keyframes slideUp{ from { transform: translateY(60%); opacity: 0; clip-path: inset(0 0 100% 0); } to { transform: none; opacity: 1; clip-path: inset(0); } }\n.fc-root .f-slots{position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: radial-gradient(ellipse at 50% 0%, #1a1b22, #0b0b0e 70%);}\n.fc-root .reel{position: relative; overflow: hidden; background: #f4f1ea;}\n.fc-root .reel .strip{position: absolute; left: 0; right: 0; top: 0; font-family: var(--display); font-weight: 800; color: #111216; text-align: center; will-change: transform;}\n.fc-root .reel .strip span{display: block;}\n.fc-root .reel .strip.spin{animation: reelBlur .95s ease-out both;}\n.fc-root .reel .gloss{position: absolute; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(0,0,0,.55), rgba(0,0,0,0) 28%, rgba(255,255,255,.18) 48%, rgba(0,0,0,0) 62%, rgba(0,0,0,.55));}\n@keyframes reelBlur{ 0% { filter: blur(0); } 20% { filter: blur(3px); } 70% { filter: blur(1.5px); } 100% { filter: blur(0); } }\n.fc-root .scolon{display: flex; flex-direction: column; align-items: center; justify-content: center;}\n.fc-root .scolon i{display: block; border-radius: 50%;}\n.fc-root .f-fib{position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--plate2, #0e0e11);}\n.fc-root .fboard{position: relative; flex: 0 0 auto;}\n.fc-root .ftile{position: absolute; box-sizing: border-box; border: 2px solid var(--plate2, #0e0e11); background: var(--tile, #f3f1ea); transition: background .5s ease;}\n.fc-root .ftile.flip{animation: tileFlip .6s ease;}\n@keyframes tileFlip{ 0% { transform: perspective(300px) rotateY(0); } 50% { transform: perspective(300px) rotateY(90deg); } 100% { transform: perspective(300px) rotateY(0); } }\n.fc-root .fread{font-family: var(--body); font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums;}\n.fc-root .flegend{display: flex; gap: 1.2em; color: var(--muted);}\n.fc-root .flegend span{display: inline-flex; align-items: center; gap: .4em;}\n.fc-root .flegend i{width: .8em; height: .8em; border-radius: 2px; display: inline-block;}\n.fc-root .f-strips{position: absolute; inset: 0; overflow: hidden; background: var(--plate2, #0c0d10);}\n.fc-root .sband{position: absolute; left: 0; right: 0; border-block: 1px solid;}\n.fc-root .srow{position: absolute; inset: 0; display: flex; justify-content: center;}\n.fc-root .scol{position: relative; overflow: hidden; -webkit-mask-image: linear-gradient(180deg, transparent, #000 30%, #000 70%, transparent); mask-image: linear-gradient(180deg, transparent, #000 30%, #000 70%, transparent);}\n.fc-root .slist{position: absolute; left: 0; right: 0; top: 0;}\n.fc-root .slist span{position: relative; display: grid; place-items: center; font-family: var(--body); font-weight: 600; color: var(--stripDim, #3f3f46); font-variant-numeric: tabular-nums; transition: color .5s ease;}\n.fc-root .slist span::before{content: \"\"; position: absolute; width: var(--dot, 0); height: var(--dot, 0); border-radius: 50%; background: var(--dc, transparent); transition: background .5s ease; z-index: -1;}\n.fc-root .slist span.on{color: var(--onAccent, #0b0b0e);}\n.fc-root .slist{isolation: isolate;}\n@media (prefers-reduced-motion: reduce){.fc-root .f-digital .d.roll, .fc-root .f-digital .c, .fc-root .card.go .ftop, .fc-root .card.go .fbot, .fc-root .f-word .phrase.swap, .fc-root .f-glow .t, .fc-root .f-glow .aura, .fc-root .tube span.flick, .fc-root .f-poster .ph, .fc-root .f-poster .pm.slide, .fc-root .reel .strip.spin, .fc-root .ftile.flip{animation: none !important;}\n.fc-root .card.go .ftop{transform: rotateX(-90deg);}\n.fc-root .card.go .fbot{transform: none;}}";
// CSS animations (Nixie flicker, Glow drift, ...) stop while a face is paused.
const PAUSED_CSS = '.fc-root.fc-paused *{animation-play-state:paused!important}';
const styled = new WeakSet();
const active = new Set();
let raf = 0, paused = false, backgroundPaused = false, frameMs = 0, nextFrameAt = 0;

// How often a face changes, in ms; faces not listed move continuously and draw every frame.
// Faces that only follow the clock wake once on its next boundary instead, so a Words clock costs one
// wake-up a minute rather than one per screen refresh. Their CSS transitions still play when they change.
const EVERY = { word: 60000, flip: 60000, glow: 60000, poster: 60000, slots: 60000, fibonacci: 60000, digital: 1000, strips: 1000, nixie: 500 };
const ticking = (mounted) => mounted.live && mounted.visible && !(mounted.background && backgroundPaused) && !paused && !document.hidden;
let timer = 0;

// Continuous faces: one loop, running only while one of them is drawing. With a frame-rate cap a
// timer wakes it once per frame drawn; requestAnimationFrame alone would wake it on every screen
// refresh (60-144 Hz) just to skip most of them.
function frame() {
  raf = 0;
  const moving = [...active].filter((mounted) => !mounted.every && ticking(mounted));
  if (!moving.length) return;
  const date = new Date();
  for (const mounted of moving) mounted.tick(date);
  if (!frameMs) { raf = requestAnimationFrame(frame); return; }
  // Aim at fixed frame times so timer lateness doesn't add up and drop the rate below the cap.
  const now = performance.now();
  nextFrameAt = Math.max(nextFrameAt + frameMs, now + 1);
  raf = setTimeout(frame, nextFrameAt - now);
}

// Clock-following faces: a single timer for the nearest boundary any of them is waiting for.
function clockTick() {
  timer = 0;
  const date = new Date();
  for (const mounted of active) if (mounted.every && ticking(mounted)) mounted.tick(date);
  schedule();
}
function schedule() {
  if (timer) { clearTimeout(timer); timer = 0; }
  const waiting = [...active].filter((mounted) => mounted.every && ticking(mounted));
  if (!waiting.length) return;
  const now = Date.now();
  // A few ms past the boundary, so the new second or minute has begun.
  timer = setTimeout(clockTick, Math.min(...waiting.map((mounted) => mounted.every - (now % mounted.every))) + 15);
}

// Starts whatever the mounted faces now need, and stops what they don't.
function wake() {
  if (!raf && [...active].some((mounted) => !mounted.every && ticking(mounted))) { nextFrameAt = performance.now(); raf = frameMs ? setTimeout(frame, 0) : requestAnimationFrame(frame); }
  schedule();
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) { const date = new Date(); for (const mounted of active) if (ticking(mounted)) mounted.tick(date); } wake(); });

// Draws `face` into `host` at width x height px.
// live: animate (false = keep the first frame until set live). pixelRatio: canvas resolution cap.
// background: paused by setBackgroundPaused, e.g. while the face browser covers the editor.
// Returns { destroy, setLive(live), setVisible(visible) }.
function mount(host, { face, color, width, height, hour12 = true, live = true, pixelRatio: ratio = 2, background = false }) {
  const doc = host.ownerDocument;
  if (!styled.has(doc)) { const style = doc.createElement('style'); style.textContent = CSS + PAUSED_CSS; doc.head.append(style); styled.add(doc); }
  const def = FACES.find((item) => item.id === face) || FACES.find((item) => item.id === 'digital');
  const w = Math.max(20, width), h = Math.max(20, height);
  const picked = def.color && /^#[0-9a-f]{6}$/i.test(color || '') ? color.toLowerCase() : DEFAULT_COLOR;
  const mounted = { live, background, visible: true, every: EVERY[def.id] || 0, def, root: null, tick: () => {} };
  mounted.syncCss = () => { if (mounted.root) mounted.root.classList.toggle('fc-paused', !mounted.live || !mounted.visible || (mounted.background && backgroundPaused)); };
  // Draws the face with the palette of the current theme (a scene face always uses the dark one).
  mounted.build = () => {
    const pal = SCENE.has(def.id) ? PALETTES.dark : PALETTES[theme];
    host.textContent = '';
    const root = doc.createElement('div');
    root.className = 'fc-root';
    root.style.width = `${w}px`; root.style.height = `${h}px`;
    for (const [key, value] of Object.entries(pal)) if (typeof value === 'string') root.style.setProperty(`--${key}`, value);
    host.append(root);
    HOUR12 = hour12;
    MAX_PIXEL_RATIO = ratio;
    BUILD_PAL = pal;
    const shown = pal.light ? forLight(picked) : picked;
    if (pal.light) root.style.setProperty('--onAccent', onColor(shown));
    const tick = def.build(root, w, h, shown);
    mounted.root = root;
    mounted.tick = (date) => { HOUR12 = hour12; tick(date); };
    mounted.syncCss();
  };
  mounted.build();
  mounted.tick(new Date());
  active.add(mounted);
  wake();
  return {
    destroy() { active.delete(mounted); if (mounted.root) mounted.root.remove(); wake(); },
    setLive(value) { mounted.live = Boolean(value); mounted.syncCss(); if (mounted.live) mounted.tick(new Date()); wake(); },
    setVisible(value) { mounted.visible = Boolean(value); mounted.syncCss(); if (mounted.visible) mounted.tick(new Date()); wake(); },
  };
}

globalThis.OpenDockClock = {
  faces: FACES.map((item) => ({ id: item.id, name: item.name, category: CATEGORY[item.id], color: item.color, blurb: item.blurb })),
  mount,
  setPaused(value) { paused = Boolean(value); wake(); },
  setBackgroundPaused(value) { backgroundPaused = Boolean(value); for (const mounted of active) mounted.syncCss(); wake(); },
  setFrameRate(fps) { frameMs = fps > 0 ? 1000 / fps : 0; },
  // The color as it will be drawn in the current theme (the color pickers show swatches this way).
  tint(hex) { return /^#[0-9a-f]{6}$/i.test(hex) && theme === 'light' ? forLight(hex) : hex; },
  // 'light' or 'dark'. Faces already on screen are drawn again in the new look; scene faces stay dark.
  setTheme(value) {
    const next = value === 'light' ? 'light' : 'dark';
    if (next === theme) return;
    theme = next;
    for (const mounted of active) if (!SCENE.has(mounted.def.id)) { mounted.build(); mounted.tick(new Date()); }
    wake();
  },
};
})();
