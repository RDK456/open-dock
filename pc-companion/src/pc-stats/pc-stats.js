// Open Dock PC stats widgets. Edit here, then run `node scripts/sync-pc-stats.ts` to refresh the phone copy
// (phone-app/src/pc-stats-source.ts). Plain browser JavaScript with no imports: the desktop imports it and
// the phone runs it inside a WebView, like the clock faces.
// It defines globalThis.OpenDockStats = { metrics, styles, resolve, needs, setHistory, push, latest, mount(host, options) }.
// Samples come from the PC (pc-companion/src-tauri/src/pc_stats). GPU readings are per GPU (sample.gpus);
// each widget follows one GPU (options.gpu: an id, or "auto"). A reading the PC can't measure is null:
// the widget shows a short reason ("No sensor", "No driver", "Asleep") instead of a number, and
// estimates (an integrated GPU's temperature taken from the CPU) are marked with "≈".
(function () {
'use strict';
const N = 60;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let uid = 0;
let history = [];
const mounted = new Set();

const METRICS = [
  { id: 'cpu', name: 'CPU load', short: 'CPU', u: '%', max: 100, sample: '100%' },
  { id: 'cputemp', name: 'CPU temp', short: 'CPU temp', u: '°', max: 100, sample: '≈100°', temp: true },
  { id: 'gpu', name: 'GPU load', short: 'GPU', u: '%', max: 100, sample: '100%', gpu: true },
  { id: 'gputemp', name: 'GPU temp', short: 'GPU temp', u: '°', max: 100, sample: '≈100°', temp: true, gpu: true },
  { id: 'ram', name: 'RAM', short: 'RAM', u: '%', max: 100, sample: '100%' },
  { id: 'vram', name: 'GPU memory', short: 'GPU mem', u: '%', max: 100, sample: '100%', gpu: true },
  { id: 'disk', name: 'Disk space', short: 'Disk', u: '%', max: 100, sample: '100%' },
  // Rates arrive in MB/s and show as KB/s below 1 MB/s; their graphs scale to the last minute's peak,
  // never below `max`.
  { id: 'diskio', name: 'Disk activity', short: 'Disk I/O', u: 'MB/s', max: 1, sample: '999MB/s', rate: true },
  { id: 'net', name: 'Download', short: 'Net ↓', u: 'MB/s', max: 0.1, sample: '999MB/s', rate: true },
  { id: 'power', name: 'GPU power', short: 'GPU pwr', u: 'W', max: 300, sample: '300W', gpu: true },
];
const M = Object.fromEntries(METRICS.map((m) => [m.id, m]));
// The PC samples only what's on screen. These map a reading to the sample groups it uses
// (pc_stats::Needs in the Rust backend); every GPU reading comes from "gpu".
const USES = { cpu: ['cpu', 'clock'], cputemp: ['cputemp'], gpu: ['gpu'], gputemp: ['gpu'], vram: ['gpu'], power: ['gpu'], ram: ['ram'], disk: ['disk'], diskio: ['diskio'], net: ['net'] };
// The readings each dashboard shows.
const DASH = { strip: ['cpu', 'gpu', 'ram', 'cputemp', 'gputemp'], overview: ['cpu', 'gpu', 'ram', 'vram', 'cputemp', 'gputemp'], monitor: ['cpu', 'gpu', 'cputemp', 'gputemp', 'power', 'ram'], cores: ['cpu', 'cputemp'] };
const PAIR = { cpu: 'cputemp', cputemp: 'cpu', gpu: 'gputemp', gputemp: 'gpu', ram: 'vram', vram: 'ram', disk: 'diskio', diskio: 'net', net: 'diskio', power: 'gputemp' };

// --- Readings -----------------------------------------------------------
const has = (v) => typeof v === 'number' && isFinite(v);
const last = () => history[history.length - 1] || {};
// The GPU the widget being drawn follows. Set around each widget's update (updates are synchronous).
const CTX = { gpu: 'auto' };
// "auto" follows the discrete GPU while it's awake, else the integrated one.
function pickGpu(sample, want) {
  const gpus = sample && Array.isArray(sample.gpus) ? sample.gpus : [];
  const chosen = want && want !== 'auto' && gpus.find((g) => g.id === want);
  if (chosen) return chosen;
  const by = (test) => gpus.find(test);
  return by((g) => g.kind === 'discrete' && g.state === 'ok') || by((g) => g.kind === 'integrated' && g.state === 'ok') || by((g) => g.state === 'ok') || by((g) => g.state === 'sleeping') || gpus[0] || null;
}
const gpuOf = (sample) => pickGpu(sample, CTX.gpu);
// GPU power in watts when the source reports watts, else as a share of the power limit (D3DKMT).
const powerPercent = (g) => !!g && !has(g.power) && has(g.powerPercent);
function read(sample, k) {
  if (!sample) return undefined;
  if (!M[k].gpu) return sample[k];
  const g = gpuOf(sample);
  if (!g) return undefined;
  if (k === 'gpu') return g.load;
  if (k === 'gputemp') return g.temp;
  if (k === 'vram') return has(g.memUsed) && has(g.memTotal) && g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : undefined;
  return powerPercent(g) ? g.powerPercent : g.power;
}
const series = (k) => history.slice(-N).map((s) => read(s, k));
const val = (k) => read(last(), k);
const kilo = (v) => has(v) && v < 0.9995;
const unit = (k, v = val(k)) => (M[k].rate ? (kilo(v) ? 'KB/s' : 'MB/s') : k === 'power' && powerPercent(gpuOf(last())) ? '%' : M[k].u);
// A rate in MB/s as text: "24 KB/s", "3.4 MB/s", "120 MB/s".
const rateText = (v) => (kilo(v) ? String(Math.round(v * 1000)) : v < 10 ? v.toFixed(1) : String(Math.round(v)));
const approx = (k) => (k === 'cputemp' ? !!last().cputempApprox : k === 'gputemp' ? !!(gpuOf(last()) || {}).tempApprox : false);
// GPU power has no fixed top; the card's power limit is its 100%.
const maxOf = (k) => {
  if (M[k].rate) return Math.max(M[k].max, ...series(k).filter(has)) * 1.15;
  if (k !== 'power') return M[k].max;
  const g = gpuOf(last());
  return powerPercent(g) ? 100 : g && has(g.powerLimit) ? g.powerLimit : M[k].max;
};
// Why a reading is missing, in a word or two.
function reason(k) {
  if (M[k].gpu) {
    const g = gpuOf(last());
    if (!g) return 'No GPU';
    if (g.state === 'no-driver') return 'No driver';
    if (g.state === 'sleeping') return 'Asleep';
  }
  return history.length ? 'No sensor' : '';
}
const num = (k, v = val(k)) => (!has(v) ? '–' : M[k].rate ? rateText(v) : M[k].dec ? v.toFixed(M[k].dec) : String(Math.round(v)));
const frac = (k, v = val(k)) => (has(v) ? clamp(v / maxOf(k), 0, 1) : 0);
const tone = (k, v = val(k)) => (M[k].temp && has(v) ? (v >= 85 ? 'var(--hot)' : v >= 70 ? 'var(--warm)' : 'var(--ok)') : 'var(--accent)');
// The current reading as HTML; a given `v` is a past value (graph min/avg/max) and gets no reason text.
const html = (k, v) => {
  const current = v === undefined;
  const value = current ? val(k) : v;
  if (has(value)) return `${current && approx(k) ? '<small class="ap">≈</small>' : ''}${num(k, value)}<small>${unit(k, value)}</small>`;
  const why = current && reason(k);
  return why ? `<small class="why">${why}</small>` : '–';
};
const stats = (k) => { const a = series(k).filter(has); return a.length ? { min: Math.min(...a), max: Math.max(...a), avg: a.reduce((s, v) => s + v, 0) / a.length } : { min: null, max: null, avg: null }; };
const gb = (used, total) => (has(used) && has(total) ? `${used.toFixed(1)} / ${Math.round(total)} GB` : '');
const VENDOR = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple' };
const gpuName = (g) => (g && g.name ? g.name.replace(/\((R|TM)\)/g, '').replace(/^(NVIDIA GeForce|NVIDIA|AMD Radeon|AMD|Intel)\s+/i, '').trim() : '');
// The detail line under a GPU reading: what's wrong first, else which GPU.
function gpuNote(extra) {
  const g = gpuOf(last());
  if (!g) return history.length ? 'No GPU found' : '';
  if (g.state === 'no-driver') return `Install the ${VENDOR[g.vendor] || 'GPU'} driver`;
  if (g.state === 'sleeping') return `${gpuName(g)} is asleep`;
  return extra || gpuName(g);
}
const detail = {
  cpu: () => (has(last().clock) ? `${last().clock.toFixed(2)} GHz` : ''),
  cputemp: () => (approx('cputemp') ? 'Board sensor' : has(stats('cputemp').max) ? `Peak ${Math.round(stats('cputemp').max)}°` : ''),
  gpu: () => { const g = gpuOf(last()); return gpuNote(g && has(g.power) ? `${gpuName(g)} · ${Math.round(g.power)} W` : ''); },
  gputemp: () => { const g = gpuOf(last()); return gpuNote(!g ? '' : g.tempApprox ? 'Shared with CPU' : has(g.hotspot) ? `Hotspot ${Math.round(g.hotspot)}°` : has(g.fan) ? `Fan ${Math.round(g.fan)}%` : has(g.fanRpm) ? `Fan ${Math.round(g.fanRpm)} rpm` : ''); },
  ram: () => gb(last().ramUsed, last().ramTotal),
  vram: () => { const g = gpuOf(last()); const used = g ? gb(g.memUsed, g.memTotal) : ''; return gpuNote(used && `${used}${g.memKind === 'shared' ? ' shared' : g.memKind === 'unified' ? ' unified' : ''}`); },
  disk: () => gb(last().diskUsed, last().diskTotal),
  net: () => (has(last().netUp) ? `↑ ${rateText(last().netUp)} ${unit('net', last().netUp)}` : ''),
  diskio: () => (has(last().diskRead) && has(last().diskWrite) ? `Read ${rateText(last().diskRead)} ${unit('diskio', last().diskRead)} · Write ${rateText(last().diskWrite)} ${unit('diskio', last().diskWrite)}` : ''),
  power: () => { const g = gpuOf(last()); return gpuNote(powerPercent(g) ? 'of power limit' : g && has(g.powerLimit) ? `of ${Math.round(g.powerLimit)} W` : ''); },
};
const q = (s, r) => r.querySelector(s);
const qa = (s, r) => [...r.querySelectorAll(s)];

// --- SVG helpers --------------------------------------------------------
// Points for the newest values, right-aligned so a short history grows in from the right. Gaps (null) are skipped.
const pts = (arr, x, y, w, h, max) => arr.map((v, i) => (has(v) ? [x + ((N - arr.length + i) * w) / (N - 1), y + h - clamp(v / max, 0, 1) * h] : null)).filter(Boolean);
const line = (p) => p.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('');
const area = (p, y, h) => (p.length ? `${line(p)}L${p[p.length - 1][0]},${y + h}L${p[0][0]},${y + h}Z` : '');
const polar = (cx, cy, r, a) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
const arc = (cx, cy, r, a0, a1) => { const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1); return `M${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`; };
// The fade under a graph. Its colour is set on each stop per update (graph()) rather than inherited,
// which some Android WebViews resolve differently in gradient stops.
const grad = (id) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop class="g0" offset="0" stop-opacity=".32"/><stop class="g1" offset="1" stop-opacity="0"/></linearGradient></defs>`;
const setArc = (node, k) => { node.style.strokeDasharray = `${frac(k) > 0 ? Math.max(0.01, frac(k) * 100) : 0} 100`; node.style.stroke = tone(k); };

// --- Layout helpers -------------------------------------------------------
// Blocks run from about 45 × 46 px (a 1×1 on a 6×6 grid) to 780 × 375 px, at any shape. So every
// style sizes text by measuring the widest reading it can show, sets padding from the short side,
// lays out side by side when the block is wide and stacked when it's tall, and drops rows that don't
// fit: the detail line first, then the label, never the number.
// Writes text or HTML only when it changed. Most readings repeat from one second to the next, and
// an unchanged innerHTML write still builds and discards DOM nodes, which piles up as garbage.
// Detail lines carry text from the PC (GPU names), so it's escaped before going through put().
const escapeText = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const put = (node, value) => { const v = String(value); if (node.__shown !== v) { node.__shown = v; node.innerHTML = v; } };
const ce = (tag, cls, css) => { const e = document.createElement(tag); if (cls) e.className = cls; if (css) e.style.cssText = css; return e; };
const at = (x, y, w, h) => `position:absolute;left:${x}px;top:${y}px;width:${Math.max(0, w)}px;height:${Math.max(0, h)}px;`;
const padOf = (w, h) => clamp(Math.min(w, h) * 0.09, 4, 14);
// Width of `html` per px of font size, measured in the widget so the real font counts. offsetWidth
// ignores the desktop preview's scale transform.
function emWidth(root, text, cls, isHtml) {
  const probe = ce('span', cls, 'position:absolute;visibility:hidden;white-space:nowrap;font-size:100px;left:0;top:0;line-height:1');
  if (isHtml) probe.innerHTML = text; else probe.textContent = text;
  root.append(probe);
  const width = probe.offsetWidth / 100;
  probe.remove();
  return width || 1;
}
// The widest reading a metric shows ("≈100°", "999KB/s") as widget HTML.
function sampleHtml(k) {
  const [, pre, digits, rest] = /^(≈?)([\d.]+)(.*)$/.exec(M[k].sample);
  return `${pre ? '<small class="ap">≈</small>' : ''}${digits}<small>${rest}</small>`;
}
// Text lines are 1.34× the font size (the CSS line-height below), tall enough to hold every glyph in
// IBM Plex and the system fallbacks, so a box h px tall takes a font of h / 1.34.
const LINE = 1.34;
const numberSize = (root, k, w, h) => Math.max(0, Math.min(h / LINE, w / emWidth(root, sampleHtml(k), 'num', true)));
const textSize = (root, text, cls, w, max) => Math.max(0, Math.min(max, w / emWidth(root, text, cls)));

// Label over number over detail in a box. Options: x, y, align ('flex-start' | 'center' | 'flex-end'),
// label (text, or false), detail (bool), max (number font cap), labelMax (label font cap). Dashboards
// pass the caps from sharedSizes() so every cell's text is the same size.
function readout(root, k, w, h, o = {}) {
  const text = o.label === false ? '' : o.label || M[k].short;
  const gap = clamp(h * 0.05, 1, 6);
  const L = text ? textSize(root, text, 'lbl', w, Math.min(o.labelMax ?? Infinity, clamp(h * 0.15, 8, 12))) : 0;
  const D = clamp(h * 0.11, 9, 11.5);
  const fit = (label, det) => Math.min(o.max || Infinity, numberSize(root, k, w, h - (label ? L * LINE + gap : 0) - (det ? D * LINE + gap : 0)));
  let label = L >= 7.5, det = !!o.detail;
  let size = fit(label, det);
  if (det && size < Math.max(18, D * 2)) { det = false; size = fit(label, false); }
  if (label && size < Math.max(13, L * 1.5)) { label = false; size = fit(false, false); }
  const box = root.appendChild(ce('div', 'ro', `${at(o.x || 0, o.y || 0, w, h)}gap:${gap}px;align-items:${o.align || 'flex-start'}`));
  if (label) box.appendChild(ce('span', 'lbl', `font-size:${L}px;max-width:${w}px`)).textContent = text;
  const n = box.appendChild(ce('b', 'num', `font-size:${size}px`));
  const d = det && box.appendChild(ce('span', 'det', `font-size:${D}px;max-width:${w}px`));
  return { size, update() { put(n, html(k)); if (d) put(d, escapeText((o.detailText || detail[k])())); } };
}

// Label on the left, number on the right, in one line.
function rowReadout(root, k, x, y, w, h, label = M[k].short, max = Infinity) {
  const size = Math.min(max, numberSize(root, k, w * 0.6, h));
  const room = w - emWidth(root, sampleHtml(k), 'num', true) * size - 6;
  const L = label ? textSize(root, label, 'lbl', room, clamp(h * 0.5, 8, 12)) : 0;
  const box = root.appendChild(ce('div', 'rrow', at(x, y, w, h)));
  if (L >= 7.5) box.appendChild(ce('span', 'lbl', `font-size:${L}px`)).textContent = label;
  const n = box.appendChild(ce('b', 'num', `font-size:${size}px;margin-left:auto`));
  return { update() { put(n, html(k)); } };
}

// The label and number sizes that fit every one of `items` ({ k, label }) in a w × h readout, so
// cells side by side match instead of each shrinking to its own widest reading.
function sharedSizes(root, items, w, h) {
  const gap = clamp(h * 0.05, 1, 6);
  const labelMax = Math.min(...items.map(({ k, label }) => textSize(root, label || M[k].short, 'lbl', w, clamp(h * 0.15, 8, 12))));
  const max = Math.min(...items.map(({ k }) => numberSize(root, k, w, h - labelMax * LINE - gap)));
  return { labelMax, max };
}

// A horizontal meter.
function meter(root, x, y, w, h) {
  const bar = root.appendChild(ce('div', 'bar zone', `${at(x, y, w, h)}border-radius:${h / 2}px`));
  const fill = bar.appendChild(ce('i'));
  return (k) => { fill.style.transform = `translateX(${(frac(k) - 1) * 100}%)`; fill.style.background = tone(k); };
}

// The last minute as a filled line graph in a box. Options: labels (draws a 0/50/100% scale to the
// right, inside the box), dot (marks the newest value), grid.
function graph(root, k, x, y, w, h, o = {}) {
  const id = `ps${uid++}`, axis = o.labels ? 26 : 0, gw = w - axis;
  const svg = root.appendChild(ce('div', '', at(x, y, w, h)));
  const lines = o.grid || o.labels ? [0, 0.5, 1].map((f) => `<line x1="0" x2="${gw}" y1="${(1 - f) * h}" y2="${(1 - f) * h}" stroke="var(--line)"/>`).join('') : '';
  const labels = o.labels ? [0, 0.5, 1].map((f) => `<text class="gl" data-f="${f}" x="${gw + 4}" y="${clamp((1 - f) * h + 3, 8, h)}" fill="var(--faint)" font-size="9" font-family="IBM Plex Mono, monospace"></text>`).join('') : '';
  svg.innerHTML = `<svg class="abs" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${grad(id)}<rect class="zone" x="0" y="0" width="${gw}" height="${h}" fill="none"/>${lines}${labels}<path class="ar" fill="url(#${id})"/><path class="ln" fill="none" stroke-width="2" stroke-linejoin="round"/>${o.dot ? '<circle class="dot" r="3"/>' : ''}</svg>`;
  const el = svg.firstChild, ar = q('.ar', el), ln = q('.ln', el), dot = q('.dot', el), gl = qa('.gl', el), stops = qa('stop', el);
  return () => {
    const max = maxOf(k), p = pts(series(k), 0, 2, gw, h - 4, max), c = tone(k), end = p[p.length - 1];
    stops.forEach((stop) => { stop.style.stopColor = c; }); ar.setAttribute('d', area(p, 2, h - 4)); ln.setAttribute('d', line(p)); ln.setAttribute('stroke', c);
    if (dot) { dot.style.display = end ? '' : 'none'; if (end) { dot.setAttribute('cx', end[0]); dot.setAttribute('cy', end[1]); dot.setAttribute('fill', c); } }
    gl.forEach((t) => { const v = Number(t.dataset.f) * max; put(t, !M[k].rate ? Math.round(v) : v === 0 ? '0' : `${rateText(v)}${kilo(v) ? 'K' : 'M'}`); });
  };
}

// Min, average and max over the last minute, in one line, sized so the widest readings fit.
// Returns null when even small text wouldn't fit; the caller then leaves the row out.
function statsRow(root, k, x, y, w, h) {
  const cell = `<span class="lbl" style="font-size:.8em">max</span> ${sampleHtml(k)}`;
  // 15% spare: the row's cells use a lighter weight and a flex gap the sample doesn't.
  const F = Math.min(h / LINE, 12, (w - 12) / (3 * 1.15 * emWidth(root, cell, 'num', true)));
  if (F < 9) return null;
  const row = root.appendChild(ce('div', 'srow', `${at(x, y, w, h)}font-size:${F}px`));
  const cells = ['min', 'avg', 'max'].map((name) => { const c = row.appendChild(ce('span')); c.appendChild(ce('span', 'lbl', 'font-size:.8em')).textContent = name; return c.appendChild(ce('b')); });
  return () => { const st = stats(k); ['min', 'avg', 'max'].forEach((name, i) => { put(cells[i], html(k, st[name] ?? NaN)); }); };
}

// A progress ring in a square at (x, y), with the reading inside when it fits.
function ringAt(root, k, x, y, s, inside, sizes = {}) {
  const sw = clamp(s * 0.08, 3, 14), r = s / 2 - sw / 2;
  const svg = root.appendChild(ce('div', '', at(x, y, s, s)));
  svg.innerHTML = `<svg class="abs" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${sw}"/><circle class="ringv" cx="${s / 2}" cy="${s / 2}" r="${r}" fill="none" stroke-width="${sw}" stroke-linecap="round" pathLength="100" transform="rotate(-90 ${s / 2} ${s / 2})"/></svg>`;
  const c = q('.ringv', svg);
  // The largest box inside the ring's hole.
  const hole = s - 2 * sw, bw = hole * 0.72, bh = hole * 0.62;
  const text = inside && readout(root, k, bw, bh, { x: x + (s - bw) / 2, y: y + (s - bh) / 2, align: 'center', label: inside === true ? undefined : inside, ...sizes });
  return () => { setArc(c, k); if (text) text.update(); };
}
// The box inside a ring of side s that holds its reading (matches ringAt).
const ringHole = (s) => { const hole = s - 2 * clamp(s * 0.08, 3, 14); return [hole * 0.72, hole * 0.62]; };

// The arrangement for a reading beside or above a graphic: wide blocks put a square graphic on the left.
const sideBySide = (w, h) => w >= h * 1.7 && w - h >= 56;
// In a wide block, a square graphic of side `s` plus a reading column, centred as one group:
// returns the graphic's x and the reading column's x and width.
function besideLayout(w, h, s, p) {
  const gap = p * 1.5, column = Math.min(w - s - gap - 2 * p, Math.max(120, h * 1.6));
  const x = Math.max(p, (w - (s + gap + column)) / 2);
  return { x, textX: x + s + gap, textW: column };
}

// --- Styles: build(el, w, h, metric) -> update() ---------------------------
// `span` is the smallest block (columns × rows) the style is designed for; `fallback` is drawn in smaller blocks.
const STYLES = [
  { id: 'ring', size: '1x1', span: [1, 1], name: 'Ring', blurb: 'A progress ring around the reading.', build(el, w, h, k) {
    const p = padOf(w, h);
    if (sideBySide(w, h)) {
      const s = h - 2 * p, { x, textX, textW } = besideLayout(w, h, s, p);
      const ring = ringAt(el, k, x, p, s, false);
      const text = readout(el, k, textW, h - 2 * p, { x: textX, y: p, detail: true });
      return () => { ring(); text.update(); };
    }
    const s = Math.min(w, h) - 2 * p;
    return ringAt(el, k, (w - s) / 2, (h - s) / 2, s, true);
  } },
  { id: 'number', size: '1x1', span: [1, 1], name: 'Big number', blurb: 'Label on top, a large reading and a thin meter.', build(el, w, h, k) {
    const p = padOf(w, h), barH = h >= 44 ? clamp(h * 0.04, 3, 6) : 0, gap = barH ? clamp(h * 0.06, 3, 8) : 0;
    const room = h - 2 * p - barH - gap;
    // Short, wide blocks read better as one line: label left, number right.
    const text = room < 40 && w > room * 2.5 ? rowReadout(el, k, p, p, w - 2 * p, room) : readout(el, k, w - 2 * p, room, { x: p, y: p, detail: room >= 80 });
    const bar = barH ? meter(el, p, h - p - barH, w - 2 * p, barH) : null;
    return () => { text.update(); if (bar) bar(k); };
  } },
  { id: 'fill', size: '1x1', span: [1, 1], name: 'Fill', blurb: 'The tile fills from the bottom like a tank.', build(el, w, h, k) {
    const p = padOf(w, h), liq = el.appendChild(ce('div', 'liq'));
    const text = readout(el, k, w - 2 * p, h - 2 * p, { x: p, y: p, align: 'center', detail: h >= 120 });
    return () => { liq.style.transform = `translateY(${(1 - frac(k)) * 100}%)`; el.style.setProperty('--c', tone(k)); text.update(); };
  } },
  { id: 'dial', size: '1x1', span: [1, 1], name: 'Dial', blurb: 'A speedometer arc with a needle.', build(el, w, h, k) {
    const p = padOf(w, h), side = sideBySide(w, h);
    const s = side ? h - 2 * p : Math.min(w, h) - 2 * p, beside = side && besideLayout(w, h, s, p);
    const x0 = side ? beside.x : (w - s) / 2, y0 = side ? p : (h - s) / 2;
    // The arc spans ±120°, so it uses the top 3/4 of its square; the reading sits in the opening below the hub.
    const sw = clamp(s * 0.07, 3, 12), r = (s - sw) / 2, cx = x0 + s / 2, cy = y0 + sw / 2 + r;
    const svg = el.appendChild(ce('div', '', at(0, 0, w, h)));
    svg.innerHTML = `<svg class="abs" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      <path d="${arc(cx, cy, r, -120, 120)}" fill="none" stroke="var(--track)" stroke-width="${sw}" stroke-linecap="round"/>
      <path class="arcv" d="${arc(cx, cy, r, -120, 120)}" fill="none" stroke-width="${sw}" stroke-linecap="round" pathLength="100"/>
      <g class="needle" style="transform-origin:${cx}px ${cy}px"><line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r * 0.62}" stroke="var(--fg)" stroke-width="2" stroke-linecap="round"/></g>
      <circle cx="${cx}" cy="${cy}" r="${clamp(s * 0.04, 2, 5)}" fill="var(--fg)"/></svg>`;
    const a = q('.arcv', svg), nd = q('.needle', svg);
    // The arc ends at ±0.87r below the hub, so the reading can be that wide less the stroke.
    const bw = Math.max(r * 1.2, 2 * (0.866 * r - sw)), by = cy + r * 0.34, bh = y0 + s - by;
    const text = side ? readout(el, k, beside.textW, h - 2 * p, { x: beside.textX, y: p, detail: true }) : readout(el, k, bw, bh, { x: cx - bw / 2, y: by, align: 'center' });
    return () => { setArc(a, k); nd.style.transform = `rotate(${-120 + frac(k) * 240}deg)`; text.update(); };
  } },
  { id: 'spark', size: '2x1', span: [2, 1], fallback: 'number', name: 'Sparkline', blurb: 'Reading on the left, the last minute on the right.', build(el, w, h, k) {
    const p = padOf(w, h);
    if (w >= h * 1.8) {
      const lw = clamp(w * 0.38, 50, 220);
      const text = readout(el, k, lw - p, h - 2 * p, { x: p, y: p, detail: h >= 64 });
      const chart = graph(el, k, lw + p, p + 2, w - lw - 2 * p, h - 2 * p - 4, { dot: true });
      return () => { text.update(); chart(); };
    }
    const rh = clamp(h * 0.45, 24, 100), gh = h - rh - 3 * p;
    const text = readout(el, k, w - 2 * p, rh, { x: p, y: p, detail: rh >= 70 });
    const chart = gh >= 12 ? graph(el, k, p, p * 2 + rh, w - 2 * p, gh, { dot: true }) : null;
    return () => { text.update(); if (chart) chart(); };
  } },
  { id: 'segments', size: '2x1', span: [2, 1], fallback: 'number', name: 'Segments', blurb: 'An LED bar graph. Temperatures shade amber and red at the top.', build(el, w, h, k) {
    const p = padOf(w, h), ih = h - 2 * p, iw = w - 2 * p;
    let text, sx, sy, sw, sh, det = null;
    if (ih < 34) {
      // One line: the number, then the bar.
      const nw = Math.min(iw * 0.4, 90);
      text = readout(el, k, nw, ih, { x: p, y: p, label: false });
      [sx, sw, sh] = [p + nw + 6, iw - nw - 6, clamp(ih * 0.5, 6, 20)];
      sy = p + (ih - sh) / 2;
    } else {
      const rh = clamp(ih * 0.42, 14, 44), gap = clamp(ih * 0.08, 3, 10);
      sh = clamp(ih * 0.3, 6, 32);
      text = rowReadout(el, k, p, p, iw, rh);
      [sx, sy, sw] = [p, p + rh + gap, iw];
      const left = ih - rh - gap - sh - gap;
      if (left >= 13) {
        det = el.appendChild(ce('span', 'det', `${at(p, sy + sh + gap, iw, Math.min(left, 16))}font-size:${clamp(left / LINE, 9, 11.5)}px`));
      }
    }
    const n = clamp(Math.floor(sw / 8), 6, 30);
    const segs = el.appendChild(ce('div', 'seg zone', `${at(sx, sy, sw, sh)}`));
    segs.innerHTML = '<i></i>'.repeat(n);
    const cells = qa('i', segs);
    return () => {
      const lit = Math.round(frac(k) * n);
      cells.forEach((s, i) => { s.style.background = i < lit ? tone(k, ((i + 1) / n) * maxOf(k)) : ''; });
      text.update(); if (det) put(det, escapeText(detail[k]()));
    };
  } },
  { id: 'area', size: '2x1', span: [2, 1], fallback: 'fill', name: 'Area', blurb: 'A full-bleed graph under the reading.', build(el, w, h, k) {
    const p = padOf(w, h);
    if (w >= h * 1.8) {
      const lw = clamp(w * 0.36, 50, 200);
      const text = readout(el, k, lw - p, h - 2 * p, { x: p, y: p, detail: h >= 64 });
      const chart = graph(el, k, lw + p, p, w - lw - p, h - p);
      return () => { text.update(); chart(); };
    }
    const rh = clamp(h * 0.42, 22, 110);
    const text = readout(el, k, w - 2 * p, rh, { x: p, y: p, detail: rh >= 70 });
    const chart = h - rh - 2 * p >= 12 ? graph(el, k, 0, rh + 2 * p, w, h - rh - 2 * p) : null;
    return () => { text.update(); if (chart) chart(); };
  } },
  { id: 'pair', size: '2x1', span: [2, 1], fallback: 'ring', name: 'Pair', blurb: 'Two related readings as bars, like load with its temperature.', build(el, w, h, k) {
    const p = padOf(w, h), iw = w - 2 * p, gap = clamp(h * 0.08, 3, 10);
    // Two rows when each gets at least 16 px, else just this reading.
    const ks = (h - 2 * p - gap) / 2 >= 16 ? [k, PAIR[k]] : [k];
    const rh = (h - 2 * p - gap * (ks.length - 1)) / ks.length;
    // Both values share one size (the smaller of the two fits).
    const vw = clamp(iw * 0.3, 40, 110), common = Math.min(...ks.map((x) => (iw >= 140 ? numberSize(el, x, vw, rh) : numberSize(el, x, iw * 0.6, rh - clamp(rh * 0.18, 3, 6) - 3))));
    const rows = ks.map((x, i) => {
      const y = p + i * (rh + gap);
      if (iw >= 140) {
        // label | bar | value
        const lw = clamp(iw * 0.26, 30, 90), bh = clamp(rh * 0.28, 3, 10);
        const L = textSize(el, M[x].short, 'lbl', lw - 4, clamp(rh * 0.45, 8, 12));
        if (L >= 7.5) el.appendChild(ce('span', 'lbl', `${at(p, y, lw, rh)}font-size:${L}px;display:flex;align-items:center`)).textContent = M[x].short;
        const bar = meter(el, p + lw, y + (rh - bh) / 2, iw - lw - vw - 6, bh);
        const value = readout(el, x, vw, rh, { x: w - p - vw, y, align: 'flex-end', label: false, max: common });
        return () => { bar(x); value.update(); };
      }
      // Narrow: label and value on a line, the bar under them.
      const bh = clamp(rh * 0.18, 3, 6);
      const top = rowReadout(el, x, p, y, iw, rh - bh - 3, M[x].short, common);
      const bar = meter(el, p, y + rh - bh, iw, bh);
      return () => { top.update(); bar(x); };
    });
    return () => rows.forEach((row) => row());
  } },
  { id: 'graph', size: '2x2', span: [2, 2], fallback: 'spark', name: 'Graph', blurb: 'A minute of history with a scale, plus min, average and max.', build(el, w, h, k) {
    const p = padOf(w, h), parts = [];
    if (w >= h * 2.2) {
      // Wide: the reading and the min/avg/max column on the left, the graph on the right.
      const lw = clamp(w * 0.3, 70, 220), sh = h >= 90 ? clamp(h * 0.12, 11, 18) : 0;
      const stats = sh ? statsRow(el, k, p, h - p - sh, lw - p, sh) : null;
      parts.push(readout(el, k, lw - p, h - 2 * p - (stats ? sh + 4 : 0), { x: p, y: p, label: M[k].name, detail: true }).update);
      if (stats) parts.push(stats);
      parts.push(graph(el, k, lw + p, p, w - lw - 2 * p, h - 2 * p, { labels: w - lw >= 120 && h >= 50, grid: true }));
    } else {
      const hh = clamp(h * 0.3, 26, 100), sh = clamp(h * 0.09, 11, 18), gap = clamp(h * 0.05, 6, 12);
      const gh = h - 2 * p - hh - gap - sh - gap;
      const stats = gh >= 36 ? statsRow(el, k, p, h - p - sh, w - 2 * p, sh) : null;
      const plotH = stats ? gh : h - 2 * p - hh - gap;
      parts.push(readout(el, k, w - 2 * p, hh, { x: p, y: p, label: M[k].name, detail: hh >= 56 }).update);
      if (plotH >= 12) parts.push(graph(el, k, p, p + hh + gap, w - 2 * p, plotH, { labels: plotH >= 40 && w >= 140, grid: true }));
      if (stats) parts.push(stats);
    }
    return () => parts.forEach((part) => part());
  } },
  { id: 'gauge', size: '2x2', span: [2, 2], fallback: 'dial', name: 'Gauge', blurb: 'A large 270° gauge with ticks and two supporting readings.', build(el, w, h, k) {
    const p = padOf(w, h), side = sideBySide(w, h) || w - h > 120;
    const s = side ? h - 2 * p : Math.min(w, h * 0.8) - 2 * p, beside = side && besideLayout(w, h, s, p);
    const x0 = side ? beside.x : (w - s) / 2, y0 = p;
    const sw = clamp(s * 0.06, 3, 14), r = (s - sw) / 2, cx = x0 + s / 2, cy = y0 + s / 2;
    const ticks = Array.from({ length: 11 }, (_, i) => { const a = -135 + i * 27, [x1, y1] = polar(cx, cy, r - sw * 1.2, a), [x2, y2] = polar(cx, cy, r - sw * (i % 5 ? 1.7 : 2.3), a); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${i % 5 ? 'var(--faint)' : 'var(--muted)'}" stroke-width="1.4" stroke-linecap="round"/>`; }).join('');
    const svg = el.appendChild(ce('div', '', at(0, 0, w, h)));
    svg.innerHTML = `<svg class="abs" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${arc(cx, cy, r, -135, 135)}" fill="none" stroke="var(--track)" stroke-width="${sw}" stroke-linecap="round"/><path class="arcv" d="${arc(cx, cy, r, -135, 135)}" fill="none" stroke-width="${sw}" stroke-linecap="round" pathLength="100"/>${ticks}</svg>`;
    const a = q('.arcv', svg), inner = (r - sw * 2.4) * 2 * 0.7;
    const center = readout(el, k, inner, inner * 0.75, { x: cx - inner / 2, y: cy - inner * 0.375, align: 'center' });
    // Two supporting lines: beside the gauge when wide, under it when tall, else dropped.
    const pk = PAIR[k], lines = [() => detail[k](), () => `${M[pk].short} ${(() => { const v = val(pk); return has(v) ? num(pk, v) + unit(pk, v) : reason(pk) || '–'; })()}`];
    const D = clamp(Math.min(w, h) * 0.06, 9, 12), boxes = [];
    if (side) {
      lines.forEach((_, i) => boxes.push(el.appendChild(ce('span', 'det', `${at(beside.textX, h / 2 - D * LINE * (1 - i) - 2 + i * 4, beside.textW, D * LINE)}font-size:${D}px`))));
    } else if (h - (y0 + s) - p >= D * LINE) {
      const y = h - p - D * LINE;
      boxes.push(el.appendChild(ce('span', 'det', `${at(p, y, (w - 2 * p) / 2 - 4, D * LINE)}font-size:${D}px`)));
      boxes.push(el.appendChild(ce('span', 'det', `${at(w / 2 + 4, y, (w - 2 * p) / 2 - 4, D * LINE)}font-size:${D}px;text-align:right`)));
    }
    return () => { setArc(a, k); center.update(); boxes.forEach((box, i) => { put(box, escapeText(lines[i]())); }); };
  } },
  { id: 'columns', size: '2x2', span: [2, 2], fallback: 'spark', name: 'Columns', blurb: 'The last 30 seconds as bars; the newest bar is brightest.', build(el, w, h, k) {
    const p = padOf(w, h), side = w >= h * 2.2;
    const lw = side ? clamp(w * 0.3, 70, 220) : 0, hh = side ? 0 : clamp(h * 0.3, 26, 100), gap = side ? 0 : clamp(h * 0.05, 4, 10);
    const text = readout(el, k, side ? lw - p : w - 2 * p, side ? h - 2 * p : hh, { x: p, y: p, label: M[k].name, detail: side || hh >= 56 });
    const gx = side ? lw + p : p, gy = side ? p : p + hh + gap, gw = w - gx - p, gh = h - gy - p;
    const n = clamp(Math.floor(gw / 6), 8, 30), bw = (gw - (n - 1) * 2) / n;
    const svg = el.appendChild(ce('div', '', at(gx, gy, gw, gh)));
    svg.innerHTML = gh >= 10 ? `<svg class="abs" viewBox="0 0 ${gw} ${gh}" width="${gw}" height="${gh}"><rect class="zone" width="${gw}" height="${gh}" fill="none"/>${Array.from({ length: n }, (_, i) => `<rect class="col" x="${i * (bw + 2)}" width="${bw}" rx="${Math.min(2, bw / 2)}"/>`).join('')}<line x1="0" x2="${gw}" y1="${gh - 0.5}" y2="${gh - 0.5}" stroke="var(--line)"/></svg>` : '';
    const rects = qa('.col', svg);
    return () => {
      const a = series(k).slice(-n), off = n - a.length;
      rects.forEach((r, i) => { const v = a[i - off], bh = has(v) ? Math.max(2, frac(k, v) * (gh - 1)) : 0; r.setAttribute('y', gh - 1 - bh); r.setAttribute('height', bh); r.setAttribute('fill', tone(k, v)); r.setAttribute('fill-opacity', i === n - 1 ? 1 : 0.45); });
      text.update();
    };
  } },
  { id: 'heat', size: '2x2', span: [2, 2], fallback: 'segments', name: 'Heat map', blurb: 'Sixty squares, one per second. Brighter means higher.', build(el, w, h, k) {
    const p = padOf(w, h), side = w >= h * 2.2;
    const lw = side ? clamp(w * 0.3, 70, 220) : 0, hh = side ? 0 : clamp(h * 0.28, 26, 90), gap = side ? 0 : clamp(h * 0.05, 4, 10);
    const text = readout(el, k, side ? lw - p : w - 2 * p, side ? h - 2 * p : hh, { x: p, y: p, label: M[k].name, detail: side || hh >= 56 });
    const gx = side ? lw + p : p, gy = side ? p : p + hh + gap, gw = w - gx - p;
    const cap = h - gy - p >= 50 ? 12 : 0, gh = h - gy - p - (cap ? cap + 4 : 0);
    // 60 cells in the grid whose cells come closest to square.
    const [cols, rows] = [[10, 6], [12, 5], [15, 4], [20, 3], [30, 2], [6, 10], [5, 12], [4, 15]].reduce((best, g) => (Math.abs(Math.log((gw / g[0]) / (gh / g[1]))) < Math.abs(Math.log((gw / best[0]) / (gh / best[1]))) ? g : best));
    const grid = el.appendChild(ce('div', 'zone', `${at(gx, gy, gw, Math.max(0, gh))}display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);gap:${clamp(Math.min(gw / cols, gh / rows) * 0.15, 1, 3)}px`));
    grid.innerHTML = '<i class="hcell"></i>'.repeat(cols * rows);
    if (cap) el.appendChild(ce('span', 'lbl', `${at(gx, h - p - cap, gw, cap)}font-size:8.5px;color:var(--faint)`)).textContent = '60 s ago → now';
    const cells = qa('.hcell', grid);
    return () => {
      const a = series(k), off = N - a.length;
      // Brighter means higher: the reading's colour at 8–100% opacity; empty seconds keep the track colour.
      cells.forEach((c, i) => { const v = a[i - off]; c.style.background = has(v) ? tone(k, v) : ''; c.style.opacity = has(v) ? (0.08 + frac(k, v) * 0.92).toFixed(2) : ''; });
      text.update();
    };
  } },
  // Dashboards show the whole PC and ignore the widget's reading.
  { id: 'strip', size: 'dash', span: [4, 1], fallback: 'pair', dashboard: true, name: 'Strip', blurb: 'Several readings in a row, each with a meter.', build(el, w, h) {
    const all = DASH.strip, p = padOf(w, h);
    // As many readings as fit at about 64 px each.
    const ks = all.slice(0, clamp(Math.floor((w - 2 * p) / 64), 1, all.length)), cw = (w - 2 * p) / ks.length;
    const barH = h >= 44 ? clamp(h * 0.05, 3, 5) : 0;
    const sizes = sharedSizes(el, ks.map((k) => ({ k })), cw - 12, h - 2 * p - (barH ? barH + 4 : 0));
    const cells = ks.map((k, i) => {
      const x = p + i * cw, inner = cw - (i ? 8 : 0) - 4;
      if (i) el.appendChild(ce('div', '', `${at(x, p, 1, h - 2 * p)}background:var(--line)`));
      const text = readout(el, k, inner, h - 2 * p - (barH ? barH + 4 : 0), { x: x + (i ? 8 : 0), y: p, ...sizes });
      const bar = barH ? meter(el, x + (i ? 8 : 0), h - p - barH, inner, barH) : null;
      return () => { text.update(); if (bar) bar(k); };
    });
    return () => cells.forEach((cell) => cell());
  } },
  { id: 'overview', size: 'dash', span: [4, 2], fallback: 'strip', dashboard: true, name: 'Overview', blurb: 'Rings for CPU, GPU and memory with temperatures underneath. PCs with two GPUs show both.', build(el, w, h) {
    // CPU, GPU, RAM and GPU memory; with two or more GPUs, CPU, the first two GPUs and RAM.
    const slotsFor = (gpus) => gpus.length >= 2
      ? [{ k: 'cpu', sub: 'cputemp' }, ...gpus.slice(0, 2).map((g) => ({ k: 'gpu', gpu: g.id, sub: 'gputemp', label: VENDOR[g.vendor] || 'GPU' })), { k: 'ram' }]
      : [{ k: 'cpu', sub: 'cputemp' }, { k: 'gpu', sub: 'gputemp' }, { k: 'ram' }, { k: 'vram' }];
    const p = padOf(w, h), cols = (w - 2 * p) / 4 >= 58 && w >= h * 1.4 ? 4 : 2, rows = 4 / cols;
    const cw = (w - 2 * p) / cols, ch = (h - 2 * p) / rows;
    let shape = null, cells = [];
    return () => {
      const gpus = last().gpus || [];
      const key = gpus.length >= 2 ? gpus.slice(0, 2).map((g) => g.id).join() : '';
      if (key !== shape) {
        shape = key;
        el.replaceChildren();
        const slots = slotsFor(gpus), cap = ch >= 70 ? clamp(ch * 0.12, 10, 13) : 0;
        const s = Math.max(0, Math.min(cw - 8, ch - (cap ? cap * LINE + 4 : 0) - 4)), [bw, bh] = ringHole(s);
        const sizes = sharedSizes(el, slots.map((slot) => ({ k: slot.k, label: slot.label })), bw, bh);
        cells = slots.map((slot, i) => {
          const x = p + (i % cols) * cw, y = p + Math.floor(i / cols) * ch;
          const draw = ringAt(el, slot.k, x + (cw - s) / 2, y + 2, s, slot.label || true, sizes);
          const sub = cap ? el.appendChild(ce('span', 'det', `${at(x + 2, y + 2 + s + 4, cw - 4, cap * LINE)}font-size:${cap}px;text-align:center`)) : null;
          return { slot, draw, sub };
        });
      }
      const outer = CTX.gpu;
      cells.forEach(({ slot, draw, sub }) => {
        if (slot.gpu) CTX.gpu = slot.gpu;
        draw();
        if (sub) {
          const t = slot.sub && val(slot.sub);
          if (slot.sub) put(sub, has(t) ? `<span style="color:${tone(slot.sub)}">●</span> ${approx(slot.sub) ? '≈' : ''}${num(slot.sub)}°C` : '');
          else put(sub, escapeText(detail[slot.k]()));
        }
        CTX.gpu = outer;
      });
    };
  } },
  { id: 'monitor', size: 'dash', span: [4, 2], fallback: 'strip', dashboard: true, name: 'Monitor', blurb: 'CPU and GPU load on one graph, temps and power alongside.', build(el, w, h) {
    const p = padOf(w, h), side = w >= h * 1.6, ks = ['cputemp', 'gputemp', 'power', 'ram'];
    const legendH = h >= 80 ? clamp(h * 0.1, 14, 17) : 0;
    const pw = side ? clamp(w * 0.28, 90, 210) : w - 2 * p;
    const ph = side ? h - 2 * p : clamp(h * 0.34, 30, 120);
    const gx = p, gy = p + (legendH ? legendH + 6 : 0), gw = side ? w - pw - 3 * p : w - 2 * p, gh = h - gy - p - (side ? 0 : ph + p);
    const parts = [];
    if (legendH) {
      const legend = el.appendChild(ce('div', 'legend', `${at(p, p, gw, legendH)}font-size:${legendH / LINE}px`));
      legend.innerHTML = [['CPU', false], ['GPU', true]].map(([label, dash]) => `<span><svg width="14" height="4"><line x1="0" x2="14" y1="2" y2="2" stroke="${dash ? 'var(--muted)' : 'var(--accent)'}" stroke-width="2"${dash ? ' stroke-dasharray="4 3"' : ''}/></svg>${label} <b></b></span>`).join('');
      const [c1, c2] = qa('b', legend);
      parts.push(() => { put(c1, html('cpu')); put(c2, html('gpu')); });
    }
    if (gh >= 16) {
      const id = `ps${uid++}`, axis = gw >= 140 && gh >= 40 ? 24 : 0, cw = gw - axis;
      const chart = el.appendChild(ce('div', '', at(gx, gy, gw, gh)));
      chart.innerHTML = `<svg class="abs" viewBox="0 0 ${gw} ${gh}" width="${gw}" height="${gh}" style="color:var(--accent)">${grad(id)}<rect class="zone" width="${cw}" height="${gh}" fill="none"/>${[0, 0.5, 1].map((f) => `<line x1="0" x2="${cw}" y1="${(1 - f) * gh}" y2="${(1 - f) * gh}" stroke="var(--line)"/>${axis ? `<text x="${cw + 4}" y="${clamp((1 - f) * gh + 3, 8, gh)}" fill="var(--faint)" font-size="9" font-family="IBM Plex Mono, monospace">${f * 100}</text>` : ''}`).join('')}<path class="ar" fill="url(#${id})"/><path class="l2" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="4 3"/><path class="l1" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>`;
      const ar = q('.ar', chart), l1 = q('.l1', chart), l2 = q('.l2', chart);
      qa('stop', chart).forEach((stop) => { stop.style.stopColor = 'var(--accent)'; });
      parts.push(() => { const a = pts(series('cpu'), 0, 2, cw, gh - 4, 100), b = pts(series('gpu'), 0, 2, cw, gh - 4, 100); ar.setAttribute('d', area(a, 2, gh - 4)); l1.setAttribute('d', line(a)); l2.setAttribute('d', line(b)); });
    }
    // Side panel: four readings stacked when wide, a 2 × 2 grid under the graph when tall.
    const px = side ? w - p - pw : p, py = side ? p : h - p - ph, pcols = side ? 1 : 2;
    const fits = ks.slice(0, side ? clamp(Math.floor(ph / 18), 1, 4) : clamp(Math.floor(ph / 18) * 2, 2, 4));
    const prow = ph / Math.ceil(fits.length / pcols), pcol = pw / pcols;
    if (side) el.appendChild(ce('div', '', `${at(px - p / 2 - 1, p, 1, h - 2 * p)}background:var(--line)`));
    const rowH = Math.min(prow - 4, 30), common = Math.min(...fits.map((k) => numberSize(el, k, (pcol - 6) * 0.6, rowH)));
    fits.forEach((k, i) => {
      const r = rowReadout(el, k, px + (i % pcols) * pcol + (i % pcols ? 6 : 0), py + Math.floor(i / pcols) * prow, pcol - 6, rowH, M[k].short, common);
      parts.push(r.update);
    });
    return () => parts.forEach((part) => part());
  } },
  { id: 'cores', size: 'dash', span: [4, 2], fallback: 'strip', dashboard: true, name: 'Cores', blurb: 'Load on each CPU core, with clock speed and temperature.', build(el, w, h) {
    const p = padOf(w, h), hh = clamp(h * 0.2, 14, 34);
    const head = rowReadout(el, 'cpu', p, p, Math.min(w - 2 * p, 160), hh, 'CPU');
    const D = clamp(hh * 0.5, 9, 11.5), info = w - 2 * p - 170 >= 60 ? el.appendChild(ce('span', 'det', `${at(p + 170, p + (hh - D * LINE) / 2, w - 2 * p - 170, D * LINE)}font-size:${D}px;text-align:right`)) : null;
    const top = p + hh + clamp(h * 0.05, 4, 10);
    const grid = el.appendChild(ce('div', 'cg', `${at(p, top, w - 2 * p, h - top - p)}display:grid;gap:${clamp(w * 0.012, 2, 6)}px`));
    let count = -1, bars = [], labels = [];
    return () => {
      const cores = (last().cores || []).slice(0, 32);
      if (cores.length !== count) {
        count = cores.length;
        const bw = (w - 2 * p) / Math.max(1, count), labelled = bw >= 18 && h - top - p >= 50;
        grid.style.gridTemplateColumns = `repeat(${Math.max(1, count)},1fr)`;
        grid.innerHTML = cores.map(() => `<div style="display:flex;flex-direction:column;gap:3px;min-width:0"><div class="cbar zone" style="flex:1"><i></i></div>${labelled ? `<span class="lbl" style="font-size:${clamp(bw * 0.3, 7.5, 9)}px;text-align:center;color:var(--muted)"></span>` : ''}</div>`).join('');
        bars = qa('.cbar i', grid); labels = qa('.lbl', grid);
      }
      cores.forEach((v, i) => { bars[i].style.transform = `translateY(${100 - clamp(v, 0, 100)}%)`; bars[i].style.opacity = 0.45 + v / 180; if (labels[i]) put(labels[i], Math.round(v)); });
      head.update();
      if (info) put(info, [detail.cpu(), has(val('cputemp')) ? `<span style="color:${tone('cputemp')}">${approx('cputemp') ? '≈' : ''}${num('cputemp')}°C</span>` : ''].filter(Boolean).join(' · '));
    };
  } },
];

const S = Object.fromEntries(STYLES.map((s) => [s.id, s]));

// The style actually drawn in a block of `columns` × `rows` cells: the chosen one when it fits, else its fallbacks.
// The sample groups a widget needs: its reading, the paired reading for Pair and Gauge, or a
// dashboard's set. Uses the style actually drawn at this size.
function needs(style, metric, columns = 1, rows = 1) {
  const drawn = resolve(style, columns, rows), k = M[metric] ? metric : 'cpu';
  const shown = drawn.dashboard ? DASH[drawn.id] : drawn.id === 'pair' || drawn.id === 'gauge' ? [k, PAIR[k]] : [k];
  const out = new Set(shown.flatMap((x) => USES[x]));
  if (drawn.id === 'cores') out.add('cores');
  return [...out].sort();
}

function resolve(id, columns, rows) {
  let style = S[id] || S.ring;
  while (style.span[0] > columns || style.span[1] > rows) style = S[style.fallback] || S.ring;
  return style;
}

const CSS = `.ps-root{--fg:#ececef;--muted:#a1a1aa;--faint:#63636d;--line:#24252b;--track:#202127;--ok:#46a758;--warm:#f5a524;--hot:#e5484d;position:relative;overflow:hidden;color:var(--fg);font-family:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums;contain:strict}
.ps-root *{box-sizing:border-box}
.ps-root .abs{position:absolute;inset:0;display:block;overflow:visible}
.ps-root .lbl{font-family:"IBM Plex Mono",ui-monospace,Consolas,monospace;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);line-height:1.34;white-space:nowrap}
.ps-root .num{font-weight:600;letter-spacing:-.03em;line-height:1.34;white-space:nowrap}
.ps-root .num small{font-size:max(7px,.42em);font-weight:500;color:var(--muted);letter-spacing:0;margin-left:.12em}
.ps-root .num small.ap{font-size:max(7px,.62em);margin:0 .04em 0 0;color:var(--muted)}
.ps-root .num small.why{font-size:max(7px,.34em);margin:0;color:var(--faint);letter-spacing:.02em}
.ps-root .det{color:var(--muted);font-size:11px;white-space:nowrap;line-height:1.34;overflow:hidden;text-overflow:ellipsis}
.ps-root .center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}
.ps-root .ro{display:flex;flex-direction:column;justify-content:center;min-width:0}
.ps-root .rrow{display:flex;align-items:center;gap:6px;min-width:0}
.ps-root .ro .lbl,.ps-root .rrow .lbl{overflow:hidden;text-overflow:ellipsis}
.ps-root .srow{position:absolute;display:flex;justify-content:space-between;align-items:center;white-space:nowrap;gap:6px}
.ps-root .srow>span{display:flex;gap:.35em;align-items:baseline}
.ps-root .srow b{font-weight:500}
.ps-root .legend{position:absolute;display:flex;gap:12px;align-items:center;white-space:nowrap;font-family:"IBM Plex Mono",ui-monospace,Consolas,monospace;color:var(--muted)}
.ps-root .legend span{display:flex;gap:5px;align-items:center}
.ps-root .legend b{color:var(--fg);font-weight:500}
.ps-root .pad{position:absolute;inset:0;display:flex;flex-direction:column}
.ps-root .bar{height:4px;border-radius:2px;background:var(--track);overflow:hidden}
.ps-root .bar i{display:block;height:100%;width:100%;border-radius:inherit;transform:translateX(-100%);transition:transform .8s cubic-bezier(.2,.8,.2,1)}
.ps-root .arcv,.ps-root .ringv{transition:stroke-dasharray .8s cubic-bezier(.2,.8,.2,1),stroke .4s}
.ps-root .needle{transition:transform .8s cubic-bezier(.2,.8,.2,1)}
.ps-root .liq::before{content:"";position:absolute;inset:0;background:var(--c);opacity:.2}
.ps-root .liq{position:absolute;inset:0;border-top:2px solid var(--c);transform:translateY(100%);transition:transform .8s cubic-bezier(.2,.8,.2,1)}
.ps-root .seg{display:flex;gap:2px}
.ps-root .seg i{flex:1;border-radius:2px;background:var(--track)}
.ps-root .hcell{border-radius:3px;background:var(--track)}
.ps-root .cbar{position:relative;background:var(--track);border-radius:4px;overflow:hidden}
.ps-root .cbar i{position:absolute;inset:0;border-radius:4px;background:var(--accent);transform:translateY(100%);transition:transform .8s cubic-bezier(.2,.8,.2,1)}
.ps-root.ps-still *{transition:none!important}
@media (prefers-reduced-motion:reduce){.ps-root *{transition:none!important}}`;
// --- Themes. Dark is the original look. The widget's own variables are set on its root, so a theme change is a
// handful of style updates, not a redraw.
const THEMES = {
  dark: { fg: '#ececef', muted: '#a1a1aa', faint: '#63636d', line: '#24252b', track: '#202127', ok: '#46a758', warm: '#f5a524', hot: '#e5484d' },
  light: { fg: '#18181b', muted: '#52525b', faint: '#6b6b76', line: '#e0e0e6', track: '#e4e4ea', ok: '#22c55e', warm: '#f59e0b', hot: '#ef4444' },
};
let theme = 'dark';
const shown = new Set();
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16), f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(n >> 16 & 255) + 0.7152 * f(n >> 8 & 255) + 0.0722 * f(n & 255);
};
function hslOf(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
function hexOf(h, s, l) {
  s /= 100; l /= 100;
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
// The picked color on a light tile without turning to mud: its own hue, a little more saturation (never neon), and
// the yellow-green band leaning toward gold as it darkens.
function readable(hex) {
  if (theme !== 'light') return hex;
  let [h, sat, l] = hslOf(hex);
  const cap = capFor(h);
  if (h >= 46 && h <= 72) h -= 10;
  if (sat > 15) sat = Math.min(92, sat + 8);
  else if (l > 50) l = 100 - l; // white and pale greys become dark ink
  while (l > 6 && lum(hexOf(h, sat, l)) > cap) l -= 1;
  return hexOf(h, sat, l);
}
// A #rrggbb colour at `pct` percent (0 to 100) opacity; anything else is returned as it is.
function withOpacity(colour, pct) {
  const m = /^#([0-9a-f]{6})$/i.exec(colour || '');
  if (!m || pct >= 100) return colour;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${(Math.max(0, pct) / 100).toFixed(2)})`;
}
function styleRoot(entry) {
  const { root, color, background, opacity } = entry;
  for (const [key, value] of Object.entries(THEMES[theme])) root.style.setProperty(`--${key}`, value);
  root.style.setProperty('--accent', readable(color || '#93c5fd'));
  root.style.background = background ? withOpacity(background, opacity) : '';
}

function injectCss() {
  if (typeof document === 'undefined' || document.getElementById('open-dock-pc-stats-css')) return;
  const style = document.createElement('style'); style.id = 'open-dock-pc-stats-css'; style.textContent = CSS; document.head.append(style);
}

// Draws a style into `host` at width × height px. columns/rows are the widget's grid span, used to pick a fitting style.
// `still` jumps readings to their new value instead of gliding there: with a reading every second a
// 0.8 s glide keeps the widget animating most of the time, which a phone pays for in battery and heat.
// `background` paints the tile colour behind the widget. The phone passes it: Android's WebView
// composites translucent pixels onto the app poorly, so fades and tints must blend inside the page.
function mount(host, { style, metric, color, gpu, background, opacity = 100, still = false, width, height, columns = 1, rows = 1 }) {
  injectCss();
  const root = document.createElement('div');
  root.className = still ? 'ps-root ps-still' : 'ps-root';
  root.style.cssText = `width:${width}px;height:${height}px`;
  const entry = { root, color, background, opacity };
  styleRoot(entry);
  shown.add(entry);
  host.replaceChildren(root);
  const draw = resolve(style, columns, rows).build(root, width, height, M[metric] ? metric : 'cpu');
  const update = () => { CTX.gpu = gpu || 'auto'; draw(); };
  update();
  mounted.add(update);
  return { destroy() { mounted.delete(update); shown.delete(entry); root.remove(); } };
}
const redraw = () => mounted.forEach((update) => update());

globalThis.OpenDockStats = {
  metrics: METRICS,
  styles: STYLES.map(({ id, size, span, name, blurb, dashboard }) => ({ id, size, span, name, blurb, dashboard: !!dashboard })),
  resolve: (id, columns, rows) => resolve(id, columns, rows).id,
  needs,
  setHistory(samples) { history = Array.isArray(samples) ? samples.slice(-N) : []; redraw(); },
  push(sample) { history.push(sample); if (history.length > N) history.shift(); redraw(); },
  latest: () => history[history.length - 1] || null,
  // 'light' or 'dark'. `background` is the tile color behind widgets that were mounted with one (the phone's).
  setTheme(value, background) {
    theme = value === 'light' ? 'light' : 'dark';
    for (const entry of shown) { if (entry.background && background) entry.background = background; styleRoot(entry); }
  },
  mount,
};
})();
