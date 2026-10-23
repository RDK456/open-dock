import { useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { usePcConnection } from './connection';
import { useStyles, useTheme, type Colors } from './theme';

// The PC draws the signature on a canvas this size; the pad keeps its shape so nothing is squashed.
const WIDTH = 1600;
const HEIGHT = 600;

type Stroke = [number, number][];

const toPath = (stroke: Stroke, scale: number) => stroke.map(([x, y], index) => `${index ? 'L' : 'M'}${(x * scale).toFixed(1)} ${(y * scale).toFixed(1)}`).join(' ') + (stroke.length === 1 ? ' l0.1 0' : '');

/** Draw with a finger, then paste the signature into whatever has focus on the PC. */
export function SignaturePad() {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const { status, sendSignature } = usePcConnection();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const scale = useRef(1);
  const [padWidth, setPadWidth] = useState(0);

  // The responder is made once; it reads the scale ref only inside touch handlers.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => {
    const point = (x: number, y: number): [number, number] => [Math.round(Math.min(WIDTH, Math.max(0, x / scale.current))), Math.round(Math.min(HEIGHT, Math.max(0, y / scale.current)))];
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        // Read the touch now: React Native clears the event before a state updater runs.
        const start = point(event.nativeEvent.locationX, event.nativeEvent.locationY);
        setNote('');
        setStrokes((current) => [...current, [start]]);
      },
      onPanResponderMove: (event) => {
        const next = point(event.nativeEvent.locationX, event.nativeEvent.locationY);
        setStrokes((current) => {
          const last = current[current.length - 1];
          const previous = last?.[last.length - 1];
          // Skip points closer than 3 canvas pixels; they add nothing but message size.
          if (!last || (previous && Math.hypot(next[0] - previous[0], next[1] - previous[1]) < 3)) return current;
          return [...current.slice(0, -1), [...last, next]];
        });
      },
    });
  });

  const insert = async () => {
    setBusy(true);
    const error = await sendSignature(strokes);
    setBusy(false);
    setNote(error ?? 'Pasted on the PC and saved in Pictures/Open Dock/Signatures');
    if (!error) setStrokes([]);
  };

  const ready = status === 'connected' && strokes.length > 0 && !busy;
  const viewScale = padWidth / WIDTH;

  return (
    <View style={styles.wrap}>
      <View
        style={styles.pad}
        onLayout={(event) => { setPadWidth(event.nativeEvent.layout.width); scale.current = event.nativeEvent.layout.width / WIDTH; }}
        {...responder.panHandlers}
        accessibilityLabel="Signature pad"
      >
        <View pointerEvents="none" style={styles.line} />
        {strokes.length === 0 ? <Text pointerEvents="none" style={styles.hint}>Sign here</Text> : null}
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
          {strokes.map((stroke, index) => <Path key={index} d={toPath(stroke, viewScale)} stroke={colors.text} strokeWidth={Math.max(2, 10 * viewScale)} strokeLinecap="round" strokeLinejoin="round" fill="none" />)}
        </Svg>
      </View>
      <View style={styles.actions}>
        <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} disabled={!strokes.length || busy} onPress={() => { setStrokes([]); setNote(''); }} accessibilityRole="button"><Text style={styles.buttonText}>Clear</Text></Pressable>
        <Pressable style={({ pressed }) => [styles.button, styles.primary, !ready && styles.disabled, pressed && styles.pressed]} disabled={!ready} onPress={() => void insert()} accessibilityRole="button"><Text style={[styles.buttonText, styles.primaryText]}>{busy ? 'Pasting…' : 'Paste on PC'}</Text></Pressable>
      </View>
      <Text style={styles.note}>{note || 'Click where the signature should go on the PC, then tap Paste.'}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { gap: 10 },
  pad: { width: '100%', aspectRatio: WIDTH / HEIGHT, borderRadius: 18, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass, overflow: 'hidden' },
  line: { position: 'absolute', left: '8%', right: '8%', bottom: '24%', height: 1, backgroundColor: colors.borderStrong },
  hint: { position: 'absolute', left: '8%', bottom: '27%', color: colors.faint, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 10 },
  button: { flex: 1, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  primaryText: { color: colors.onAccent },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.76 },
  note: { color: colors.faint, fontSize: 12, textAlign: 'center' },
});
