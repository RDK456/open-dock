import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import { haptic, motionOn } from './prefs';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react-native';
import type { DeckButton, DeckMediaCommand } from './connection';
import { useStyles, useTheme, type Colors } from './theme';

const MAX_PINS = 4;

/** Button ids pinned to the rail for one profile, kept on this phone. */
export function usePins(profileId: string | undefined) {
  const [pins, setPins] = useState<string[]>([]);
  useEffect(() => {
    if (!profileId) return;
    let alive = true;
    void Storage.getItem(`opendock.pins.${profileId}`).then((saved) => {
      if (!alive) return;
      try {
        const parsed: unknown = saved ? JSON.parse(saved) : [];
        setPins(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, MAX_PINS) : []);
      } catch {
        setPins([]);
      }
    });
    return () => { alive = false; };
  }, [profileId]);
  const toggle = useCallback((id: string) => {
    if (!profileId) return;
    setPins((current) => {
      const next = current.includes(id) ? current.filter((pin) => pin !== id) : [...current, id].slice(-MAX_PINS);
      void Storage.setItem(`opendock.pins.${profileId}`, JSON.stringify(next));
      return next;
    });
  }, [profileId]);
  return [pins, toggle] as const;
}

function Puck({ size, accent, morph, onPress, label, disabled, children }: { size: number; accent?: boolean; morph?: boolean; onPress: () => void; label: string; disabled?: boolean; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  const { surface } = useTheme();
  const [scale] = useState(() => new Animated.Value(1));
  // The play puck morphs from a circle into a soft square while music plays (JS-driven: radius can't run natively).
  const [shape] = useState(() => new Animated.Value(morph ? 1 : 0));
  useEffect(() => {
    Animated.spring(shape, { toValue: morph ? 1 : 0, useNativeDriver: false, speed: 12, bounciness: 9 }).start();
  }, [morph, shape]);
  const to = (toValue: number) => (motionOn() ? Animated.spring(scale, { toValue, useNativeDriver: true, speed: 40, bounciness: 9 }).start() : scale.setValue(toValue));
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Animated.View style={[styles.puck, accent && styles.accent, disabled && styles.off, { width: size, height: size, borderWidth: surface.border, borderBottomWidth: surface.base ? surface.border + 2 : surface.border, borderRadius: shape.interpolate({ inputRange: [0, 1], outputRange: [size * surface.puck, size * Math.min(surface.puck, 0.3)] }) }]}>
        <Pressable style={styles.hit} onPress={() => { haptic.impact(); onPress(); }} onPressIn={() => to(0.88)} onPressOut={() => to(1)} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}>
          {children}
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

/**
 * The layer that never moves: round pucks around a big play button, plus up to four keys pinned from any page.
 * Pinned keys sit on the outside, two each side; media sits in the middle under the thumb.
 */
export function PuckRail({ pinned, playing, connected, renderIcon, onPress, sendMedia, vertical }: {
  pinned: DeckButton[];
  playing: boolean;
  connected: boolean;
  renderIcon: (button: DeckButton, size: number) => ReactNode;
  onPress: (button: DeckButton) => void;
  sendMedia: (command: DeckMediaCommand) => void;
  vertical?: boolean;
}) {
  const { colors, surface } = useTheme();
  const styles = useStyles(makeStyles);
  const left = pinned.slice(0, 2);
  const right = pinned.slice(2, 4);
  // Upright beside the card in landscape, pucks shrink and pins wrap into a second column.
  const small = vertical ? 38 : 50;
  const pin = (button: DeckButton) => <Puck key={button.id} size={small} onPress={() => onPress(button)} label={button.label} disabled={!connected}>{renderIcon(button, 20)}</Puck>;
  return (
    <View style={[styles.rail, vertical && styles.vertical, { borderRadius: surface.railRadius, borderWidth: surface.border, borderBottomWidth: surface.base ?? surface.border }]}>
      {left.map(pin)}
      <Puck size={small} onPress={() => sendMedia('previous_track')} label="Previous track" disabled={!connected}><SkipBack size={20} color={colors.text} /></Puck>
      <Puck size={vertical ? 48 : 66} accent morph={playing} onPress={() => sendMedia('play_pause')} label={playing ? 'Pause' : 'Play'} disabled={!connected}>
        {playing ? <Pause size={26} color={colors.onAccent} fill={colors.onAccent} /> : <Play size={26} color={colors.onAccent} fill={colors.onAccent} style={{ marginLeft: 3 }} />}
      </Puck>
      <Puck size={small} onPress={() => sendMedia('next_track')} label="Next track" disabled={!connected}><SkipForward size={20} color={colors.text} /></Puck>
      {right.map(pin)}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  rail: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  puck: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.panelRaised },
  vertical: { flexDirection: 'column', flexWrap: 'wrap', maxHeight: '100%', gap: 6, paddingHorizontal: 6, paddingVertical: 6 },
  hit: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  accent: { backgroundColor: colors.accent, borderColor: colors.accent },
  off: { opacity: 0.45 },
});
