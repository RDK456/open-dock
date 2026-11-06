import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { setStringAsync } from 'expo-clipboard';
import { ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { copyClipToPc, useClipboard, useClipboardDemand, type Clip } from './clipboard-feed';
import { Pressable } from './motion';
import { haptic, usePrefs } from './prefs';
import { useStyles, type Colors } from './theme';

// The PC's recent copies as a tile on the deck. Four looks (`face`) and three ways to scroll (`scroll`).
// Tapping a clip puts it back on the PC's clipboard.
export const CLIPBOARD_FACES = ['list', 'cards', 'chips', 'focus'] as const;
export const CLIPBOARD_SCROLLS = ['swipe', 'snap', 'auto'] as const;
type Face = (typeof CLIPBOARD_FACES)[number];
type Scroll = (typeof CLIPBOARD_SCROLLS)[number];

// A row's height decides where snapping lands; chips snap by line.
const ROW: Record<Exclude<Face, 'focus'>, number> = { list: 46, cards: 88, chips: 42 };
const AUTO_STEP = 0.6;
const AUTO_PAUSE_MS = 4000;
const AUTO_HOLD_MS = 2000;
const FOCUS_PAGE_MS = 5000;

const isFace = (value: string | undefined): value is Face => CLIPBOARD_FACES.includes(value as Face);
const isScroll = (value: string | undefined): value is Scroll => CLIPBOARD_SCROLLS.includes(value as Scroll);

function ago(atMs: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - atMs) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** One line of the clip for a row or chip: whitespace squeezed so a pasted block still reads. */
const squeeze = (text: string) => text.replace(/\s+/g, ' ').trim();

export function ClipboardWidget({ connected, focused, face, scroll, color, immersive }: { connected: boolean; focused: boolean; face?: string; scroll?: string; color?: string; immersive?: boolean }) {
  const styles = useStyles(makeStyles);
  const { supported, items, result } = useClipboard();
  const { motion } = usePrefs();
  const look: Face = isFace(face) ? face : 'list';
  const mode: Scroll = isScroll(scroll) ? scroll : 'swipe';
  const live = connected && focused;
  useClipboardDemand(live);

  // Relative times move on without a new message.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [live]);

  // The clip just tapped, and the line saying what happened: the PC's answer, or why nothing was sent.
  const [tapped, setTapped] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [answered, setAnswered] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = useCallback((action: () => void, ms: number) => { timers.current.push(setTimeout(action, ms)); }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const answerSeq = result?.seq ?? 0;
  const answerOk = result?.ok;
  useEffect(() => {
    if (!answerSeq) return;
    haptic.notify(answerOk === true);
    later(() => { setAnswered(answerSeq); setTapped(null); }, 1800);
  }, [answerSeq, answerOk, later]);
  const answer = result && result.seq > answered ? (result.ok ? 'Copied on PC' : result.error ?? 'Could not copy') : '';
  const note = notice || answer;
  const copy = (clip: Clip) => {
    haptic.select();
    if (!copyClipToPc(clip.id)) {
      setNotice('Not connected');
      later(() => setNotice(''), 1800);
      return;
    }
    setTapped(clip.id);
    later(() => setTapped(null), 4000);
  };

  // Long-press keeps the clip on this phone's own clipboard instead of sending it to the PC.
  const copyHere = (clip: Clip) => {
    haptic.select();
    setStringAsync(clip.text).then(() => setNotice('Copied on this phone'), () => setNotice('Could not copy'));
    later(() => setNotice(''), 1800);
  };

  // Scrolling.
  const scroller = useRef<ScrollView>(null);
  const offset = useRef(0);
  const size = useRef({ width: 1, height: 1, contentWidth: 0, contentHeight: 0 });
  const touching = useRef(false);
  const pausedUntil = useRef(0);
  const [pageWidth, setPageWidth] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => { size.current.width = event.nativeEvent.layout.width; size.current.height = event.nativeEvent.layout.height; setPageWidth(event.nativeEvent.layout.width); };
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => { offset.current = look === 'focus' ? event.nativeEvent.contentOffset.x : event.nativeEvent.contentOffset.y; };
  const newest = items[0]?.id;
  // A new clip brings the view back to it.
  useEffect(() => { scroller.current?.scrollTo({ x: 0, y: 0, animated: true }); }, [newest]);
  const auto = mode === 'auto' && motion && live && items.length > 1;
  useEffect(() => {
    if (!auto) return undefined;
    if (look === 'focus') {
      const timer = setInterval(() => {
        if (touching.current || Date.now() < pausedUntil.current) return;
        const page = Math.round(offset.current / size.current.width);
        scroller.current?.scrollTo({ x: ((page + 1) % items.length) * size.current.width, animated: true });
      }, FOCUS_PAGE_MS);
      return () => clearInterval(timer);
    }
    let bottomAt = 0;
    const timer = setInterval(() => {
      const at = Date.now();
      if (touching.current || at < pausedUntil.current) return;
      const max = size.current.contentHeight - size.current.height;
      if (max <= 1) return;
      if (offset.current >= max - 1) {
        bottomAt = bottomAt || at;
        if (at - bottomAt > AUTO_HOLD_MS) { bottomAt = 0; pausedUntil.current = at + 1000; scroller.current?.scrollTo({ y: 0, animated: true }); }
        return;
      }
      scroller.current?.scrollTo({ y: Math.min(max, offset.current + AUTO_STEP * 3), animated: false });
    }, 50);
    return () => clearInterval(timer);
  }, [auto, look, items.length]);
  const touchProps = {
    onTouchStart: () => { touching.current = true; },
    onTouchEnd: () => { touching.current = false; pausedUntil.current = Date.now() + AUTO_PAUSE_MS; },
    onTouchCancel: () => { touching.current = false; },
  };

  const accent = color ?? undefined;
  const empty = !connected ? 'Connect to a PC to see its clipboard.' : !supported ? "Clipboard history isn't available on this PC yet." : items.length === 0 ? 'Copy something on your PC and it shows up here.' : null;

  const clipButton = (clip: Clip, children: ReactNode, style: object) => (
    <Pressable key={clip.id} onPress={() => copy(clip)} onLongPress={() => copyHere(clip)} style={[style, tapped === clip.id && { borderColor: accent ?? styles.accent.color, backgroundColor: styles.tapped.backgroundColor }]} accessibilityRole="button" accessibilityLabel={`Copy to PC: ${squeeze(clip.text).slice(0, 80)}`}>
      {children}
    </Pressable>
  );

  let body: ReactNode = null;
  if (!empty) {
    if (look === 'focus') {
      body = (
        <ScrollView ref={scroller} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onScroll={onScroll} scrollEventThrottle={32} {...touchProps} onContentSizeChange={(w, h) => { size.current.contentWidth = w; size.current.contentHeight = h; }}>
          {items.map((clip, index) => (
            <View key={clip.id} style={{ width: pageWidth }}>
              {clipButton(clip, <>
                <Text numberOfLines={immersive ? 9 : 6} style={[styles.focusText, immersive && styles.focusTextBig]}>{clip.text}</Text>
                <Text style={styles.meta}>{ago(clip.atMs, now)} · {index + 1} of {items.length} · tap: PC · hold: phone</Text>
              </>, styles.focusPage)}
            </View>
          ))}
        </ScrollView>
      );
    } else {
      const snap = mode === 'snap' ? { snapToInterval: ROW[look] + styles.gap.height, decelerationRate: 'fast' as const } : null;
      body = (
        <ScrollView ref={scroller} onScroll={onScroll} scrollEventThrottle={32} showsVerticalScrollIndicator={false} {...snap} {...touchProps}
          onContentSizeChange={(w, h) => { size.current.contentWidth = w; size.current.contentHeight = h; }}
          contentContainerStyle={look === 'chips' ? styles.chipsWrap : styles.stack}>
          {items.map((clip) => look === 'list'
            ? clipButton(clip, <>
              <Text numberOfLines={1} style={styles.rowText}>{squeeze(clip.text)}</Text>
              <Text style={styles.time}>{ago(clip.atMs, now)}</Text>
            </>, styles.row)
            : look === 'cards'
              ? clipButton(clip, <>
                <Text numberOfLines={3} style={styles.cardText}>{clip.text.trim()}</Text>
                <Text style={styles.meta}>{ago(clip.atMs, now)}</Text>
              </>, styles.card)
              : clipButton(clip, <Text numberOfLines={1} style={styles.chipText}>{squeeze(clip.text)}</Text>, styles.chip))}
        </ScrollView>
      );
    }
  }

  return (
    <View style={styles.root} onLayout={onLayout}>
      {empty ? <View style={styles.emptyWrap}><Text style={styles.empty}>{empty}</Text></View> : body}
      {note ? <View pointerEvents="none" style={styles.noteWrap}><Text style={styles.note}>{note}</Text></View> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },
  gap: { height: 6 },
  accent: { color: colors.accent },
  tapped: { backgroundColor: colors.glow },
  stack: { gap: 6, padding: 8 },
  row: { height: ROW.list, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  rowText: { flex: 1, color: colors.text, fontSize: 14 },
  time: { color: colors.muted, fontSize: 11 },
  card: { height: ROW.cards, justifyContent: 'space-between', padding: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  cardText: { color: colors.text, fontSize: 13, lineHeight: 17 },
  meta: { color: colors.muted, fontSize: 11 },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 8, alignContent: 'flex-start' },
  chip: { maxWidth: '100%', height: ROW.chips - 6, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  chipText: { color: colors.text, fontSize: 13 },
  focusPage: { flex: 1, justifyContent: 'space-between', padding: 14, borderWidth: 1, borderColor: 'transparent', borderRadius: 12 },
  focusText: { color: colors.text, fontSize: 18, lineHeight: 24 },
  focusTextBig: { fontSize: 24, lineHeight: 31 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  empty: { color: colors.muted, fontSize: 13, textAlign: 'center' },
  noteWrap: { position: 'absolute', left: 0, right: 0, bottom: 6, alignItems: 'center' },
  note: { overflow: 'hidden', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.text, color: colors.bg, fontSize: 12, fontWeight: '600' },
});
