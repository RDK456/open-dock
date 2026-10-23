// Run: node scripts/check-pc-stats.ts
// Fails when the phone copy of the PC stats widgets is stale, the Rust allowlists drift from the
// styles and readings, a style's fallback doesn't fit the block it falls back for, or any style
// renders badly in a GPU scenario (no GPU, one GPU, two GPUs, missing driver, sleeping, estimates).
// Rendering runs in a headless Chromium (Edge or Chrome; set BROWSER to override). Without one,
// that part is skipped with a notice.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInThisContext } from 'node:vm';

// Line endings depend on the checkout (core.autocrlf), so the phone copy always uses LF.
const source = readFileSync(new URL('../pc-companion/src/pc-stats/pc-stats.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const phone = readFileSync(new URL('../phone-app/src/pc-stats-source.ts', import.meta.url), 'utf8');
assert.ok(phone.includes(JSON.stringify(source)), 'phone-app/src/pc-stats-source.ts is stale: run node scripts/sync-pc-stats.ts');

// Android WebViews (older ones especially) lack color-mix() and resolve currentColor in gradient
// stops differently; the widgets avoid both so they look the same on every phone.
assert.ok(!/color-mix|currentColor/.test(source), 'pc-stats.js uses color-mix() or currentColor, which break on some Android WebViews');

runInThisContext(source);
type Style = { id: string; span: [number, number] };
const api = (globalThis as unknown as { OpenDockStats: { styles: Style[]; metrics: { id: string }[]; resolve(id: string, columns: number, rows: number): string } }).OpenDockStats;
const styles = api.styles.map((style) => style.id).sort();
const metrics = api.metrics.map((metric) => metric.id).sort();
assert.equal(new Set(styles).size, styles.length, 'duplicate style ids');

const rust = readFileSync(new URL('../pc-companion/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const list = (name: string) => {
  const match = rust.match(new RegExp(String.raw`const ${name}: &\[&str\] = &\[([^\]]*)\]`));
  assert.ok(match, `${name} not found in lib.rs`);
  return [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
};
assert.deepEqual(list('PC_STATS_STYLES'), styles, 'PC_STATS_STYLES in lib.rs does not match the styles');
assert.deepEqual(list('PC_STATS_METRICS'), metrics, 'PC_STATS_METRICS in lib.rs does not match the readings');

// Every style in every block up to 6 x 6 resolves to a style that fits, and to itself when it fits.
const span = Object.fromEntries(api.styles.map((style) => [style.id, style.span]));
for (const style of api.styles) for (let columns = 1; columns <= 6; columns++) for (let rows = 1; rows <= 6; rows++) {
  const shown = api.resolve(style.id, columns, rows);
  assert.ok(span[shown][0] <= columns && span[shown][1] <= rows, `${style.id} in ${columns}x${rows} falls back to ${shown}, which doesn't fit`);
  if (style.span[0] <= columns && style.span[1] <= rows) assert.equal(shown, style.id, `${style.id} fits ${columns}x${rows} but falls back`);
}
assert.equal(api.resolve('unknown', 1, 1), 'ring', 'unknown styles draw as Ring');
assert.equal(api.resolve('graph', 2, 1), 'spark', 'Graph in a 2x1 falls back to Sparkline');

// --- Rendering in a browser ---------------------------------------------------
const gpu = (fields: Record<string, unknown>) => ({ id: 'x', name: 'GPU', vendor: 'other', kind: 'unknown', state: 'ok', load: null, temp: null, tempApprox: false, hotspot: null, power: null, powerLimit: null, powerPercent: null, fan: null, fanRpm: null, memUsed: null, memTotal: null, memKind: 'unknown', sources: {}, ...fields });
const base = { cpu: 23, cputemp: 64, cputempApprox: false, clock: 3.6, cores: [20, 30, 10, 40], ram: 51.4, ramUsed: 8, ramTotal: 16, disk: 70, diskUsed: 170, diskTotal: 237, diskio: 0.35, diskRead: 0.3, diskWrite: 0.05, net: 1.2, netUp: 0.024 };
const intel = gpu({ id: '8086-9bc4-14411025-0', name: 'Intel(R) UHD Graphics', vendor: 'intel', kind: 'integrated', load: 16, temp: 77, tempApprox: true, memUsed: 0.4, memTotal: 7.9, memKind: 'shared' });
const rtx = gpu({ id: '10de-1f15-14421025-0', name: 'NVIDIA GeForce RTX 2060', vendor: 'nvidia', kind: 'discrete', load: 45, temp: 66, power: 80, powerLimit: 115, fan: 40, memUsed: 3, memTotal: 6, memKind: 'dedicated' });
// Each scenario: samples, the widget's gpu option, and text every GPU-reading widget must show.
const scenarios = [
  { name: 'nothing received yet', samples: [], gpu: 'auto', expect: {} },
  { name: 'no GPUs', samples: [{ ...base, gpus: [] }], gpu: 'auto', expect: { gpu: 'No GPU' } },
  { name: 'desktop NVIDIA', samples: [{ ...base, gpus: [rtx] }], gpu: 'auto', expect: { gpu: '45', gputemp: '66', power: '80', vram: '50', ram: '51', net: '1.2', diskio: '350' } },
  { name: 'laptop, NVIDIA driver missing (auto)', samples: [{ ...base, cputempApprox: true, gpus: [intel, gpu({ id: '10de-1f15-14421025-0', name: 'NVIDIA GPU', vendor: 'nvidia', kind: 'discrete', state: 'no-driver' })] }], gpu: 'auto', expect: { gpu: '16', gputemp: '≈', cputemp: '≈', power: 'No sensor' } },
  { name: 'laptop, NVIDIA driver missing (chosen)', samples: [{ ...base, gpus: [intel, gpu({ id: '10de-1f15-14421025-0', name: 'NVIDIA GPU', vendor: 'nvidia', kind: 'discrete', state: 'no-driver' })] }], gpu: '10de-1f15-14421025-0', expect: { gpu: 'No driver', gputemp: 'No driver' } },
  { name: 'hybrid, NVIDIA asleep (chosen)', samples: [{ ...base, gpus: [intel, { ...rtx, state: 'sleeping', load: 0, temp: null, power: null }] }], gpu: rtx.id, expect: { gpu: '0', gputemp: 'Asleep' } },
  { name: 'D3DKMT only (power as % of limit)', samples: [{ ...base, gpus: [gpu({ id: '1002-73bf-00000000-0', name: 'AMD Radeon RX 6800', vendor: 'amd', kind: 'discrete', load: 30, temp: 55, powerPercent: 42, fanRpm: 1400 })] }], gpu: 'auto', expect: { power: '42', gputemp: '55' } },
  { name: 'Apple Silicon', samples: [{ ...base, clock: null, gpus: [gpu({ id: 'apple-gpu-0', name: 'Apple M2', vendor: 'apple', kind: 'integrated', load: 12, temp: 48, memUsed: 2, memTotal: 16, memKind: 'unified', fan: null })] }], gpu: 'auto', expect: { gpu: '12', vram: '13', power: 'No sensor' } },
  { name: 'chosen GPU gone (falls back to auto)', samples: [{ ...base, gpus: [rtx] }], gpu: 'dead-beef-0', expect: { gpu: '45' } },
];

const browser = process.env.BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);

if (!browser) {
  console.log('pc stats: no Chromium browser found, skipping the render check (set BROWSER to enable)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'open-dock-pc-stats-'));
  // The headless Edge profile is ~400 MB; remove it however the run ends.
  process.on('exit', () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const page = join(dir, 'render.html');
  // Renders every style x reading x scenario, checks each tile, and writes failures into #result.
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><body><pre id="result">running</pre><div id="host"></div><script>
${source}
const scenarios = ${JSON.stringify(scenarios)};
const failures = [];
let tiles = 0;
const host = document.getElementById('host');
for (const scenario of scenarios) {
  OpenDockStats.setHistory(scenario.samples);
  for (const style of OpenDockStats.styles) {
    for (const metric of style.dashboard ? ['cpu'] : OpenDockStats.metrics.map((m) => m.id)) {
      const el = document.createElement('div');
      host.append(el);
      const [columns, rows] = style.span;
      try {
        OpenDockStats.mount(el, { style: style.id, metric, color: '#93c5fd', gpu: scenario.gpu, width: columns * 90, height: rows * 90, columns, rows });
        const text = el.textContent;
        const where = scenario.name + ' / ' + style.id + ' / ' + metric;
        // Attributes included: a NaN size or path coordinate is as broken as NaN text.
        if (/NaN|undefined|null|\\[object|Infinity/.test(el.innerHTML)) failures.push(where + ': bad value in ' + JSON.stringify(el.innerHTML.match(/.{0,60}(NaN|undefined|null|\\[object|Infinity).{0,40}/)[0]));
        const want = scenario.expect[metric];
        if (want && !style.dashboard && !text.includes(want)) failures.push(where + ': expected ' + JSON.stringify(want) + ' in ' + JSON.stringify(text.slice(0, 120)));
      } catch (error) {
        failures.push(scenario.name + ' / ' + style.id + ' / ' + metric + ': ' + error.message);
      }
      tiles++;
      el.remove();
    }
  }
}
// The Overview shows both GPUs side by side on a two-GPU PC.
OpenDockStats.setHistory(${JSON.stringify([{ ...base, gpus: [intel, rtx] }])});
const overview = document.createElement('div');
host.append(overview);
OpenDockStats.mount(overview, { style: 'overview', width: 380, height: 180, columns: 4, rows: 2 });
if (!(overview.textContent.includes('Intel') && overview.textContent.includes('NVIDIA'))) failures.push('overview: two GPUs not shown side by side: ' + overview.textContent);
overview.remove();

// needs() must list everything a widget reads: rendered from a sample trimmed to its needs, every
// widget must look the same as from a full sample. FIELDS mirrors pc_stats::PcStats in Rust.
const FIELDS = { cpu: ['cpu'], clock: ['clock'], cores: ['cores'], cputemp: ['cputemp', 'cputempSource'], gpu: ['gpus'], ram: ['ram', 'ramUsed', 'ramTotal'], disk: ['disk', 'diskUsed', 'diskTotal'], diskio: ['diskio', 'diskRead', 'diskWrite'], net: ['net', 'netUp'] };
const full = ${JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ ...base, seq: i, cputempApprox: true, cores: [10 + i, 20, 30, 40], gpus: [intel, rtx] })))};
for (const style of OpenDockStats.styles) for (const metric of style.dashboard ? ['cpu'] : OpenDockStats.metrics.map((m) => m.id)) {
  const [c, r] = style.span;
  const keep = new Set(['seq', 'cputempApprox', ...OpenDockStats.needs(style.id, metric, c, r).flatMap((n) => FIELDS[n])]);
  const draw = (samples) => { const el = document.createElement('div'); host.append(el); OpenDockStats.setHistory(samples); OpenDockStats.mount(el, { style: style.id, metric, width: c * 120, height: r * 110, columns: c, rows: r }); const text = el.textContent; el.remove(); return text; };
  const all = draw(full), trimmed = draw(full.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => keep.has(k)))));
  if (all !== trimmed) failures.push('needs ' + style.id + '/' + metric + ' misses a reading: ' + JSON.stringify(all.slice(0, 80)) + ' vs ' + JSON.stringify(trimmed.slice(0, 80)));
}

// Layout: every style at every block size the phone can show. Text must stay inside the tile,
// off other text, off graphs and bars (marked .zone), and readable.
const layout = [];
const boxes = (el) => {
  const tile = el.firstChild.getBoundingClientRect();
  const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const own = (e) => [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
  const texts = [...el.querySelectorAll('*')].filter((e) => own(e).length && shown(e)).map((e) => {
    // Ellipsized text is measured by its box (the cut is deliberate); other text by its glyphs.
    let r = e.getBoundingClientRect();
    if (getComputedStyle(e).textOverflow !== 'ellipsis') {
      const range = document.createRange();
      const rects = own(e).map((n) => { range.selectNode(n); return range.getBoundingClientRect(); });
      r = { left: Math.min(...rects.map((q) => q.left)), top: Math.min(...rects.map((q) => q.top)), right: Math.max(...rects.map((q) => q.right)), bottom: Math.max(...rects.map((q) => q.bottom)) };
    }
    return { e, r, size: parseFloat(getComputedStyle(e).fontSize), label: own(e).map((n) => n.textContent.trim()).join(' ').slice(0, 24) };
  });
  const zones = [...el.querySelectorAll('.zone')].filter(shown).map((e) => ({ e, r: e.getBoundingClientRect() }));
  return { tile, texts, zones };
};
// A text box includes the font's ascent and descent padding, so only overlaps deeper than a fifth of
// the text's height count; that's where glyphs start to touch.
const hit = (a, b, slack) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > slack;
const depth = (...rects) => Math.max(1, 0.2 * Math.min(...rects.map((q) => q.bottom - q.top)));
const surfaces = [{ width: 790, height: 385 }, { width: 380, height: 700 }];
const sizes = new Map();
for (const surface of surfaces) for (let C = 1; C <= 6; C++) for (let R = 1; R <= 6; R++) for (let c = 1; c <= C; c++) for (let r = 1; r <= R; r++) {
  const cw = (surface.width - 10 * (C - 1)) / C, ch = (surface.height - 10 * (R - 1)) / R;
  const w = Math.round(c * cw + (c - 1) * 10 - 10), h = Math.round(r * ch + (r - 1) * 10 - 10);
  sizes.set(c + 'x' + r + '@' + w + 'x' + h, { c, r, w, h });
}
OpenDockStats.setHistory(${JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ ...base, net: i % 9 === 0 ? 2.4 : 0.012, diskio: 12 + (i % 5), cputempApprox: true, gpus: [intel, gpu({ id: '10de-1f15-14421025-0', name: 'NVIDIA GPU', vendor: 'nvidia', kind: 'discrete', state: 'no-driver' })] })))});
const drawn = new Set();
for (const style of OpenDockStats.styles) for (const { c, r, w, h } of sizes.values()) {
  const actual = OpenDockStats.resolve(style.id, c, r);
  for (const [metric, gpu] of style.dashboard ? [['cpu', 'auto']] : [['net', 'auto'], ['gputemp', 'auto'], ['gpu', '10de-1f15-14421025-0']]) {
    const key = actual + metric + gpu + w + 'x' + h;
    if (drawn.has(key)) continue;
    drawn.add(key);
    const el = document.createElement('div');
    host.append(el);
    OpenDockStats.mount(el, { style: style.id, metric, gpu, width: w, height: h, columns: c, rows: r });
    const { tile, texts, zones } = boxes(el);
    const where = actual + ' ' + c + 'x' + r + ' (' + w + 'x' + h + ') ' + metric + ': ';
    for (const t of texts) {
      if (t.r.left < tile.left - 1 || t.r.right > tile.right + 1 || t.r.top < tile.top - depth(t.r) || t.r.bottom > tile.bottom + depth(t.r)) layout.push(where + 'cut off "' + t.label + '"');
      if (t.size < 7) layout.push(where + 'too small (' + t.size.toFixed(1) + 'px) "' + t.label + '"');
      for (const z of zones) if (!z.e.contains(t.e) && hit(t.r, z.r, depth(t.r))) layout.push(where + '"' + t.label + '" covers a graph');
    }
    // A dashboard's readings share one number size, so no cell looks smaller than its neighbours.
    if (['strip', 'overview', 'monitor', 'pair'].includes(actual)) {
      const sizes = [...el.querySelectorAll(actual === 'overview' || actual === 'strip' ? '.ro .num' : '.ro .num, .rrow .num')].map((n) => parseFloat(n.style.fontSize));
      if (sizes.length > 1 && Math.max(...sizes) - Math.min(...sizes) > 0.5) layout.push(where + 'readings differ in size: ' + sizes.map((n) => n.toFixed(1)).join(', '));
    }
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (!a.e.contains(b.e) && !b.e.contains(a.e) && hit(a.r, b.r, depth(a.r, b.r))) layout.push(where + '"' + a.label + '" overlaps "' + b.label + '"');
    }
    tiles++;
    el.remove();
  }
}
if (layout.length) failures.push(layout.length + ' layout problems', ...layout.slice(0, 3000));
document.getElementById('result').textContent = JSON.stringify({ tiles, failures });
</script>`);
  const dom = execFileSync(browser, [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=120000', '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const raw = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(raw && raw !== 'running', 'render page did not finish');
  const result = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')) as { tiles: number; failures: string[] };
  assert.deepEqual(result.failures, [], `${result.failures.length} render failures:\n${result.failures.join('\n')}`);
  console.log(`pc stats: rendered ${result.tiles} tiles in ${scenarios.length} scenarios ok`);
}
console.log(`pc stats: ${styles.length} styles, ${metrics.length} readings ok`);
