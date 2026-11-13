import { useMemo, useSyncExternalStore } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import { darkColors, headingLook, keyLook, lightColors, LOOK_THEMES, parseLook, parseMode, surfaceLook, type Colors, type HeadingLook, type KeyLook, type Look, type Scheme, type SurfaceLook, type ThemeMode } from './theme-colors';

export { LOOKS, type Colors, type HeadingLook, type KeyLook, type Look, type Scheme, type SurfaceLook, type ThemeMode } from './theme-colors';

// Light, dark, or the phone's own setting, and the deck's look. Both are kept on this phone only. They are read
// synchronously when the app starts, so the first frame already has the right look, and the light/dark result is
// handed to React Native, so the parts the system draws (status bar, keyboard, native tabs, dialogs) follow it too.
const KEY = 'opendock.appearance';
const LOOK_KEY = 'opendock.look';

function readMode(): ThemeMode {
  try { return parseMode(Storage.getItemSync(KEY)); } catch { return 'system'; }
}
function readLook(): Look {
  try { return parseLook(Storage.getItemSync(LOOK_KEY)); } catch { return 'classic'; }
}

let mode: ThemeMode = readMode();
let look: Look = readLook();
// Every look follows the light/dark choice.
const nativeScheme = () => (mode === 'system' ? 'unspecified' : mode);
Appearance.setColorScheme(nativeScheme());
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setThemeMode(next: ThemeMode) {
  mode = next;
  try { Storage.setItemSync(KEY, next); } catch { /* the choice lasts until the app closes */ }
  Appearance.setColorScheme(nativeScheme());
  listeners.forEach((listener) => listener());
}

export function setLook(next: Look) {
  look = next;
  try { Storage.setItemSync(LOOK_KEY, next); } catch { /* the choice lasts until the app closes */ }
  Appearance.setColorScheme(nativeScheme());
  listeners.forEach((listener) => listener());
}

// Two tweaks on top of any look: an accent colour ('' keeps the look's own) and how round its corners are.
export type Corners = 'sharp' | 'default' | 'round';
export const CORNERS: [Corners, string][] = [['sharp', 'Sharp'], ['default', 'Default'], ['round', 'Round']];
export const ACCENTS: [string, string][] = [['', 'Look'], ['#7c84f5', 'Violet'], ['#38bdf8', 'Sky'], ['#34d399', 'Mint'], ['#fb923c', 'Orange'], ['#f472b6', 'Pink']];
const SCALE: Record<Corners, number> = { sharp: 0.4, default: 1, round: 1.5 };
const ACCENT_KEY = 'opendock.accent';
const CORNERS_KEY = 'opendock.corners';
let accent = '';
let corners: Corners = 'default';
try {
  const a = Storage.getItemSync(ACCENT_KEY);
  accent = ACCENTS.some(([hex]) => hex === a) ? a ?? '' : '';
  const c = Storage.getItemSync(CORNERS_KEY);
  corners = c === 'sharp' || c === 'round' ? c : 'default';
} catch { /* defaults */ }

export function setAccent(next: string) {
  accent = next;
  try { Storage.setItemSync(ACCENT_KEY, next); } catch { /* lasts until the app closes */ }
  listeners.forEach((listener) => listener());
}
export function setCorners(next: Corners) {
  corners = next;
  try { Storage.setItemSync(CORNERS_KEY, next); } catch { /* lasts until the app closes */ }
  listeners.forEach((listener) => listener());
}
// Set while "Match PC wallpaper" is on: the wallpaper's colour, over the accent chosen here.
let pcAccent = '';
export function setPcAccent(next: string) {
  if (next === pcAccent) return;
  pcAccent = next;
  listeners.forEach((listener) => listener());
}
export const useAccent = (): string => useSyncExternalStore(subscribe, () => pcAccent || accent);
const usePcAccent = (): string => useSyncExternalStore(subscribe, () => pcAccent);
/** `a` moved `amount` (0–1) of the way to `b`; both #rrggbb, anything else is returned as it is. */
const mix = (a: string, b: string, amount: number) => {
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
  const [x, y] = [parseInt(a.slice(1), 16), parseInt(b.slice(1), 16)];
  return `#${[16, 8, 0].map((shift) => Math.round(((x >> shift) & 255) * (1 - amount) + ((y >> shift) & 255) * amount).toString(16).padStart(2, '0')).join('')}`;
};
export const useCorners = (): Corners => useSyncExternalStore(subscribe, () => corners);

/** Dark ink on a light accent, light ink on a dark one. */
const inkOn = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? '#09090b' : '#fafafa';
};
const round = (radius: number, k: number) => (radius >= 100 ? radius : Math.round(radius * k));

export const useThemeMode = (): ThemeMode => useSyncExternalStore(subscribe, () => mode);
export const useLook = (): Look => useSyncExternalStore(subscribe, () => look);

/** The look in use now: its colors, whether it is light or dark (never system), how deck keys, titles, cards and the media rail are drawn. */
export function useTheme(): { colors: Colors; scheme: Scheme; mode: ThemeMode; look: Look; key: KeyLook; heading: HeadingLook; surface: SurfaceLook } {
  const chosen = useThemeMode();
  const current = useLook();
  const system = useColorScheme();
  const tint = useAccent();
  const fromPc = usePcAccent();
  const shape = useCorners();
  return useMemo(() => {
    const scheme: Scheme = chosen === 'system' ? (system === 'light' ? 'light' : 'dark') : chosen;
    const base = current === 'classic' ? (scheme === 'light' ? lightColors : darkColors) : LOOK_THEMES[current][scheme];
    const tinted = tint ? { ...base, accent: tint, onAccent: inkOn(tint), borderFocus: tint } : base;
    // Matching the PC's wallpaper washes the surfaces with its colour too, lightly so text keeps its contrast.
    const colors = fromPc ? { ...tinted, bg: mix(tinted.bg, fromPc, 0.1), panel: mix(tinted.panel, fromPc, 0.08), panelRaised: mix(tinted.panelRaised, fromPc, 0.08) } : tinted;
    const k = SCALE[shape];
    const key0 = keyLook(current, colors, scheme);
    const surf = surfaceLook(current);
    const key = k === 1 ? key0 : { ...key0, radius: round(key0.radius, k) };
    const surface = k === 1 ? surf : { ...surf, radius: round(surf.radius, k), chipRadius: round(surf.chipRadius, k), railRadius: round(surf.railRadius, k), puck: Math.min(0.5, surf.puck * k) };
    return { colors, scheme, mode: chosen, look: current, key, heading: headingLook(current), surface };
  }, [chosen, current, system, tint, fromPc, shape]);
}

/** Styles built from the current colors: `const styles = useStyles(makeStyles)`, with `makeStyles = (colors) => StyleSheet.create({...})`. */
export function useStyles<T>(make: (colors: Colors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => make(colors), [make, colors]);
}
