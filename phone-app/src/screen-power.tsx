import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import * as Brightness from 'expo-brightness';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { LOOKS, setLook, setThemeMode, useLook, useStyles, useThemeMode, type Colors, type Look, type ThemeMode } from './theme';
import { setWallpaperSettings, useWallpaperSettings, WALLPAPERS } from './wallpaper';

const LOOK_HINTS: Record<Look, string> = {
  classic: 'Plain keys in light or dark, with a wallpaper of your choice.',
  console: 'Dark metal with amber-lit keys and green LCD labels.',
  bento: 'Bright color blocks with big, bold labels.',
  desk: 'The Open Dock desk: yellow, blue and red, drawn with thick outlines.',
  glass: 'Frosted glass over a moving aurora that lights up where you touch.',
  funk: 'Neon keys with thick outlines and a hard shadow, on deep purple.',
};

// The screen is a deck's biggest power draw. These settings decide whether the deck keeps it on and
// whether it dims when nobody is touching it. (Expo Go keeps the screen on while developing anyway.)
export type ScreenSettings = { keepAwake: boolean; dimAfterMin: 0 | 1 | 2 | 5 };
const KEY = 'opendock.screen';
const DEFAULTS: ScreenSettings = { keepAwake: false, dimAfterMin: 0 };
const DIM_LEVEL = 0.05;

let settings = DEFAULTS;
const listeners = new Set<() => void>();
void Storage.getItem(KEY).then((saved) => {
  try {
    const value = saved ? JSON.parse(saved) as Partial<ScreenSettings> : {};
    settings = {
      keepAwake: value.keepAwake === true,
      dimAfterMin: ([0, 1, 2, 5] as const).find((minutes) => minutes === value.dimAfterMin) ?? 0,
    };
    listeners.forEach((listener) => listener());
  } catch { /* defaults */ }
});
export function setScreenSettings(patch: Partial<ScreenSettings>) {
  settings = { ...settings, ...patch };
  listeners.forEach((listener) => listener());
  void Storage.setItem(KEY, JSON.stringify(settings));
}
export function useScreenSettings(): ScreenSettings {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => settings);
}

/**
 * Applies the screen settings while the deck is open. Spread `touchProps` on the deck's root view
 * and render `overlay` last inside it: once dimmed, the first tap only brightens the screen again.
 */
export function useDeckScreenPower() {
  const { keepAwake, dimAfterMin } = useScreenSettings();
  const [dimmed, setDimmed] = useState(false);
  const saved = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!keepAwake) return;
    void activateKeepAwakeAsync('open-dock-deck');
    return () => { void deactivateKeepAwake('open-dock-deck'); };
  }, [keepAwake]);

  const restore = () => {
    if (saved.current !== null) void Brightness.setBrightnessAsync(saved.current).catch(() => {});
    saved.current = null;
    setDimmed(false);
  };
  const dim = async () => {
    try {
      saved.current = await Brightness.getBrightnessAsync();
      await Brightness.setBrightnessAsync(Math.min(saved.current, DIM_LEVEL));
      setDimmed(true);
    } catch { saved.current = null; }
  };
  // Every touch restarts the idle countdown.
  const poke = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = dimAfterMin ? setTimeout(() => void dim(), dimAfterMin * 60_000) : null;
  };
  useEffect(() => {
    poke();
    // Leaving the deck or the app gives the screen its brightness back; iOS would otherwise keep it.
    const subscription = AppState.addEventListener('change', (state) => { if (state !== 'active') restore(); else poke(); });
    return () => {
      subscription.remove();
      if (timer.current) clearTimeout(timer.current);
      restore();
    };
    // poke/restore read refs and the current setting; re-run only when the setting changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimAfterMin]);

  const overlay = dimmed
    ? <Pressable style={StyleSheet.absoluteFill} onPress={() => { restore(); poke(); }} accessibilityRole="button" accessibilityLabel="Screen dimmed. Tap to brighten" />
    : null;
  return { touchProps: { onTouchStart: poke }, overlay };
}

function Choice<T extends string | number | boolean>({ options, value, onChange }: { options: [T, string][]; value: T; onChange: (value: T) => void }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.segments}>
    {options.map(([option, label]) => <Pressable key={String(option)} style={[styles.segment, option === value && styles.segmentActive]} onPress={() => onChange(option)} accessibilityRole="button" accessibilityState={{ selected: option === value }}>
      <Text style={[styles.segmentText, option === value && styles.segmentTextActive]}>{label}</Text>
    </Pressable>)}
  </View>;
}

/** The Appearance section of the settings tab: light, dark, or this phone's own setting. */
export function AppearanceSection() {
  const styles = useStyles(makeStyles);
  const mode = useThemeMode();
  const look = useLook();
  const { wallpaper, motion } = useWallpaperSettings();
  const options: [ThemeMode, string][] = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']];
  return <View style={styles.card}>
    <Text style={styles.title}>Appearance</Text>
    <Text style={styles.label}>Look</Text>
    <Choice options={LOOKS} value={look} onChange={setLook} />
    <Text style={styles.hint}>{LOOK_HINTS[look]}</Text>
    {look === 'classic' ? <>
    <Text style={styles.label}>Light or dark</Text>
    <Choice options={options} value={mode} onChange={setThemeMode} />
    <Text style={styles.hint}>{"System follows this phone's setting. Your PC has its own."}</Text>
    <Text style={styles.label}>Wallpaper</Text>
    <Choice options={WALLPAPERS} value={wallpaper} onChange={(value) => setWallpaperSettings({ wallpaper: value })} />
    <Text style={styles.label}>Wallpaper motion</Text>
    <Choice options={[[false, 'Still'], [true, 'Drift']]} value={motion} onChange={(value) => setWallpaperSettings({ motion: value })} />
    <Text style={styles.hint}>Shows behind the Deck and Touch screens. Drift pauses when the phone asks for reduced motion.</Text>
    </> : null}
  </View>;
}

/** The Screen section of the settings tab. */
export function ScreenSettingsSection() {
  const styles = useStyles(makeStyles);
  const { keepAwake, dimAfterMin } = useScreenSettings();
  return <View style={styles.card}>
    <Text style={styles.title}>Screen</Text>
    <Text style={styles.label}>Keep screen on while the deck is open</Text>
    <Choice options={[[false, 'Off'], [true, 'On']]} value={keepAwake} onChange={(value) => setScreenSettings({ keepAwake: value })} />
    <Text style={styles.label}>Dim when idle</Text>
    <Choice options={[[0, 'Off'], [1, '1 min'], [2, '2 min'], [5, '5 min']]} value={dimAfterMin} onChange={(value) => setScreenSettings({ dimAfterMin: value })} />
    <Text style={styles.hint}>{"The screen uses the most battery on a deck. Dimming brings it back on your first tap, which won't press a button."}</Text>
  </View>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { marginTop: 14, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.panel },
  title: { color: colors.text, fontSize: 13, fontWeight: '500' },
  label: { color: colors.muted, fontSize: 12, marginTop: 11 },
  segments: { flexDirection: 'row', marginTop: 6, padding: 3, gap: 3, borderRadius: 5, backgroundColor: colors.bg },
  segment: { flex: 1, height: 31, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  segmentActive: { backgroundColor: colors.pressed },
  segmentText: { color: colors.muted, fontSize: 13 },
  segmentTextActive: { color: colors.text, fontWeight: '500' },
  hint: { color: colors.faint, fontSize: 12, marginTop: 9, lineHeight: 15 },
});
