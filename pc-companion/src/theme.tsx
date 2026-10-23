import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Light, dark, or whatever this PC is set to. The choice is kept here (for the page's colors, read again by the
// inline script in index.html before the first paint) and by the app (for the native title bar, see
// `set_appearance` in lib.rs). The colors themselves are the tokens in App.css, switched by <html data-theme>.
export type ThemeMode = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

const KEY = 'opendock.appearance';
const THEME_COLOR = { light: '#ffffff', dark: '#09090b' } as const;

export function parseMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

const systemIsLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;
export const resolveTheme = (mode: ThemeMode): Theme => (mode === 'system' ? (systemIsLight() ? 'light' : 'dark') : mode);

function readMode(): ThemeMode {
  try { return parseMode(localStorage.getItem(KEY)); } catch { return 'system'; }
}

let mode: ThemeMode = readMode();
const listeners = new Set<() => void>();

function apply() {
  const theme = resolveTheme(mode);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  listeners.forEach((listener) => listener());
}

export function setThemeMode(next: ThemeMode) {
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* the choice lasts until the app closes */ }
  apply();
  void invoke('set_appearance', { mode: next }).catch(() => { /* the title bar keeps its look until next time */ });
}

// Follow the PC while the choice is System.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (mode === 'system') apply(); });
apply();
// The app keeps the same choice for the native window.
void invoke('set_appearance', { mode }).catch(() => {});

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** For code outside React (the widget engines): the look in use now, and a call when it changes. */
export const currentTheme = (): Theme => resolveTheme(mode);
export const onThemeChange = subscribe;
export const useThemeMode = (): ThemeMode => useSyncExternalStore(subscribe, () => mode);
/** The look in use right now: light or dark, never system. */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, () => resolveTheme(mode));

const CHOICES: [ThemeMode, string][] = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']];

export function AppearanceSetting() {
  const current = useThemeMode();
  return <section className="device-navigation-setting appearance-setting">
    <div className="device-navigation-copy"><h2>Appearance</h2><p>Light, dark, or match this PC. Your phone has its own setting on its Connect tab.</p></div>
    <div className="transport-tabs" role="radiogroup" aria-label="Appearance">
      {CHOICES.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={current === value} className={current === value ? 'transport-tab selected' : 'transport-tab'} onClick={() => setThemeMode(value)}>{label}</button>)}
    </div>
  </section>;
}

/** The look of a button icon the PC saved as SVG: it was saved in the dark deck's light ink, so it takes the theme's ink. */
export function inkIcon(svg: string, theme: Theme): string {
  return theme === 'light' ? svg.replace(/stroke="#f4f4f5"/gi, 'stroke="#18181b"') : svg;
}
