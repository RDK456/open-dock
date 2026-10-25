import { useEffect, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, Image, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { File, Paths } from 'expo-file-system';
import Svg, { Circle, Defs, LinearGradient, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';
import Storage from 'expo-sqlite/kv-store';
import { usePrefs } from './prefs';
import { useTheme } from './theme';
import { backdrops, wallpaperGlows } from './theme-colors';

// Soft light behind the Deck and Touch screens, under glass panels. Kept on this phone only, like the theme.
export type WallpaperId = 'none' | 'aurora' | 'ember' | 'ocean' | 'forest';
// image: a picture of your own (file uri) shown under the gradient; imageOpacity and gradient are 0–1.
export type WallpaperSettings = { wallpaper: WallpaperId; motion: boolean; image: string | null; imageOpacity: number; gradient: number; keyOpacity: number };

/** A #rrggbb color at the given opacity; anything else (rgba, transparent) is returned as it is. */
export const fade = (color: string, opacity: number) => opacity >= 1 || !/^#[0-9a-f]{6}$/i.test(color) ? color : `${color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;

export const WALLPAPERS: [WallpaperId, string][] = [['none', 'None'], ['aurora', 'Aurora'], ['ember', 'Ember'], ['ocean', 'Ocean'], ['forest', 'Forest']];

const KEY = 'opendock.wallpaper';
const DEFAULTS: WallpaperSettings = { wallpaper: 'aurora', motion: true, image: null, imageOpacity: 1, gradient: 0.5, keyOpacity: 0.55 };
const unit = (value: unknown, fallback: number) => typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback;

/** Lets the user pick a picture and keeps a copy in the app's own storage, so it outlives the picker's cache. */
export async function pickWallpaperImage() {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
  if (result.canceled) return;
  try {
    const copy = new File(Paths.document, `wallpaper-${Date.now()}.jpg`);
    new File(result.assets[0].uri).copy(copy);
    clearWallpaperImage();
    setWallpaperSettings({ image: copy.uri });
  } catch { setWallpaperSettings({ image: result.assets[0].uri }); }
}

export function clearWallpaperImage() {
  const old = settings.image;
  setWallpaperSettings({ image: null });
  try { if (old && old.startsWith(Paths.document.uri)) new File(old).delete(); } catch { /* already gone */ }
}

function read(): WallpaperSettings {
  try {
    const saved = JSON.parse(Storage.getItemSync(KEY) ?? '{}') as Partial<WallpaperSettings>;
    return {
      wallpaper: WALLPAPERS.some(([id]) => id === saved.wallpaper) ? saved.wallpaper as WallpaperId : DEFAULTS.wallpaper,
      motion: typeof saved.motion === 'boolean' ? saved.motion : DEFAULTS.motion,
      image: typeof saved.image === 'string' ? saved.image : null,
      imageOpacity: unit(saved.imageOpacity, DEFAULTS.imageOpacity),
      gradient: unit(saved.gradient, DEFAULTS.gradient),
      keyOpacity: unit(saved.keyOpacity, DEFAULTS.keyOpacity),
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

const useReduceMotion = () => !usePrefs().motion;

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

  if (look === 'dock' || (settings.image && look !== 'signal')) return <DockBackdrop />;
  if (look === 'signal') return <DotBackdrop key={size} onSize={setSize} dot={backdrops.signalDot[scheme]} />;
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

/** Immersive mode's backdrop: a deep gradient with a soft green light in one corner, so bare icons stand out. */
export function DockBackdrop() {
  const { scheme } = useTheme();
  const [size, setSize] = useState('');
  const { image, imageOpacity, gradient } = useWallpaperSettings();
  const [from, to, glow] = backdrops.dock[scheme];
  // With a picture, the gradient and glows become a veil over it; the level sets how strong.
  const veil = image ? gradient : 1;
  return <View pointerEvents="none" style={[styles.fill, { backgroundColor: from }]} onLayout={measure(setSize)}>
    {image ? <Image source={{ uri: image }} style={[styles.fill, { opacity: imageOpacity }]} resizeMode="cover" /> : null}
    <Svg key={size} width="100%" height="100%" style={{ opacity: veil }}>
      <Defs>
        <LinearGradient id="dockBase" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
        <RadialGradient id="dockGlow" cx="12%" cy="0%" r="70%">
          <Stop offset="0" stopColor={glow} stopOpacity={scheme === 'light' ? 0.4 : 0.5} />
          <Stop offset="1" stopColor={glow} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="dockGlow2" cx="95%" cy="100%" r="65%">
          <Stop offset="0" stopColor="#8b7cf6" stopOpacity={scheme === 'light' ? 0.28 : 0.4} />
          <Stop offset="1" stopColor="#8b7cf6" stopOpacity={0} />
        </RadialGradient>
        <Pattern id="dockGrid" width="28" height="28" patternUnits="userSpaceOnUse">
          <Circle cx="14" cy="14" r="0.9" fill={scheme === 'light' ? '#000000' : '#ffffff'} opacity={0.1} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#dockBase)" />
      <Rect width="100%" height="100%" fill="url(#dockGlow)" />
      <Rect width="100%" height="100%" fill="url(#dockGlow2)" />
      <Rect width="100%" height="100%" fill="url(#dockGrid)" />
    </Svg>
  </View>;
}

type BackdropProps ={ onSize: (size: string) => void };
const measure = (onSize: BackdropProps['onSize']) => ({ nativeEvent: { layout } }: LayoutChangeEvent) => onSize(`${layout.width}x${layout.height}`);

/** Signal: a fine dot grid, like the dots of a matrix display. */
function DotBackdrop({ onSize, dot }: BackdropProps & { dot: string }) {
  return <View pointerEvents="none" style={styles.fill} onLayout={measure(onSize)}>
    <Svg width="100%" height="100%">
      <Defs>
        <Pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <Circle cx="9" cy="9" r="1" fill={dot} opacity={0.13} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#dots)" />
    </Svg>
  </View>;
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
});
