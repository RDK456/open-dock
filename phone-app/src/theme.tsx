import { useMemo, useSyncExternalStore } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import { darkColors, keyLook, lightColors, LOOK_THEMES, parseLook, parseMode, type Colors, type KeyLook, type Look, type Scheme, type ThemeMode } from './theme-colors';

export { LOOKS, type Colors, type KeyLook, type Look, type Scheme, type ThemeMode } from './theme-colors';

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
// A designed look is light or dark by nature; Classic follows the light/dark choice.
const nativeScheme = () => (look === 'classic' ? (mode === 'system' ? 'unspecified' : mode) : LOOK_THEMES[look].scheme);
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

export const useThemeMode = (): ThemeMode => useSyncExternalStore(subscribe, () => mode);
export const useLook = (): Look => useSyncExternalStore(subscribe, () => look);

/** The look in use now: its colors, whether it is light or dark (never system), and how deck keys are drawn. */
export function useTheme(): { colors: Colors; scheme: Scheme; mode: ThemeMode; look: Look; key: KeyLook } {
  const chosen = useThemeMode();
  const current = useLook();
  const system = useColorScheme();
  return useMemo(() => {
    const designed = current === 'classic' ? null : LOOK_THEMES[current];
    const scheme: Scheme = designed?.scheme ?? (chosen === 'system' ? (system === 'light' ? 'light' : 'dark') : chosen);
    const colors = designed?.colors ?? (scheme === 'light' ? lightColors : darkColors);
    return { colors, scheme, mode: chosen, look: current, key: keyLook(current, colors) };
  }, [chosen, current, system]);
}

/** Styles built from the current colors: `const styles = useStyles(makeStyles)`, with `makeStyles = (colors) => StyleSheet.create({...})`. */
export function useStyles<T>(make: (colors: Colors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => make(colors), [make, colors]);
}
