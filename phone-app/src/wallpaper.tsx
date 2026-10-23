import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, LinearGradient, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';
import Storage from 'expo-sqlite/kv-store';
import { useTheme } from './theme';
import { backdrops, wallpaperGlows } from './theme-colors';

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
  const { scheme, look } = useTheme();
  const settings = useWallpaperSettings();
  // The designed looks bring their own backdrop; Glass is the aurora, always drifting and a little brighter.
  const wallpaper: WallpaperId = look === 'glass' ? 'aurora' : look === 'classic' ? settings.wallpaper : 'none';
  const motion = look === 'glass' || settings.motion;
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
  // react-native-svg keeps the size its "100%" first resolved to; remount the drawings when the screen
  // changes size (the tab bar hiding, rotation) so the light reaches the bottom edge.
  const [size, setSize] = useState('');

  if (look === 'console') return <MetalBackdrop key={size} onSize={setSize} />;
  if (look === 'desk') return <DeskBackdrop key={size} onSize={setSize} />;
  if (wallpaper === 'none') return null;
  const glows = wallpaperGlows[wallpaper];
  const strength = look === 'glass' ? 0.75 : scheme === 'light' ? 0.32 : 0.5;
  const shift = (amount: number) => drift.interpolate({ inputRange: [0, 1], outputRange: [-amount, amount] });

  return (
    <View pointerEvents="none" style={styles.fill} onLayout={({ nativeEvent: { layout } }) => setSize(`${layout.width}x${layout.height}`)}>
      {glows.map(([color, x, y], index) => (
        <Animated.View key={index} style={[styles.fill, { transform: [{ translateX: shift(index % 2 ? 36 : -28) }, { translateY: shift(index === 1 ? -30 : 24) }, { scale: 1.2 }] }]}>
          <Svg key={size} width="100%" height="100%">
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

type BackdropProps = { onSize: (size: string) => void };
const measure = (onSize: BackdropProps['onSize']) => ({ nativeEvent: { layout } }: LayoutChangeEvent) => onSize(`${layout.width}x${layout.height}`);

/** Console: anodised metal, lighter at the top, with fine brushed lines. */
function MetalBackdrop({ onSize }: BackdropProps) {
  return <View pointerEvents="none" style={styles.fill} onLayout={measure(onSize)}>
    <Svg width="100%" height="100%">
      <Defs>
        <LinearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={backdrops.metal.top} />
          <Stop offset="1" stopColor={backdrops.metal.bottom} />
        </LinearGradient>
        <Pattern id="brushed" width="4" height="3" patternUnits="userSpaceOnUse">
          <Rect width="4" height="1" fill={backdrops.metal.line} opacity={0.025} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#metal)" />
      <Rect width="100%" height="100%" fill="url(#brushed)" />
    </Svg>
  </View>;
}

/** Desk: the app icon's red-and-cream striped desk along the bottom, edged in ink. */
function DeskBackdrop({ onSize }: BackdropProps) {
  return <View pointerEvents="none" style={styles.fill} onLayout={measure(onSize)}>
    <Svg width="100%" height="100%">
      <Defs>
        <Pattern id="stripes" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <Rect width="26" height="26" fill={backdrops.desk.cream} />
          <Rect width="13" height="26" fill={backdrops.desk.red} />
        </Pattern>
      </Defs>
      <Rect y="84%" width="100%" height="16%" fill="url(#stripes)" />
      <Rect y="84%" width="100%" height="4" fill={backdrops.desk.ink} />
    </Svg>
  </View>;
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
});
