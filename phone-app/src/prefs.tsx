import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';
import { useIsFocused } from 'expo-router';
import * as Haptics from 'expo-haptics';
import Storage from 'expo-sqlite/kv-store';

// Two switches kept on this phone only: a buzz on key presses, and motion. The app does not follow the phone's
// reduce-motion setting; this switch is the one place motion is turned off. Read synchronously so the first frame is right.
export type Prefs = { haptics: boolean; motion: boolean };
const KEY = 'opendock.prefs';
const DEFAULTS: Prefs = { haptics: true, motion: true };

function read(): Prefs {
  try {
    const saved = JSON.parse(Storage.getItemSync(KEY) ?? '{}') as Partial<Prefs>;
    return { haptics: saved.haptics !== false, motion: saved.motion !== false };
  } catch {
    return DEFAULTS;
  }
}

let prefs = read();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  try { Storage.setItemSync(KEY, JSON.stringify(prefs)); } catch { /* lasts until the app closes */ }
  listeners.forEach((listener) => listener());
}

export const usePrefs = () => useSyncExternalStore(subscribe, () => prefs);
export const motionOn = () => prefs.motion;

/** Haptic feedback, skipped when the switch is off. */
export const haptic = {
  select: () => { if (prefs.haptics) void Haptics.selectionAsync(); },
  impact: (style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) => { if (prefs.haptics) void Haptics.impactAsync(style); },
  notify: (ok: boolean) => { if (prefs.haptics) void Haptics.notificationAsync(ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error); },
};

/** Fades and rises into place each time its screen comes into view; `index` staggers a column of them. */
export function Entrance({ index = 0, style, children }: { index?: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const { motion } = usePrefs();
  const focused = useIsFocused();
  const [shown] = useState(() => new Animated.Value(prefs.motion ? 0 : 1));
  useEffect(() => {
    if (!focused || !motion) { shown.setValue(1); return; }
    shown.setValue(0);
    const animation = Animated.timing(shown, { toValue: 1, delay: Math.min(index, 8) * 45, duration: 340, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [focused, motion, index, shown]);
  return <Animated.View style={[style, { opacity: shown, transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }]}>{children}</Animated.View>;
}
