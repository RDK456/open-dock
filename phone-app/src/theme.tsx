import { useMemo, useSyncExternalStore } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import { darkColors, lightColors, parseMode, type Colors, type Scheme, type ThemeMode } from './theme-colors';

export { type Colors, type Scheme, type ThemeMode } from './theme-colors';

// Light, dark, or the phone's own setting. The choice is kept on this phone only. It is read synchronously when the
// app starts, so the first frame already has the right look, and it is handed to React Native, so the parts the
// system draws (status bar, keyboard, native tabs, dialogs) follow it too.
const KEY = 'opendock.appearance';

function readMode(): ThemeMode {
  try { return parseMode(Storage.getItemSync(KEY)); } catch { return 'system'; }
}

let mode: ThemeMode = readMode();
Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setThemeMode(next: ThemeMode) {
  mode = next;
  try { Storage.setItemSync(KEY, next); } catch { /* the choice lasts until the app closes */ }
  Appearance.setColorScheme(next === 'system' ? 'unspecified' : next);
  listeners.forEach((listener) => listener());
}

export const useThemeMode = (): ThemeMode => useSyncExternalStore(subscribe, () => mode);

/** The look in use now: its colors, and whether it is light or dark (never system). */
export function useTheme(): { colors: Colors; scheme: Scheme; mode: ThemeMode } {
  const chosen = useThemeMode();
  const system = useColorScheme();
  const scheme: Scheme = chosen === 'system' ? (system === 'light' ? 'light' : 'dark') : chosen;
  return { colors: scheme === 'light' ? lightColors : darkColors, scheme, mode: chosen };
}

/** Styles built from the current colors: `const styles = useStyles(makeStyles)`, with `makeStyles = (colors) => StyleSheet.create({...})`. */
export function useStyles<T>(make: (colors: Colors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => make(colors), [make, colors]);
}
