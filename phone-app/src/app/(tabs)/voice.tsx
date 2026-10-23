import { useState } from 'react';
import { Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { startActivityAsync } from 'expo-intent-launcher';
import * as Haptics from 'expo-haptics';
import { Mic, Send } from 'lucide-react-native';
import { Wallpaper } from '../../wallpaper';
import { usePcConnection } from '../../connection';
import { useStyles, useTheme, type Colors } from '../../theme';
import { useTabBarClearance } from '../../tab-inset';

const EXAMPLES = ['Open Spotify', 'Volume up', 'Next song', 'Search for weather', 'Type hello', 'Lock the PC', 'Take a screenshot', 'Open youtube.com'];

// Android's own speech dialog (Google's recognizer), so no extra app or permission is needed.
async function listen(): Promise<string | null> {
  const result = await startActivityAsync('android.speech.action.RECOGNIZE_SPEECH', {
    extra: { 'android.speech.extra.LANGUAGE_MODEL': 'free_form', 'android.speech.extra.PROMPT': 'Say a command for your PC' },
  });
  const said = (result.extra as Record<string, unknown> | undefined)?.['android.speech.extra.RESULTS'];
  return Array.isArray(said) && typeof said[0] === 'string' ? said[0] : null;
}

export default function VoiceScreen() {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const bottomClearance = useTabBarClearance();
  const { status, sendVoice } = usePcConnection();
  const connected = status === 'connected';
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ said: string; ok: boolean; text: string } | null>(null);
  const [ring] = useState(() => new Animated.Value(0));
  const [shown] = useState(() => new Animated.Value(0));

  const reveal = (next: { said: string; ok: boolean; text: string }) => {
    setLast(next);
    shown.setValue(0);
    Animated.spring(shown, { toValue: 1, damping: 16, stiffness: 180, useNativeDriver: true }).start();
  };

  const run = async (said: string) => {
    const text = said.trim();
    if (!text) return;
    setBusy(true);
    const result = await sendVoice(text);
    setBusy(false);
    void Haptics.notificationAsync(result.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error);
    reveal({ said: text, ...result });
  };

  const submitTyped = () => {
    void run(typed);
    setTyped('');
  };

  const speak = async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    ring.setValue(0);
    Animated.timing(ring, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    try {
      const said = await listen();
      if (said) await run(said);
    } catch {
      reveal({ said: '', ok: false, text: 'Speech recognition is not available on this phone. Type the command instead.' });
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Wallpaper />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomClearance + 16 }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Voice</Text>
        <Text style={styles.subtitle}>{connected ? 'Tap the mic and say what the PC should do.' : 'Connect to your PC to use voice commands.'}</Text>

        <View style={styles.micArea}>
          <Animated.View pointerEvents="none" style={[styles.ring, { opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }), transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) }] }]} />
          <Pressable
            style={({ pressed }) => [styles.mic, !connected && styles.disabled, pressed && styles.pressed]}
            disabled={!connected || busy || Platform.OS !== 'android'}
            onPress={() => void speak()}
            accessibilityRole="button"
            accessibilityLabel="Speak a command"
          >
            <Mic size={42} color={colors.onAccent} />
          </Pressable>
        </View>

        {last ? (
          <Animated.View style={[styles.result, !last.ok && styles.resultError, { opacity: shown, transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]}>
            {last.said ? <Text style={styles.said}>“{last.said}”</Text> : null}
            <Text style={[styles.resultText, !last.ok && styles.resultErrorText]}>{last.text}</Text>
          </Animated.View>
        ) : null}

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={submitTyped}
            placeholder="Or type a command"
            placeholderTextColor={colors.faint}
            returnKeyType="send"
            editable={connected}
            accessibilityLabel="Command"
          />
          <Pressable style={({ pressed }) => [styles.send, pressed && styles.pressed]} disabled={!connected || !typed.trim()} onPress={submitTyped} accessibilityRole="button" accessibilityLabel="Send command">
            <Send size={18} color={colors.text} />
          </Pressable>
        </View>

        <Text style={styles.heading}>Try saying</Text>
        <View style={styles.examples}>
          {EXAMPLES.map((example) => (
            <Pressable key={example} style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]} disabled={!connected || busy} onPress={() => void run(example)} accessibilityRole="button">
              <Text style={styles.chipText}>{example}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 18, paddingTop: 12 },
  title: { color: colors.text, fontSize: 23, fontWeight: '600', letterSpacing: -0.3 },
  subtitle: { color: colors.muted, fontSize: 13, lineHeight: 17, marginTop: 5 },
  micArea: { alignItems: 'center', justifyContent: 'center', height: 220 },
  ring: { position: 'absolute', width: 132, height: 132, borderRadius: 66, backgroundColor: colors.accent },
  mic: { width: 132, height: 132, borderRadius: 66, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  pressed: { transform: [{ scale: 0.95 }] },
  disabled: { opacity: 0.45 },
  result: { padding: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass, marginBottom: 14 },
  resultError: { borderColor: colors.red },
  said: { color: colors.muted, fontSize: 13, marginBottom: 4 },
  resultText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  resultErrorText: { color: colors.red },
  inputRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, height: 46, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass, color: colors.text, fontSize: 15 },
  send: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  heading: { color: colors.muted, fontSize: 13, fontWeight: '600', marginTop: 22, marginBottom: 10 },
  examples: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, height: 36, borderRadius: 18, justifyContent: 'center', borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  chipPressed: { backgroundColor: colors.pressed },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '500' },
});
