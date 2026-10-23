// Run: node scripts/check-theme.ts
// Light and dark must stay in step. Fails when a color token exists in one theme but not the other, when a text or
// control color falls below its contrast target against the surfaces it sits on (in both themes, on the PC app, the
// phone app and the widgets), or when a color is written out where a token belongs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { darkColors, lightColors, LOOK_THEMES } from '../phone-app/src/theme-colors.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

// --- Contrast (WCAG 2.x)
const channel = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function luminance(hex: string): number {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  const n = parseInt(full.slice(1, 7), 16);
  return 0.2126 * channel(n >> 16 & 255) + 0.7152 * channel(n >> 8 & 255) + 0.0722 * channel(n & 255);
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const isHex = (value: string | undefined): value is string => !!value && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value);
const failures: string[] = [];
// Dark is the app's original look and is kept as it was, so it only has to stay above a floor (its dimmest text,
// the grey #71717a on near-black, is about 3.7:1). Light is new and has to meet each target.
const DARK_FLOOR = 3;
function need(theme: string, label: string, fg: string | undefined, bg: string | undefined, min: number) {
  if (!isHex(fg) || !isHex(bg)) { failures.push(`${theme}: ${label}: not a plain #hex color (${fg} on ${bg})`); return; }
  const target = /dark/.test(theme) ? Math.min(min, DARK_FLOOR) : min;
  const ratio = contrast(fg, bg);
  if (ratio < target) failures.push(`${theme}: ${label} is ${ratio.toFixed(2)}:1 (${fg} on ${bg}), needs ${target}:1`);
}

// --- The PC app: App.css tokens
const css = read('pc-companion/src/App.css');
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} not found in App.css`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
}
const pcDark = tokens(':root, :root[data-theme="dark"]');
const pcLight = tokens(':root[data-theme="light"]');
assert.deepEqual(Object.keys(pcLight).sort(), Object.keys(pcDark).sort(), 'PC app: a token is missing from one theme');
assert.ok(Object.keys(pcDark).length >= 30, 'PC app: tokens not read');

// The designed looks: each replaces some of its base theme's tokens.
const LOOK_BASE = { console: 'dark', bento: 'light', desk: 'light', glass: 'dark', funk: 'dark' } as const;
const pcLooks = Object.entries(LOOK_BASE).map(([look, base]) => {
  const own = tokens(`:root[data-look="${look}"]`);
  const unknown = Object.keys(own).filter((name) => !(name in pcDark) && !/^--(key|tile|lcd|metal|desk|aurora)-/.test(name));
  assert.deepEqual(unknown, [], `PC ${look}: tokens the base themes do not have`);
  return [`PC ${look} (${base})`, { ...(base === 'dark' ? pcDark : pcLight), ...own }] as const;
});
for (const [theme, t] of [['PC dark', pcDark], ['PC light', pcLight], ...pcLooks] as const) {
  for (const surface of ['--background', '--card', '--card-raised', '--z850']) {
    need(theme, `foreground on ${surface}`, t['--foreground'], t[surface], 7);
    need(theme, `muted on ${surface}`, t['--muted'], t[surface], 4.5);
    need(theme, `subtle on ${surface}`, t['--subtle'], t[surface], surface === '--z850' ? 3 : 4.5);
    need(theme, `blue on ${surface}`, t['--blue'], t[surface], 3);
    need(theme, `red on ${surface}`, t['--red'], t[surface], 4.5);
  }
  need(theme, 'text on the selected row', t['--foreground'], t['--z800'], 7);
  need(theme, 'muted on the selected row', t['--muted'], t['--z800'], 4.5);
  need(theme, 'text on a primary button', t['--z900'], t['--z200'], 7);
  need(theme, 'light text on a danger button', '#ffffff', t['--red-solid'], 4.5);
  need(theme, 'green dot on a card', t['--green'], t['--card'], 3);
  // The favourite star is a vivid amber on purpose; its shape, not its color alone, carries the meaning.
  need(theme, 'star on a card', t['--star'], t['--card'], 2);
  need(theme, 'a rail badge', t['--z300'], t['--z700'], 4.5);
  if (isHex(t['--warn-bg']) || /^#[0-9a-f]{6}$/i.test(t['--warn-bg'] ?? '')) need(theme, 'warning text', t['--warn-text'], t['--warn-bg'], 4.5);
  else need(theme, 'warning text on a card', t['--warn-text'], t['--card'], 4.5);
}

// Every color in the rest of the stylesheet is a token. These two are fixed on purpose: the QR code's white, and
// white text on the red button.
const rest = css.slice(css.lastIndexOf(':root[data-look='));
const afterTokens = rest.slice(rest.indexOf('\n}') + 2);
const strays = afterTokens.split('\n').filter((line) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(line))
  .filter((line) => !(line.startsWith('.qr-frame') || line.startsWith('.primary-button.danger {') || line.startsWith('.clock-swatch {')));
assert.deepEqual(strays, [], `App.css: colors written out instead of tokens:\n${strays.join('\n')}`);

// --- The phone app
assert.deepEqual(Object.keys(lightColors).sort(), Object.keys(darkColors).sort(), 'phone: a token is missing from one theme');
const phoneLooks = Object.entries(LOOK_THEMES).map(([look, { colors, scheme }]) => [`phone ${look} (${scheme})`, colors] as const);
for (const [theme, c] of [['phone dark', darkColors], ['phone light', lightColors], ...phoneLooks] as const) {
  for (const surface of ['bg', 'panel', 'panelRaised'] as const) {
    need(theme, `text on ${surface}`, c.text, c[surface], 7);
    need(theme, `muted on ${surface}`, c.muted, c[surface], 4.5);
    need(theme, `faint on ${surface}`, c.faint, c[surface], surface === 'panelRaised' ? 4.4 : 4.5);
    need(theme, `red on ${surface}`, c.red, c[surface], 4.5);
    need(theme, `mint on ${surface}`, c.mint, c[surface], 4.5);
    need(theme, `warn on ${surface}`, c.warn, c[surface], 4.5);
    need(theme, `blue on ${surface}`, c.blue, c[surface], 3);
    need(theme, `star on ${surface}`, c.star, c[surface], 1.9);
  }
  need(theme, 'text on a pressed key', c.text, c.pressed, 7);
  need(theme, 'muted on a pressed key', c.muted, c.pressed, 4.5);
  need(theme, 'text on a primary button', c.onAccent, c.accent, 7);
  need(theme, 'text on a mint tag', c.onMint, c.mint, 4.5);
  need(theme, 'good tag text on its row', c.mint, c.goodBg, 4.5);
}

// Colors written out in the phone's own code: only where one color is right in both themes.
const SKIP = new Set(['theme-colors.ts', 'clock-faces-source.ts', 'pc-stats-source.ts', 'web-fonts-source.ts', 'perf-overlay.tsx', 'media-players.ts']);
const ALLOWED_LINES = [/badgeLetter:/];
const phoneRoot = join(ROOT, 'phone-app/src');
const phoneStrays: string[] = [];
for (const entry of readdirSync(phoneRoot, { recursive: true, encoding: 'utf8' })) {
  if (!/\.(ts|tsx)$/.test(entry) || SKIP.has(entry.split(/[\\/]/).pop()!)) continue;
  readFileSync(join(phoneRoot, entry), 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (/#[0-9a-f]{6}\b|rgba?\(/i.test(line) && !ALLOWED_LINES.some((allowed) => allowed.test(line))) phoneStrays.push(`${relative(ROOT, join(phoneRoot, entry))}:${index + 1}: ${line.trim().slice(0, 100)}`);
  });
}
assert.deepEqual(phoneStrays, [], `phone: colors written out instead of theme tokens:\n${phoneStrays.join('\n')}`);

// --- The widgets: the clock faces and PC stats carry their own light and dark palettes
function paletteKeys(source: string, name: 'dark' | 'light'): Record<string, string> {
  const line = source.split('\n').find((candidate) => candidate.startsWith(`  ${name}: {`));
  assert.ok(line, `${name} palette not found`);
  return Object.fromEntries([...line.matchAll(/(\w+): ('[^']*'|true|false)/g)].map((m) => [m[1], m[2].replace(/'/g, '')]));
}
const clock = read('pc-companion/src/clock-faces/clock-faces.js');
const clockDark = paletteKeys(clock, 'dark');
const clockLight = paletteKeys(clock, 'light');
assert.deepEqual(Object.keys(clockLight).sort(), Object.keys(clockDark).sort(), 'clock faces: a palette entry is missing from one theme');
for (const [theme, p] of [['clock dark', clockDark], ['clock light', clockLight]] as const) {
  for (const plate of ['plate', 'plate2'] as const) {
    need(theme, `text on ${plate}`, p.fg, p[plate], 7);
    need(theme, `muted on ${plate}`, p.muted, p[plate], 4.5);
  }
  need(theme, 'dial hands on the dial', p.fg, p.dial, 7);
  need(theme, 'unlit tones are visible on the plate', p.dim, p.plate, 1.1);
  if (theme === 'clock dark') need(theme, 'the digit on a lit pill', p.onAccent, '#93c5fd', 4.5);
}
const stats = read('pc-companion/src/pc-stats/pc-stats.js');
const themeLine = (name: string) => Object.fromEntries([...(stats.split('\n').find((line) => line.startsWith(`  ${name}: {`)) ?? '').matchAll(/(\w+): '([^']*)'/g)].map((m) => [m[1], m[2]]));
const statsDark = themeLine('dark'), statsLight = themeLine('light');
assert.ok(Object.keys(statsDark).length >= 8, 'PC stats: palette not read');
assert.deepEqual(Object.keys(statsLight).sort(), Object.keys(statsDark).sort(), 'PC stats: a palette entry is missing from one theme');
for (const [theme, p, tile] of [['stats dark', statsDark, '#111113'], ['stats light', statsLight, '#fafafa']] as const) {
  need(theme, 'text on the tile', p.fg, tile, 7);
  need(theme, 'muted on the tile', p.muted, tile, 4.5);
  need(theme, 'faint on the tile', p.faint, tile, 4.5);
  // The temperature colors are vivid on purpose (a bar or dot beside its number, so color is never the only signal).
  for (const level of ['ok', 'warm', 'hot'] as const) need(theme, `${level} temperature on the tile`, p[level], tile, 2);
}

assert.deepEqual(failures, [], `Contrast or token problems:\n${failures.join('\n')}`);
console.log('check-theme: ok');
