import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { LayoutGrid, Link2, Mic, SlidersHorizontal, type LucideIcon } from 'lucide-react-native';
import Storage from 'expo-sqlite/kv-store';
import * as SecureStore from 'expo-secure-store';
import { PAIRED_KEY, usePcConnection } from './connection';
import { Pressable } from './motion';
import { useStyles, useTheme, type Colors } from './theme';

// A four-card tour the first time Open Dock opens on a phone that has never paired. Seen once, then never again.
const KEY = 'opendock.first-run-done';
const STEPS: [LucideIcon, string, string][] = [
  [Link2, 'Pair with your PC', 'Install Open Dock on your Windows PC. It shows a QR code: scan it from the Connect tab. Both need the same Wi-Fi, or use USB.'],
  [LayoutGrid, 'Tap keys to control the PC', 'Media, shortcuts, apps and more. Swipe for pages, long-press a key for its second action, and tap ✏️ to edit.'],
  [SlidersHorizontal, 'Widgets and dials', 'On the PC, drag widgets onto the grid: stats, now playing, a clock, and dials for volume, brightness and each app.'],
  [Mic, 'Touchpad, voice and webcam', 'The other tabs turn the phone into a touchpad, a voice remote, and a webcam for your PC.'],
];

export function FirstRunTour() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const { pairedDevices } = usePcConnection();
  const [done, setDone] = useState(() => { try { return Storage.getItemSync(KEY) === 'yes'; } catch { return true; } });
  const [step, setStep] = useState(0);
  // People who already paired a PC know their way around; the saved list is read before anything shows.
  const [neverPaired, setNeverPaired] = useState(false);
  useEffect(() => {
    if (done) return;
    void SecureStore.getItemAsync(PAIRED_KEY).then((saved) => setNeverPaired(!saved || saved === '[]')).catch(() => setNeverPaired(false));
  }, [done]);
  if (done || !neverPaired || pairedDevices.length > 0) return null;
  const finish = (pair: boolean) => {
    try { Storage.setItemSync(KEY, 'yes'); } catch { /* shows again next launch */ }
    setDone(true);
    if (pair) router.navigate('/connect');
  };
  const [Icon, title, body] = STEPS[step];
  const last = step === STEPS.length - 1;
  return (
    <View style={styles.cover} accessibilityViewIsModal>
      <View style={styles.card}>
        <View style={styles.badge}><Icon size={28} color={colors.accent} strokeWidth={1.8} /></View>
        <Text style={styles.title} accessibilityRole="header">{title}</Text>
        <Text style={styles.body}>{body}</Text>
        <View style={styles.dots} accessibilityLabel={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((_, index) => <View key={index} style={[styles.dot, index === step && styles.dotOn]} />)}
        </View>
        <View style={styles.row}>
          <Pressable style={styles.ghost} onPress={() => finish(false)} accessibilityRole="button"><Text style={styles.ghostText}>Skip</Text></Pressable>
          <Pressable style={styles.button} onPress={() => last ? finish(true) : setStep(step + 1)} accessibilityRole="button">
            <Text style={styles.buttonText}>{last ? 'Pair a PC' : 'Next'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  cover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 420, alignItems: 'center', gap: 14 },
  badge: { width: 64, height: 64, borderRadius: 20, backgroundColor: colors.panel, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  body: { color: colors.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  dots: { flexDirection: 'row', gap: 6, marginTop: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border },
  dotOn: { width: 18, backgroundColor: colors.accent },
  row: { flexDirection: 'row', gap: 12, marginTop: 12 },
  ghost: { minHeight: 48, minWidth: 110, paddingHorizontal: 20, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  ghostText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  button: { minHeight: 48, minWidth: 140, paddingHorizontal: 24, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: colors.onAccent, fontSize: 15, fontWeight: '600' },
});
