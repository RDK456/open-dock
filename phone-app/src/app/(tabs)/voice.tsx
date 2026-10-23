import { useEffect, useState } from 'react';
import { Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Mic, Send } from 'lucide-react-native';
import { Wallpaper } from '../../wallpaper';
import { usePcConnection } from '../../connection';
import { useHandsFree, type Heard } from '../../hands-free';
import { useStyles, useTheme, type Colors } from '../../theme';
import { useTabBarClearance } from '../../tab-inset';

const EXAMPLES = ['Open Spotify', 'Volume up', 'Next song', 'Search for weather', 'Type hello', 'Lock the PC', 'Take a screenshot', 'Open youtube.com'];

export default function VoiceScreen() {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const bottomClearance = useTabBarClearance();
  const { status, sendVoice } = usePcConnection();
  const connected = status === 'connected';
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const handsFree = useHandsFree();
  const { last, report: reveal } = handsFree;
  // What is being typed into the wake phrase field; null shows the saved phrase.
  const [phraseDraft, setPhraseDraft] = useState<string | null>(null);
  const [ring] = useState(() => new Animated.Value(0));
  const [shown] = useState(() => new Animated.Value(0));
  // Every new result (spoken hands-free, said into the dialog, typed or tapped) slides in.
  useEffect(() => {
    if (!last) return;
    shown.setValue(0);
    Animated.spring(shown, { toValue: 1, damping: 16, stiffness: 180, useNativeDriver: true }).start();
  }, [last, shown]);

  const run = async (said: string) => {
    const text = said.trim();
    if (!text) return;
    setBusy(true);
    const result = await sendVoice(text);
    setBusy(false);
    void Haptics.notificationAsync(result.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error);
    reveal({ said: text, ...result } satisfies Heard);
  };

  const submitTyped = () => {
    void run(typed);
    setTyped('');
  };

  // The ring pulses while the phone listens for the command.
  const listening = handsFree.hearing || handsFree.armed;
  useEffect(() => {
    if (!listening) {
      ring.stopAnimation();
      ring.setValue(0);
      return;
    }
    const pulse = Animated.loop(Animated.timing(ring, { toValue: 1, duration: 1100, easing: Easing.out(Easing.cubic), useNativeDriver: true }));
    pulse.start();
    return () => pulse.stop();
  }, [listening, ring]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Wallpaper />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomClearance + 16 }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Voice</Text>
        <Text style={styles.subtitle}>{!connected ? 'Connect to your PC to use voice commands.' : listening ? 'Listening. Say the command.' : handsFree.enabled ? `Say “${handsFree.phrase}” and a command, or tap the mic.` : 'Tap the mic and say what the PC should do.'}</Text>

        <View style={styles.micArea}>
          <Animated.View pointerEvents="none" style={[styles.ring, { opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }), transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) }] }]} />
          <Pressable
            style={({ pressed }) => [styles.mic, listening && styles.micArmed, !connected && styles.disabled, pressed && styles.pressed]}
            disabled={!connected || busy}
            onPress={() => void handsFree.listenOnce()}
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

        {Platform.OS === 'android' ? (
          <View style={styles.handsFree}>
            <View style={styles.handsFreeRow}>
              <View style={styles.handsFreeText}>
                <Text style={styles.handsFreeTitle}>Hands-free</Text>
                <Text style={styles.handsFreeHint}>Listens for your wake phrase, also while you use other apps. A notification shows while it runs.</Text>
              </View>
              <Switch value={handsFree.enabled} onValueChange={(on) => void handsFree.setEnabled(on)} trackColor={{ true: colors.accent, false: colors.border }} accessibilityLabel="Hands-free" />
            </View>
            <Text style={styles.phraseLabel}>Wake phrase</Text>
            <TextInput
              style={styles.input}
              value={phraseDraft ?? handsFree.phrase}
              onChangeText={setPhraseDraft}
              onEndEditing={() => { if (phraseDraft !== null) handsFree.setPhrase(phraseDraft); setPhraseDraft(null); }}
              placeholder="hey dock"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={40}
              returnKeyType="done"
              accessibilityLabel="Wake phrase"
            />
            {handsFree.error ? (
              <View style={styles.notice}>
                <Text style={[styles.noticeText, styles.resultErrorText]}>{handsFree.error}</Text>
                <Pressable style={({ pressed }) => [styles.noticeButton, pressed && styles.chipPressed]} onPress={handsFree.openSettings} accessibilityRole="button"><Text style={styles.chipText}>Open Settings</Text></Pressable>
              </View>
            ) : null}
            {!handsFree.islandAllowed ? (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>Show a listening bar at the top of the screen, over other apps, while a command is heard.</Text>
                <Pressable style={({ pressed }) => [styles.noticeButton, pressed && styles.chipPressed]} onPress={handsFree.allowIsland} accessibilityRole="button"><Text style={styles.chipText}>Allow</Text></Pressable>
              </View>
            ) : null}
            {!handsFree.unrestricted ? (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>Your phone may stop Open Dock in the background to save battery.</Text>
                <Pressable style={({ pressed }) => [styles.noticeButton, pressed && styles.chipPressed]} onPress={handsFree.allowBackground} accessibilityRole="button"><Text style={styles.chipText}>Keep running</Text></Pressable>
              </View>
            ) : null}
          </View>
        ) : null}

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
  micArmed: { borderWidth: 4, borderColor: colors.text },
  handsFree: { marginTop: 18, padding: 14, gap: 8, borderRadius: 16, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  handsFreeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  handsFreeText: { flex: 1 },
  handsFreeTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  handsFreeHint: { color: colors.muted, fontSize: 12, lineHeight: 16, marginTop: 3 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  noticeText: { flex: 1, color: colors.muted, fontSize: 12, lineHeight: 16 },
  noticeButton: { paddingHorizontal: 12, height: 34, borderRadius: 17, justifyContent: 'center', borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  phraseLabel: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 4 },
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
