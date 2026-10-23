import { useEffect, useRef, useState } from 'react';
import { useIsFocused, useRouter } from 'expo-router';
import { Animated, Easing, PanResponder, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Delete, Gauge, Grab, Keyboard, Monitor, MousePointer2, PenLine } from 'lucide-react-native';
import { SignaturePad } from '../../signature-pad';
import { Wallpaper } from '../../wallpaper';
import { usePcConnection, type PointerEvent } from '../../connection';
import { useStyles, useTheme, type Colors } from '../../theme';
import { useTabBarClearance } from '../../tab-inset';

const SPEEDS = [1, 1.6, 2.4, 3.4];
// A touch shorter and stiller than this is a tap (click); anything else moved the cursor.
const TAP_MS = 220;
const TAP_SLOP = 9;
// Finger travel per wheel step when scrolling with two fingers.
const SCROLL_STEP = 14;
// Change in finger spread per zoom step when pinching.
const ZOOM_STEP = 28;

type Point = { x: number; y: number; spread: number };
type Gesture = { start: number; maxFingers: number; travel: number; last: Point; fingers: number };

const centroid = (event: GestureResponderEvent) => {
  const touches = event.nativeEvent.touches;
  const count = Math.max(1, touches.length);
  let x = 0;
  let y = 0;
  for (const touch of touches) { x += touch.pageX; y += touch.pageY; }
  const spread = touches.length >= 2 ? Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY) : 0;
  return { x: x / count, y: y / count, spread, count: touches.length };
};

export default function TouchScreen() {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const focused = useIsFocused();
  const bottomClearance = useTabBarClearance();
  const window = useWindowDimensions();
  // Sideways, the buttons stand in a column beside the pad so the pad keeps the full height.
  const wide = window.width > window.height;
  const { status, sendPointer } = usePcConnection();
  const connected = status === 'connected';
  const [speedIndex, setSpeedIndex] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [typing, setTyping] = useState(false);
  const [signing, setSigning] = useState(false);
  const input = useRef<TextInput>(null);
  const [glow] = useState(() => [new Animated.ValueXY(), new Animated.ValueXY()]);
  const [glowOpacity] = useState(() => new Animated.Value(0));
  const padRef = useRef<View>(null);
  const origin = useRef({ x: 0, y: 0 });
  // The responder is made once, so it reads the latest values through this ref.
  const latest = useRef({ sendPointer, speed: SPEEDS[speedIndex], dragging });
  useEffect(() => { latest.current = { sendPointer, speed: SPEEDS[speedIndex], dragging }; });

  // Moves are summed and sent at most every 12 ms, keeping fractions so slow moves still add up.
  const pending = useRef({ dx: 0, dy: 0, scroll: 0, zoom: 0, timer: null as ReturnType<typeof setTimeout> | null });

  const send = (event: PointerEvent) => latest.current.sendPointer(event);

  // Leaving the screen lets go of a held drag, so the PC is never left with the button down.
  useEffect(() => {
    if (!focused && latest.current.dragging) {
      latest.current.sendPointer({ kind: 'release', button: 'left' });
      setDragging(false);
    }
  }, [focused]);

  // PanResponder calls these after render, when the refs hold the live gesture and props.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => {
    let gesture: Gesture | null = null;
    const flush = () => {
      const queue = pending.current;
      queue.timer = null;
      const dx = Math.trunc(queue.dx);
      const dy = Math.trunc(queue.dy);
      queue.dx -= dx;
      queue.dy -= dy;
      if (dx || dy) latest.current.sendPointer({ kind: 'move', dx, dy });
      const steps = Math.trunc(queue.scroll / SCROLL_STEP);
      if (steps) {
        queue.scroll -= steps * SCROLL_STEP;
        latest.current.sendPointer({ kind: 'scroll', dx: 0, dy: -steps });
      }
      const zoom = Math.trunc(queue.zoom / ZOOM_STEP);
      if (zoom) {
        queue.zoom -= zoom * ZOOM_STEP;
        latest.current.sendPointer({ kind: 'zoom', steps: zoom });
      }
    };
    const schedule = () => { if (!pending.current.timer) pending.current.timer = setTimeout(flush, 12); };
    const showGlow = (event: GestureResponderEvent) => {
      event.nativeEvent.touches.slice(0, 2).forEach((touch, index) => glow[index].setValue({ x: touch.pageX - origin.current.x, y: touch.pageY - origin.current.y }));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (event) => {
        const point = centroid(event);
        gesture = { start: Date.now(), maxFingers: point.count, travel: 0, last: point, fingers: point.count };
        showGlow(event);
        Animated.timing(glowOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
      },
      onPanResponderMove: (event) => {
        if (!gesture) return;
        const point = centroid(event);
        showGlow(event);
        // A finger landing or lifting moves the centroid; start measuring again from there.
        if (point.count !== gesture.fingers) {
          gesture.fingers = point.count;
          gesture.maxFingers = Math.max(gesture.maxFingers, point.count);
          gesture.last = point;
          return;
        }
        const dx = point.x - gesture.last.x;
        const dy = point.y - gesture.last.y;
        const dSpread = point.spread - gesture.last.spread;
        gesture.last = point;
        gesture.travel += Math.hypot(dx, dy) + Math.abs(dSpread);
        if (point.count >= 2) {
          // Fingers moving apart or together is a pinch; moving the same way is a scroll.
          if (Math.abs(dSpread) > Math.abs(dy) * 1.5) pending.current.zoom += dSpread;
          else pending.current.scroll += dy;
        } else {
          // Faster swipes go further, like a laptop touchpad.
          const gain = latest.current.speed * (1 + Math.min(2, Math.hypot(dx, dy) / 18));
          pending.current.dx += dx * gain;
          pending.current.dy += dy * gain;
        }
        schedule();
      },
      onPanResponderRelease: () => {
        Animated.timing(glowOpacity, { toValue: 0, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
        const finished = gesture;
        gesture = null;
        if (finished && Date.now() - finished.start < TAP_MS && finished.travel < TAP_SLOP) {
          latest.current.sendPointer({ kind: 'click', button: finished.maxFingers >= 2 ? 'right' : 'left' });
        }
      },
      onPanResponderTerminate: () => {
        gesture = null;
        Animated.timing(glowOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      },
    });
  });

  const toggleDrag = () => {
    const next = !dragging;
    if (send({ kind: next ? 'press' : 'release', button: 'left' })) setDragging(next);
  };

  const toggleKeyboard = () => {
    if (typing) {
      input.current?.blur();
      setTyping(false);
      return;
    }
    setTyping(true);
    setTimeout(() => input.current?.focus(), 30);
  };

  const quickKeys: { key: string; label: string; icon?: typeof ArrowUp }[] = [
    { key: 'ESCAPE', label: 'Esc' }, { key: 'TAB', label: 'Tab' },
    { key: 'LEFT', label: 'Left', icon: ArrowLeft }, { key: 'UP', label: 'Up', icon: ArrowUp }, { key: 'DOWN', label: 'Down', icon: ArrowDown }, { key: 'RIGHT', label: 'Right', icon: ArrowRight },
    { key: 'BACKSPACE', label: 'Backspace', icon: Delete }, { key: 'ENTER', label: 'Enter', icon: CornerDownLeft },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Wallpaper />
      <View style={styles.header}>
        <Text style={styles.title}>Touch</Text>
        {wide ? null : <Text style={styles.subtitle}>{connected ? signing ? 'Sign with your finger, then paste it on the PC' : 'One finger moves · tap clicks · two fingers scroll · pinch zooms · two-finger tap right-clicks' : 'Connect to a PC to use the touchpad'}</Text>}
      </View>

      <View style={[styles.body, wide && styles.bodyWide, { marginBottom: bottomClearance }]}>
      <View style={styles.main}>
      {signing ? <View style={styles.signWrap}><SignaturePad /></View> : <View style={styles.padWrap}>
        <View ref={padRef} style={[styles.pad, !connected && styles.padDisabled]} onLayout={() => padRef.current?.measure((_x, _y, _w, _h, pageX, pageY) => { origin.current = { x: pageX, y: pageY }; })} {...(connected ? responder.panHandlers : {})} accessibilityLabel="Touchpad">
          {glow.map((point, index) => <Animated.View key={index} pointerEvents="none" style={[styles.glow, { opacity: glowOpacity, transform: [{ translateX: Animated.subtract(point.x, 60) }, { translateY: Animated.subtract(point.y, 60) }] }]} />)}
          {!connected ? <Pressable style={styles.padEmpty} onPress={() => router.push('/connect')} accessibilityRole="button"><Monitor size={22} color={colors.muted} /><Text style={styles.padEmptyText}>Connect your PC</Text></Pressable> : <View pointerEvents="none" style={styles.padMark}><MousePointer2 size={22} color={colors.faint} /></View>}
        </View>
      </View>}

      {typing && !signing ? <View style={styles.keys}>
        {quickKeys.map(({ key, label, icon: Icon }) => <Pressable key={key} style={({ pressed }) => [styles.keyChip, pressed && styles.keyChipPressed]} onPress={() => send({ kind: 'key', key })} accessibilityRole="button" accessibilityLabel={label}>
          {Icon ? <Icon size={15} color={colors.text} /> : <Text style={styles.keyChipText}>{label}</Text>}
        </Pressable>)}
      </View> : null}
      </View>

      <View style={[styles.bar, wide && styles.barWide]}>
        <Pressable style={({ pressed }) => [styles.barButton, styles.barMain, pressed && styles.barPressed]} disabled={!connected} onPress={() => send({ kind: 'click', button: 'left' })} accessibilityRole="button"><Text style={styles.barText}>Left</Text></Pressable>
        <Pressable style={({ pressed }) => [styles.barButton, styles.barMain, pressed && styles.barPressed]} disabled={!connected} onPress={() => send({ kind: 'click', button: 'right' })} accessibilityRole="button"><Text style={styles.barText}>Right</Text></Pressable>
        <Pressable style={({ pressed }) => [styles.barButton, dragging && styles.barActive, pressed && styles.barPressed]} disabled={!connected} onPress={toggleDrag} accessibilityRole="button" accessibilityLabel={dragging ? 'Release drag' : 'Hold left button to drag'} accessibilityState={{ selected: dragging }}><Grab size={17} color={dragging ? colors.onAccent : colors.text} /></Pressable>
        <Pressable style={({ pressed }) => [styles.barButton, typing && styles.barActive, pressed && styles.barPressed]} disabled={!connected} onPress={toggleKeyboard} accessibilityRole="button" accessibilityLabel="Keyboard" accessibilityState={{ selected: typing }}><Keyboard size={17} color={typing ? colors.onAccent : colors.text} /></Pressable>
        <Pressable style={({ pressed }) => [styles.barButton, signing && styles.barActive, pressed && styles.barPressed]} onPress={() => setSigning(!signing)} accessibilityRole="button" accessibilityLabel="Signature" accessibilityState={{ selected: signing }}><PenLine size={17} color={signing ? colors.onAccent : colors.text} /></Pressable>
        <Pressable style={({ pressed }) => [styles.barButton, pressed && styles.barPressed]} onPress={() => setSpeedIndex((index) => (index + 1) % SPEEDS.length)} accessibilityRole="button" accessibilityLabel={`Pointer speed ${speedIndex + 1} of ${SPEEDS.length}`}><Gauge size={15} color={colors.text} /><Text style={styles.speedText}>{speedIndex + 1}</Text></Pressable>
      </View>
      </View>

      {/* Typed text goes straight to the PC; the field itself stays empty. */}
      <TextInput
        ref={input}
        value=""
        onChangeText={(text) => { if (text) send({ kind: 'text', text }); }}
        onKeyPress={({ nativeEvent }) => { if (nativeEvent.key === 'Backspace') send({ kind: 'key', key: 'BACKSPACE' }); }}
        onSubmitEditing={() => send({ kind: 'key', key: 'ENTER' })}
        onBlur={() => setTyping(false)}
        submitBehavior="submit"
        autoCorrect={false}
        autoCapitalize="none"
        // Android keyboards otherwise hold words back while composing them.
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
        style={styles.hiddenInput}
        accessibilityLabel="Type on the PC"
      />
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 18, paddingTop: 12 },
  title: { color: colors.text, fontSize: 23, fontWeight: '600', letterSpacing: -0.3 },
  subtitle: { color: colors.muted, fontSize: 13, lineHeight: 17, marginTop: 5 },
  padWrap: { flex: 1, padding: 14 },
  signWrap: { flex: 1, padding: 14, justifyContent: 'center' },
  pad: { flex: 1, overflow: 'hidden', borderRadius: 22, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  padDisabled: { opacity: 0.6 },
  padMark: { position: 'absolute', right: 16, bottom: 16, opacity: 0.5 },
  padEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  padEmptyText: { color: colors.muted, fontSize: 14, fontWeight: '500' },
  glow: { position: 'absolute', left: 0, top: 0, width: 120, height: 120, borderRadius: 60, backgroundColor: colors.glow },
  keys: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 14, paddingBottom: 8 },
  keyChip: { minWidth: 44, height: 36, paddingHorizontal: 10, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder },
  keyChipPressed: { backgroundColor: colors.pressed },
  keyChipText: { color: colors.text, fontSize: 13, fontWeight: '500' },
  bar: { flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
  barButton: { flex: 1, minWidth: 0, height: 48, paddingHorizontal: 4, borderRadius: 14, flexDirection: 'row', gap: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder },
  barMain: { flex: 1.4 },
  barWide: { flexDirection: 'column', width: 76, paddingHorizontal: 0, paddingTop: 14, paddingRight: 14 },
  body: { flex: 1 },
  bodyWide: { flexDirection: 'row' },
  main: { flex: 1 },
  barActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  barPressed: { transform: [{ scale: 0.96 }], backgroundColor: colors.pressed },
  barText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  speedText: { color: colors.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, bottom: 0 },
});
