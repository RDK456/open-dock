import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { TabBarHiddenContext } from '../../navigation/tab-bar-context';
import { useUpdateBadge } from '../../app-updates';
import { useTheme } from '../../theme';

const AUTO_HIDE_MS = 4000;

export default function TabLayout() {
  // `forced` is immersive mode; `resting` is the bar tucked away after a few idle seconds.
  const [forced, setForced] = useState(false);
  const [resting, setResting] = useState(false);
  const [shownAt, setShownAt] = useState(0);
  const updateWaiting = useUpdateBadge();
  const { colors } = useTheme();
  const { bottom } = useSafeAreaInsets();

  useEffect(() => {
    if (resting || forced) return;
    const timer = setTimeout(() => setResting(true), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [resting, forced, shownAt]);
  const reveal = useCallback(() => { setResting(false); setShownAt(Date.now()); }, []);

  return (
    <TabBarHiddenContext.Provider value={setForced}>
      <View style={styles.fill}>
        <NativeTabs
          hidden={forced || resting}
          sidebarAdaptable
        >
          <NativeTabs.Trigger name="index">
            <NativeTabs.Trigger.Icon sf="square.grid.2x2" md="grid_view" />
            <NativeTabs.Trigger.Label>Deck</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="touch">
            <NativeTabs.Trigger.Icon sf="hand.point.up.left" md="touch_app" />
            <NativeTabs.Trigger.Label>Touch</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="voice">
            <NativeTabs.Trigger.Icon sf="mic" md="mic" />
            <NativeTabs.Trigger.Label>Voice</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="connect">
            <NativeTabs.Trigger.Icon sf="wifi" md="wifi" />
            <NativeTabs.Trigger.Label>Connect</NativeTabs.Trigger.Label>
            {/* No text: expo-router ignores `hidden` on a badge that has text. Empty shows a dot. */}
            <NativeTabs.Trigger.Badge hidden={!updateWaiting} />
          </NativeTabs.Trigger>
        </NativeTabs>
        {/* Tucked away, the bar leaves a small handle; tap it or swipe up on it to bring the bar back. */}
        {resting && !forced ? <Pressable style={[styles.handleHit, { bottom: bottom + 12 }]} onPress={reveal} onTouchMove={reveal} hitSlop={12} accessibilityRole="button" accessibilityLabel="Show tabs">
          <View style={[styles.handle, { backgroundColor: colors.muted }]} />
        </Pressable> : null}
      </View>
    </TabBarHiddenContext.Provider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  handleHit: { position: 'absolute', alignSelf: 'center', width: 120, height: 22, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 46, height: 5, borderRadius: 3, opacity: 0.55 },
});
