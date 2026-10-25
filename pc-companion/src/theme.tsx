import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Light, dark, or whatever this PC is set to, and the deck's look. Both are kept here (for the page's colors, read
// again by the inline script in index.html before the first paint) and the light/dark result by the app (for the
// native title bar, see `set_appearance` in lib.rs). The colors themselves are the tokens in App.css, switched by
// <html data-theme> and, for a designed look, <html data-look>.
export type ThemeMode = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';
/** Classic is the plain design. The others are complete designs. Every look comes in light and dark. */
export type Look = 'classic' | 'studio' | 'atelier' | 'signal' | 'glass' | 'funk' | 'dock';

const KEY = 'opendock.appearance';
const LOOK_KEY = 'opendock.look';
const THEME_COLOR = { light: '#ffffff', dark: '#09090b' } as const;

export function parseMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

// Looks that were retired move to the nearest design that replaced them.
const RETIRED: Record<string, Look> = { console: 'signal', bento: 'studio', desk: 'atelier' };

export function parseLook(value: unknown): Look {
  if (typeof value === 'string' && value in RETIRED) return RETIRED[value];
  return value === 'studio' || value === 'atelier' || value === 'signal' || value === 'glass' || value === 'funk' || value === 'dock' ? value : 'classic';
}

const systemIsLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;
export const resolveTheme = (mode: ThemeMode): Theme => (mode === 'system' ? (systemIsLight() ? 'light' : 'dark') : mode);

function readMode(): ThemeMode {
  try { return parseMode(localStorage.getItem(KEY)); } catch { return 'system'; }
}
function readLook(): Look {
  try { return parseLook(localStorage.getItem(LOOK_KEY)); } catch { return 'classic'; }
}

// Motion is this app's own switch (on unless turned off); the PC's reduce-motion setting is not consulted.
const MOTION_KEY = 'opendock.motion';
function readMotion(): boolean {
  try { return localStorage.getItem(MOTION_KEY) !== 'off'; } catch { return true; }
}

let mode: ThemeMode = readMode();
let look: Look = readLook();
let motion = readMotion();
const listeners = new Set<() => void>();

// Every look follows the light/dark choice.
const themeNow = (): Theme => resolveTheme(mode);
const nativeMode = (): ThemeMode => mode;

function apply() {
  const theme = themeNow();
  document.documentElement.dataset.theme = theme;
  if (look === 'classic') delete document.documentElement.dataset.look;
  else document.documentElement.dataset.look = look;
  if (motion) delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = 'off';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  listeners.forEach((listener) => listener());
}

const syncTitleBar = () => void invoke('set_appearance', { mode: nativeMode() }).catch(() => { /* the title bar keeps its look until next time */ });

export function setThemeMode(next: ThemeMode) {
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* the choice lasts until the app closes */ }
  apply();
  syncTitleBar();
}

export function setLook(next: Look) {
  look = next;
  try { localStorage.setItem(LOOK_KEY, next); } catch { /* the choice lasts until the app closes */ }
  apply();
  syncTitleBar();
}

export function setMotion(next: boolean) {
  motion = next;
  try { localStorage.setItem(MOTION_KEY, next ? 'on' : 'off'); } catch { /* the choice lasts until the app closes */ }
  apply();
}

// Follow the PC while the choice is System.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (mode === 'system') apply(); });
apply();
// The app keeps the same choice for the native window.
syncTitleBar();

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** For code outside React (the widget engines): the look in use now, and a call when it changes. */
export const currentTheme = (): Theme => themeNow();
export const onThemeChange = subscribe;
export const useThemeMode = (): ThemeMode => useSyncExternalStore(subscribe, () => mode);
export const useLook = (): Look => useSyncExternalStore(subscribe, () => look);
export const useMotion = (): boolean => useSyncExternalStore(subscribe, () => motion);
export const motionOn = (): boolean => motion;
/** The look in use right now: light or dark, never system. */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, themeNow);

const CHOICES: [ThemeMode, string][] = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']];
const LOOKS: [Look, string, string][] = [
  ['classic', 'Classic', 'Plain keys in light or dark.'],
  ['studio', 'Studio', 'A precise tool: an icon rail, hairlines, one violet accent and quick, quiet motion.'],
  ['atelier', 'Atelier', 'Editorial and warm: navigation across the top, serif headings, wide margins and slow fades.'],
  ['signal', 'Signal', 'Monochrome like a device: a floating dock, monospace capitals, a dot grid and one red dot.'],
  ['glass', 'Glass', 'Frosted glass over an aurora.'],
  ['funk', 'Funk', 'Neon keys with thick outlines and a hard shadow.'],
  ['dock', 'Dock', 'Bare icons with no key boxes, on a deep gradient, like a phone dock.'],
];

export function AppearanceSetting() {
  const current = useThemeMode();
  const currentLook = useLook();
  const moving = useMotion();
  return <>
    <section className="device-navigation-setting">
      <div className="device-navigation-copy"><h2>Motion</h2><p>Page transitions, fades and previews that move. Turn off for a still, quieter app.</p></div>
      <button className={`setting-switch ${moving ? 'enabled' : ''}`} type="button" role="switch" aria-checked={moving} aria-label="Motion" onClick={() => setMotion(!moving)}><span /></button>
    </section>
    <section className="device-navigation-setting appearance-setting">
      <div className="device-navigation-copy"><h2>Look</h2><p>{LOOKS.find(([value]) => value === currentLook)?.[2]} Your phone has its own setting on its Connect tab.</p></div>
      <div className="transport-tabs" role="radiogroup" aria-label="Look">
        {LOOKS.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={currentLook === value} className={currentLook === value ? 'transport-tab selected' : 'transport-tab'} onClick={() => setLook(value)}>{label}</button>)}
      </div>
    </section>
    <section className="device-navigation-setting appearance-setting">
      <div className="device-navigation-copy"><h2>Appearance</h2><p>Light, dark, or match this PC.</p></div>
      <div className="transport-tabs" role="radiogroup" aria-label="Appearance">
        {CHOICES.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={current === value} className={current === value ? 'transport-tab selected' : 'transport-tab'} onClick={() => setThemeMode(value)}>{label}</button>)}
      </div>
    </section>
  </>;
}

/** The look of a button icon the PC saved as SVG: it was saved in the dark deck's light ink, so it takes the theme's ink. */
export function inkIcon(svg: string, theme: Theme): string {
  return theme === 'light' ? svg.replace(/stroke="#f4f4f5"/gi, 'stroke="#18181b"') : svg;
}
