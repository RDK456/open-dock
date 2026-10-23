import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import Storage from 'expo-sqlite/kv-store';
import { useTheme } from './theme';
import { wallpaperGlows } from './theme-colors';

// Soft light behind the Deck and Touch screens, under glass panels. Kept on this phone only, like the theme.
export type WallpaperId = 'none' | 'aurora' | 'ember' | 'ocean' | 'forest';
export type WallpaperSettings = { wallpaper: WallpaperId; motion: boolean };

export const WALLPAPERS: [WallpaperId, string][] = [['none', 'None'], ['aurora', 'Aurora'], ['ember', 'Ember'], ['ocean', 'Ocean'], ['forest', 'Forest']];

const KEY = 'opendock.wallpaper';
const DEFAULTS: WallpaperSettings = { wallpaper: 'aurora', motion: true };

function read(): WallpaperSettings {
  try {
    const saved = JSON.parse(Storage.getItemSync(KEY) ?? '{}') as Partial<WallpaperSettings>;
    return {
      wallpaper: WALLPAPERS.some(([id]) => id === saved.wallpaper) ? saved.wallpaper as WallpaperId : DEFAULTS.wallpaper,
      motion: typeof saved.motion === 'boolean' ? saved.motion : DEFAULTS.motion,
    };
  } catch {
    return DEFAULTS;
  }
}

let settings = read();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setWallpaperSettings(next: Partial<WallpaperSettings>) {
  settings = { ...settings, ...next };
  try { Storage.setItemSync(KEY, JSON.stringify(settings)); } catch { /* lasts until the app closes */ }
  listeners.forEach((listener) => listener());
}

export const useWallpaperSettings = () => useSyncExternalStore(subscribe, () => settings);

function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => subscription.remove();
  }, []);
  return reduce;
}

/** Fills its parent, behind everything else. Drifts slowly unless motion is off here or on the phone. */
export function Wallpaper() {
  const { scheme } = useTheme();
  const { wallpaper, motion } = useWallpaperSettings();
  const reduceMotion = useReduceMotion();
  const [drift] = useState(() => new Animated.Value(0));
  const moving = motion && !reduceMotion && wallpaper !== 'none';

  useEffect(() => {
    if (!moving) {
      drift.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(drift, { toValue: 1, duration: 14_000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(drift, { toValue: 0, duration: 14_000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [drift, moving]);

  if (wallpaper === 'none') return null;
  const glows = wallpaperGlows[wallpaper];
  const strength = scheme === 'light' ? 0.32 : 0.5;
  const shift = (amount: number) => drift.interpolate({ inputRange: [0, 1], outputRange: [-amount, amount] });

  return (
    <View pointerEvents="none" style={styles.fill}>
      {glows.map(([color, x, y], index) => (
        <Animated.View key={index} style={[styles.fill, { transform: [{ translateX: shift(index % 2 ? 36 : -28) }, { translateY: shift(index === 1 ? -30 : 24) }, { scale: 1.2 }] }]}>
          <Svg width="100%" height="100%">
            <Defs>
              <RadialGradient id={`glow${index}`} cx={`${x * 100}%`} cy={`${y * 100}%`} r="55%">
                <Stop offset="0" stopColor={color} stopOpacity={strength} />
                <Stop offset="1" stopColor={color} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Rect width="100%" height="100%" fill={`url(#glow${index})`} />
          </Svg>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
});
