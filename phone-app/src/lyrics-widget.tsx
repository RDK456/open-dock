import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, Animated, Easing, KeyboardAvoidingView, Modal, PanResponder, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Pressable } from './motion';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Storage from 'expo-sqlite/kv-store';
import type { SystemMediaState } from './connection';
import { activeLineAt, fetchLyrics, fetchLyricsById, isGapLine, lyricLineOpacity, lyricsLayout, lyricsTrace, lyricsTrackKey, nearestVersion, sungSpan, withIntroGap, type LyricLine, type Lyrics, type LyricsEntry, type TimingVersion } from './lyrics';
import { ChevronLeft, Minus, Plus, RefreshCw, Search, X } from 'lucide-react-native';
import { LyricsFinder } from './lyrics-finder';
import { useStyles, useTheme, type Colors } from './theme';
import { IDLE_MS } from './web-widget-lifecycle';

// ponytail: one fixed lead for every setup; make it a setting if lines feel early or late on some PCs.
const LYRICS_LEAD_MS = 250;
// Backward corrections smaller than this keep the current line, so the highlight never flickers back.
const JITTER_MS = 400;
// A position jump bigger than this is a seek: the list snaps instead of scrolling.
const SEEK_JUMP_MS = 1500;
const STAGGER_MS = 40;
const SPRING = { stiffness: 140, damping: 22, mass: 1 };
const EMPHASIS_MS = 450;
const DOT_BREATH_MS = 1000;
const DOT_EXIT_MS = 300;
const NEUTRAL_GAP_MS = 4000;
// Players publish a new title before its timeline. Wait through the PC's 1 s media polling cycle
// so the previous song's duration cannot immediately select a loose timing for the new title.
const SETTLE_MS = 1200;
// Some players publish the duration late or never: wait this long for it, then look up by name alone.
// Without a length the lookup can pick another timing of the song (one 16 s off for "Summer Rain"), so a
// lookup that has to guess shows lyrics that then jump once the length arrives; waiting avoids most of those.
const MISSING_DURATION_WAIT_MS = 2000;
// Browsing: a vertical drag scrolls the lyrics, and they stop following the song until this long after the
// last touch. Meanwhile every line is bright enough to read.
const BROWSE_RESUME_MS = 3000;
const BROWSE_OPACITY = 0.55;
// While a song keeps playing, a failed lookup is tried again this often.
const ERROR_RETRY_MS = 15_000;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Lyrics a widget shows outlive it: turning the phone swaps the deck's whole layout and mounts a new widget,
// which shows them at once instead of loading again. Like hidden web widgets, they go IDLE_MS after the
// last widget showing them does. Errors are not kept, so a new widget still retries.
type KeptLyrics = { lyrics: Lyrics; users: number; drop?: ReturnType<typeof setTimeout> };
const kept = new Map<string, KeptLyrics>();

function holdLyrics(key: string, lyrics: Lyrics) {
  const entry = kept.get(key) ?? { lyrics, users: 0 };
  if (entry.drop) clearTimeout(entry.drop);
  entry.drop = undefined;
  entry.lyrics = lyrics;
  entry.users += 1;
  kept.set(key, entry);
  return () => {
    entry.users -= 1;
    if (entry.users === 0) entry.drop = setTimeout(() => { if (kept.get(key) === entry) kept.delete(key); }, IDLE_MS);
  };
}

function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    return () => subscription.remove();
  }, []);
  return active;
}

// Sync fixes the user made for a track: a timing version (named by when its first line is sung) and an
// offset, where a negative offset shows the lyrics later. Kept on the phone for the latest few hundred tracks.
// `title` is a song name typed in the panel, for songs the PC reports under a name LRCLIB doesn't use.
type SyncChoice = { offsetMs: number; versionFirstMs?: number; versionLastMs?: number; lrclibId?: number; title?: string };
type StoredSyncChoice = SyncChoice & { at: number };
const SYNC_CHOICES_KEY = 'opendock.lyrics-sync';
const MAX_SYNC_CHOICES = 300;
// Music videos can run a story for minutes before the song starts.
const MAX_OFFSET_MS = 10 * 60_000;
const NUDGE_MS = 500;
const MAX_TYPED_TITLE = 200;
const NO_CHOICE: SyncChoice = { offsetMs: 0 };
let syncChoices: Promise<Record<string, StoredSyncChoice>> | null = null;

function validChoice(value: unknown): value is StoredSyncChoice {
  if (!value || typeof value !== 'object') return false;
  const choice = value as Partial<StoredSyncChoice>;
  return typeof choice.offsetMs === 'number' && Number.isFinite(choice.offsetMs) && Math.abs(choice.offsetMs) <= MAX_OFFSET_MS &&
    (choice.versionFirstMs === undefined || (typeof choice.versionFirstMs === 'number' && Number.isFinite(choice.versionFirstMs))) &&
    (choice.versionLastMs === undefined || (typeof choice.versionLastMs === 'number' && Number.isFinite(choice.versionLastMs))) &&
    (choice.lrclibId === undefined || (Number.isInteger(choice.lrclibId) && (choice.lrclibId ?? 0) > 0)) &&
    (choice.title === undefined || (typeof choice.title === 'string' && choice.title.length <= MAX_TYPED_TITLE)) &&
    typeof choice.at === 'number';
}

function loadSyncChoices() {
  syncChoices ??= Storage.getItem(SYNC_CHOICES_KEY).then((saved) => {
    const parsed: unknown = saved ? JSON.parse(saved) : {};
    const choices: Record<string, StoredSyncChoice> = {};
    if (parsed && typeof parsed === 'object') for (const [key, value] of Object.entries(parsed)) if (validChoice(value)) choices[key] = value;
    return choices;
  }).catch(() => ({}));
  return syncChoices;
}

async function saveSyncChoice(key: string, choice: SyncChoice) {
  const choices = await loadSyncChoices();
  if (choice.offsetMs !== 0 || choice.versionFirstMs !== undefined || choice.lrclibId !== undefined || choice.title) choices[key] = { ...choice, at: Date.now() };
  else delete choices[key];
  const oldest = Object.entries(choices).sort((a, b) => b[1].at - a[1].at).slice(MAX_SYNC_CHOICES);
  for (const [stale] of oldest) delete choices[stale];
  await Storage.setItem(SYNC_CHOICES_KEY, JSON.stringify(choices)).catch(() => undefined);
}

// The saved sync fix for a track, and an updater that saves it. Updates build on the latest value,
// so a held nudge button keeps adding up.
function useSyncChoice(key: string | null) {
  const [loaded, setLoaded] = useState<{ key: string; choice: SyncChoice } | null>(null);
  const latest = useRef<{ key: string; choice: SyncChoice } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void loadSyncChoices().then((choices) => {
      // A nudge made while this loaded is newer than what was saved.
      if (!alive || latest.current?.key === key) return;
      const saved = choices[key];
      latest.current = { key, choice: saved ? { offsetMs: saved.offsetMs, versionFirstMs: saved.versionFirstMs, versionLastMs: saved.versionLastMs, lrclibId: saved.lrclibId, title: saved.title } : NO_CHOICE };
      setLoaded(latest.current);
    });
    return () => { alive = false; };
  }, [key]);
  const update = useCallback((change: (current: SyncChoice) => SyncChoice) => {
    if (!key) return;
    const current = latest.current?.key === key ? latest.current.choice : NO_CHOICE;
    const next = change(current);
    const bounded = { ...next, offsetMs: clamp(next.offsetMs, -MAX_OFFSET_MS, MAX_OFFSET_MS) };
    latest.current = { key, choice: bounded };
    setLoaded(latest.current);
    // Saved once the taps stop, not on every step of a held button.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveSyncChoice(key, bounded), 600);
  }, [key]);
  // A pending save still happens when the track changes or the widget closes.
  useEffect(() => () => {
    if (!saveTimer.current || !latest.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    void saveSyncChoice(latest.current.key, latest.current.choice);
  }, [key]);
  return [loaded?.key === key ? loaded.choice : NO_CHOICE, update] as const;
}

// "+0.5 s", "−12.0 s", and past a minute "−2:30".
const signedSeconds = (milliseconds: number) => {
  const sign = milliseconds > 0 ? '+' : milliseconds < 0 ? '−' : '';
  const total = Math.abs(milliseconds) / 1000;
  return total < 60 ? `${sign}${total.toFixed(1)} s` : `${sign}${Math.floor(total / 60)}:${String(Math.floor(total % 60)).padStart(2, '0')}`;
};

// Holding speeds up: steps 1-10 move 1x, the next 10 move 4x, then 20x (0.5 s, 2 s, 10 s for nudges),
// so a minutes-long intro is a few seconds of holding.
const holdScale = (step: number) => step < 10 ? 1 : step < 20 ? 4 : 20;

// A tap steps once; holding keeps stepping, faster and faster, until release. Only one repeat timer ever
// runs: a new hold clears any earlier one, so fast taps can't leave a timer stepping on its own.
function RepeatButton({ onStep, label, size, children }: { onStep: (scale: number) => void; label: string; size: number; children: React.ReactNode }) {
  const styles = useStyles(makeStyles);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);
  const hold = () => {
    stop();
    let step = 0;
    onStep(1);
    timer.current = setInterval(() => {
      step += 1;
      onStep(holdScale(step));
    }, 150);
  };
  return <Pressable onPress={() => onStep(1)} onLongPress={hold} delayLongPress={400} onPressOut={stop} hitSlop={6} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.syncButton, { width: size + 8, height: size + 8, opacity: pressed ? 0.9 : 0.45 }]}>
    {children}
  </Pressable>;
}

function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (alive) setReduce(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

// A gentle 1 -> 1.08 -> 1 pulse, used by every set of dots.
function useBreath(enabled: boolean) {
  const [breath] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!enabled) {
      breath.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breath, { toValue: 1, duration: DOT_BREATH_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(breath, { toValue: 0, duration: DOT_BREATH_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [breath, enabled]);
  return breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
}

function Dots({ size, opacities, scale }: { size: number; opacities: (Animated.AnimatedInterpolation<number> | number)[]; scale: Animated.AnimatedInterpolation<number> | Animated.AnimatedMultiplication<number> | number }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return <Animated.View style={[styles.dots, { height: size * 2.6, gap: size * 0.7, transform: [{ scale }] }]}>
    {opacities.map((opacity, index) => <Animated.View key={index} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.text, opacity }} />)}
  </Animated.View>;
}

// Instrumental gap: the three dots fill in across the gap, breathe, and shrink away just before the next line.
function GapDots({ size, active, rate, startMs, endMs, now, clock, reduceMotion }: { size: number; active: boolean; rate: number; startMs: number; endMs: number; now: () => number; clock: string; reduceMotion: boolean }) {
  const [progress] = useState(() => new Animated.Value(0));
  const span = Math.max(1, endMs - startMs);
  useEffect(() => {
    if (!active) {
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }
    const start = clamp((now() - startMs) / span, 0, 1);
    progress.setValue(start);
    if (rate <= 0 || start >= 1) return;
    const fill = Animated.timing(progress, { toValue: 1, duration: (1 - start) * span / rate, easing: Easing.linear, useNativeDriver: true });
    fill.start();
    return () => fill.stop();
  }, [active, rate, progress, span, startMs, now, clock]);
  const breath = useBreath(active && rate > 0 && !reduceMotion);
  const exitStart = Math.max(0, 1 - DOT_EXIT_MS / span);
  const exit = progress.interpolate({ inputRange: [0, exitStart, 1], outputRange: [1, 1, 0], extrapolate: 'clamp' });
  const opacities = [0, 1, 2].map((index) => active ? progress.interpolate({ inputRange: [index / 3, (index + 1) / 3], outputRange: [0.3, 1], extrapolate: 'clamp' }) : 0.3);
  return <Dots size={size} opacities={opacities} scale={active ? Animated.multiply(breath, exit) : 1} />;
}

function SyncedLyrics({ lines, media, active, width, height, canSeek, seekMedia, onLongPress, offsetMs, onNudge, onResetOffset }: { lines: LyricLine[]; media: SystemMediaState; active: boolean; width: number; height: number; canSeek: boolean; seekMedia: (positionMs: number) => boolean; onLongPress: () => void; offsetMs: number; onNudge: (deltaMs: number) => void; onResetOffset: () => void }) {
  const { colors, scheme } = useTheme();
  const styles = useStyles(makeStyles);
  const reduceMotion = useReduceMotion();
  const { compact, fontSize, padding, lineGap, anchorY } = lyricsLayout(width, height);

  // Local clock: the last reported position plus the time since it arrived.
  // rate is 0 while paused or while the PC's player buffers, so the clock stands still with it.
  const anchor = useRef({ positionMs: 0, at: 0, rate: 0 });
  // The user's sync nudge for this track, added to the clock (negative shows lyrics later).
  const offset = useRef(offsetMs);
  const now = useCallback(() => anchor.current.positionMs + (performance.now() - anchor.current.at) * anchor.current.rate + LYRICS_LEAD_MS + offset.current, []);
  const snap = useRef(true);
  // Set by a nudge: the next move springs all lines together instead of the line-by-line wave.
  const glide = useRef(false);
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState(-1);
  const shownRef = useRef(-1);
  const playing = media.playbackState === 'playing';
  const rate = playing ? media.playbackRate ?? 1 : 0;

  // The latest report from the PC and when it arrived; the resync button snaps back to it.
  const reported = useRef<{ positionMs?: number; rate?: number; at: number }>({ at: 0 });
  // Hidden (another tab, or the app in the background), no timer runs; coming back snaps to the line now sung.
  const wasActive = useRef(active);

  // Re-anchors the clock on each position report, picks the current line, then sleeps until the next one starts.
  useEffect(() => {
    // A nudge glides the whole list together (no wave), and is never held back as jitter: fast taps
    // then just retarget the same smooth motion instead of jumping.
    const nudged = offset.current !== offsetMs;
    if (active && !wasActive.current) snap.current = true;
    wasActive.current = active;
    if (nudged) {
      offset.current = offsetMs;
      glide.current = true;
    }
    if (reported.current.positionMs !== media.positionMs || reported.current.rate !== rate) {
      reported.current = { positionMs: media.positionMs, rate, at: performance.now() };
      const positionMs = media.positionMs ?? 0;
      if (Math.abs(positionMs - (now() - LYRICS_LEAD_MS - offset.current)) > SEEK_JUMP_MS) snap.current = true;
      anchor.current = { positionMs, at: reported.current.at, rate };
    }
    const position = now();
    const computed = activeLineAt(lines, position);
    const current = shownRef.current;
    const keep = !snap.current && !nudged && computed < current && current < lines.length && position > lines[current].timeMs - JITTER_MS;
    const next = keep ? current : computed;
    // Same line after a re-anchor or nudge (e.g. a seek within it): nothing moves, so the snap or glide is spent here.
    if (next === current) {
      snap.current = false;
      glide.current = false;
    }
    shownRef.current = next;
    setShown(next);
    if (!active || anchor.current.rate <= 0 || next + 1 >= lines.length) return;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, lines[next + 1].timeMs - position) / anchor.current.rate + 5);
    return () => clearTimeout(timer);
  }, [lines, tick, now, media.positionMs, rate, offsetMs, active]);

  const animated = useMemo(() => lines.map(() => ({ y: new Animated.Value(0), opacity: new Animated.Value(0.15), scale: new Animated.Value(0.96) })), [lines]);
  const offsets = useRef<number[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const placedIndex = useRef<number | null>(null);
  // Where the active line sat in the list when the lines were last placed: scrolling is bounded from it.
  const placedOffset = useRef(0);
  // The drag moves one wrapper around all lines, so it never mixes with the lines' own native animations.
  const [drag] = useState(() => new Animated.Value(0));
  const [browsing, setBrowsing] = useState(false);
  const browse = useRef({ active: false, base: 0, value: 0, min: 0, max: 0, timer: null as ReturnType<typeof setTimeout> | null });
  useEffect(() => {
    const state = browse.current;
    const listener = drag.addListener(({ value }) => { state.value = value; });
    return () => {
      drag.removeListener(listener);
      if (state.timer) clearTimeout(state.timer);
    };
  }, [drag]);
  // Back to following the song: the list glides home and the lines settle on the current one.
  const resume = useCallback(() => {
    const state = browse.current;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (!state.active) return;
    state.active = false;
    drag.stopAnimation();
    Animated.spring(drag, { toValue: 0, ...SPRING, useNativeDriver: false }).start();
    glide.current = true;
    setBrowsing(false);
  }, [drag]);
  const resumeLater = useRef(resume);
  useEffect(() => {
    resumeLater.current = resume;
  }, [resume]);
  // The block owns its touches. React Native only offers a moving touch to views above the one holding it,
  // so a wrapper around the block would starve this of drags that start between lines.
  // - A touch nothing inside claims (empty space, or lines while the player can't seek) starts here.
  // - A drag that starts on a line or button moves here once it turns vertical.
  // - A vertical drag scrolls; a horizontal one is handed back to the deck's page swipe; holding still
  //   opens the details panel.
  const longPressLater = useRef(onLongPress);
  useEffect(() => {
    longPressLater.current = onLongPress;
  }, [onLongPress]);
  // eslint-disable-next-line react-hooks/refs
  const [scroller] = useState(() => {
    const touch = { dragging: false, holdTimer: null as ReturnType<typeof setTimeout> | null };
    const cancelHold = () => {
      if (touch.holdTimer) clearTimeout(touch.holdTimer);
      touch.holdTimer = null;
    };
    const isVertical = (dx: number, dy: number) => Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx) * 1.2;
    const startDrag = (dy: number) => {
      const state = browse.current;
      touch.dragging = true;
      cancelHold();
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      drag.stopAnimation();
      // The first line can come down to where the active line sits, and the last line up to it.
      const lineOffsets = offsets.current;
      state.max = placedOffset.current - (lineOffsets[0] ?? 0);
      state.min = Math.min(state.max, placedOffset.current - (lineOffsets[lineOffsets.length - 1] ?? 0));
      // Measured from the finger's travel so far, so the list doesn't jump when the drag is picked up.
      state.base = state.value - dy;
      if (!state.active) {
        state.active = true;
        setBrowsing(true);
      }
    };
    const endDrag = (velocity: number) => {
      const state = browse.current;
      touch.dragging = false;
      // A flick keeps going and slows down, then settles back inside the lyrics if it ran past an end.
      Animated.decay(drag, { velocity, deceleration: 0.997, useNativeDriver: false }).start(({ finished }) => {
        if (!finished || !state.active) return;
        const bounded = clamp(state.value, state.min, state.max);
        if (bounded !== state.value) Animated.spring(drag, { toValue: bounded, ...SPRING, useNativeDriver: false }).start();
      });
      state.timer = setTimeout(() => resumeLater.current(), BROWSE_RESUME_MS);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => isVertical(gesture.dx, gesture.dy),
      onPanResponderGrant: (_, gesture) => {
        touch.dragging = false;
        cancelHold();
        if (isVertical(gesture.dx, gesture.dy)) startDrag(gesture.dy);
        else touch.holdTimer = setTimeout(() => {
          touch.holdTimer = null;
          longPressLater.current();
        }, 600);
      },
      onPanResponderMove: (_, gesture) => {
        if (!touch.dragging) {
          if (isVertical(gesture.dx, gesture.dy)) startDrag(gesture.dy);
          else if (Math.abs(gesture.dx) > 10 || Math.abs(gesture.dy) > 10) cancelHold();
          return;
        }
        const state = browse.current;
        drag.setValue(clamp(state.base + gesture.dy, state.min, state.max));
      },
      // Only a scrolling drag keeps the touch; anything else may go to the page swipe.
      onPanResponderTerminationRequest: () => !touch.dragging,
      onPanResponderRelease: (_, gesture) => {
        cancelHold();
        if (touch.dragging) endDrag(gesture.vy);
      },
      onPanResponderTerminate: () => {
        cancelHold();
        if (touch.dragging) endDrag(0);
      },
    });
  });

  // Moves every line so the active one sits at the anchor, in a downward-travelling wave.
  useEffect(() => {
    for (let index = 0; index < lines.length; index += 1) if (offsets.current[index] === undefined) return;
    if (browsing) {
      animated.forEach((line, index) => {
        Animated.timing(line.opacity, { toValue: index === shown ? 1 : BROWSE_OPACITY, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      });
      return;
    }
    const anchorIndex = Math.max(0, shown);
    const target = anchorY - offsets.current[anchorIndex];
    const previous = placedIndex.current;
    const instant = snap.current || previous === null || previous === shown || reduceMotion;
    const waveStart = previous === null ? shown : Math.min(previous, shown);
    animated.forEach((line, index) => {
      const distance = shown < 0 ? index + 1 : Math.abs(index - shown);
      const opacity = compact && index < shown ? 0 : lyricLineOpacity(distance, scheme === 'light');
      const scale = reduceMotion || index === shown ? 1 : 0.96;
      if (instant) {
        line.y.stopAnimation();
        line.y.setValue(target);
      } else {
        Animated.spring(line.y, { toValue: target, ...SPRING, delay: glide.current ? 0 : clamp(index - waveStart, 0, 12) * STAGGER_MS, useNativeDriver: true }).start();
      }
      const duration = snap.current || reduceMotion ? 200 : EMPHASIS_MS;
      Animated.timing(line.opacity, { toValue: opacity, duration, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      Animated.timing(line.scale, { toValue: scale, duration, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    });
    placedIndex.current = shown;
    placedOffset.current = offsets.current[anchorIndex];
    snap.current = false;
    glide.current = false;
  }, [animated, shown, layoutVersion, anchorY, compact, reduceMotion, lines.length, browsing, scheme]);

  const seekTo = useCallback((line: LyricLine) => {
    if (!seekMedia(line.timeMs)) return;
    anchor.current = { positionMs: line.timeMs, at: performance.now(), rate: anchor.current.rate };
    resume();
    setTick((value) => value + 1);
  }, [seekMedia, resume]);
  // A full reset: back to exactly what the PC last reported, with any nudge offset cleared (it is saved
  // per track, so it would otherwise stay), jumping straight to that line.
  const resync = useCallback(() => {
    anchor.current = { positionMs: reported.current.positionMs ?? 0, at: reported.current.at, rate: reported.current.rate ?? 0 };
    snap.current = true;
    resume();
    onResetOffset();
    setTick((value) => value + 1);
  }, [resume, onResetOffset]);
  const measure = useCallback((index: number, y: number) => {
    if (offsets.current[index] === y) return;
    offsets.current[index] = y;
    setLayoutVersion((value) => value + 1);
  }, []);

  const icon = clamp(fontSize * 0.6, 12, 18);
  const controlsWidth = 3 * (icon + 8) + 2 * 4;
  // Short blocks pin the active line to the top, under the sync buttons, so it keeps clear of them.
  return <View {...scroller.panHandlers} style={[styles.fill, { paddingLeft: padding, paddingRight: compact ? padding + controlsWidth + 4 : padding }]}>
    <Animated.View style={{ transform: [{ translateY: drag }] }}>
    {lines.map((line, index) => {
      const gap = isGapLine(line);
      return <Animated.View key={`${index}:${line.timeMs}`} onLayout={(event) => measure(index, event.nativeEvent.layout.y)} style={{ marginBottom: lineGap, opacity: animated[index].opacity, transformOrigin: 'left center', transform: [{ translateY: animated[index].y }, { scale: animated[index].scale }] }}>
        <Pressable disabled={!canSeek || gap} onPress={() => seekTo(line)} onLongPress={onLongPress} accessibilityRole={canSeek && !gap ? 'button' : undefined} accessibilityLabel={gap ? 'Instrumental' : line.text}>
          {gap
            ? <GapDots size={fontSize * 0.42} active={index === shown} rate={rate} startMs={line.timeMs} endMs={lines[index + 1]?.timeMs ?? line.timeMs + NEUTRAL_GAP_MS} now={now} clock={`${media.positionMs}:${rate}:${tick}:${offsetMs}`} reduceMotion={reduceMotion} />
            : <Text allowFontScaling={false} style={[styles.line, { fontSize, lineHeight: fontSize * 1.25 }]}>{line.text}</Text>}
        </Pressable>
      </Animated.View>;
    })}
    </Animated.View>
    {/* Earlier/later nudges around the resync button; the offset shows beneath them while set. */}
    <View style={[styles.syncControls, { top: padding * 0.5, right: padding * 0.5 }]}>
      <View style={styles.syncRow}>
        <RepeatButton onStep={(scale) => onNudge(-NUDGE_MS * scale)} label="Show lyrics later; hold to move faster" size={icon}>
          <Minus size={icon} color={colors.text} strokeWidth={2} />
        </RepeatButton>
        <Pressable onPress={resync} onLongPress={onLongPress} hitSlop={6} accessibilityRole="button" accessibilityLabel="Resync lyrics with the PC and clear the offset" style={({ pressed }) => [styles.syncButton, { width: icon + 8, height: icon + 8, opacity: pressed ? 0.9 : 0.45 }]}>
          <RefreshCw size={icon} color={colors.text} strokeWidth={2} />
        </Pressable>
        <RepeatButton onStep={(scale) => onNudge(NUDGE_MS * scale)} label="Show lyrics earlier; hold to move faster" size={icon}>
          <Plus size={icon} color={colors.text} strokeWidth={2} />
        </RepeatButton>
      </View>
      {offsetMs !== 0 ? <Text allowFontScaling={false} accessibilityLabel={`Lyrics offset ${signedSeconds(offsetMs)}`} style={[styles.offsetLabel, { fontSize: icon * 0.75 }]}>{signedSeconds(offsetMs)}</Text> : null}
    </View>
  </View>;
}

function Message({ title, size }: { title: string; size: number }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.center}><Text allowFontScaling={false} numberOfLines={2} style={[styles.message, { fontSize: size }]}>{title}</Text></View>;
}

function BreathingDots({ size, label, labelSize }: { size: number; label?: string; labelSize: number }) {
  const styles = useStyles(makeStyles);
  const reduceMotion = useReduceMotion();
  const breath = useBreath(!reduceMotion);
  return <View style={styles.center}>
    <Dots size={size} opacities={[1, 1, 1]} scale={breath} />
    {label ? <Text allowFontScaling={false} style={[styles.message, { fontSize: labelSize }]}>{label}</Text> : null}
  </View>;
}

export function LyricsWidget({ media, connected, focused, seekMedia }: { media: SystemMediaState; connected: boolean; focused: boolean; seekMedia: (positionMs: number) => boolean }) {
  const styles = useStyles(makeStyles);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const key = lyricsTrackKey(media);
  const [result, setResult] = useState<{ key: string; lyrics: Lyrics } | null>(null);
  const [choice, updateChoice] = useSyncChoice(key);
  const typedTitle = choice.title;
  // Results belong to the track and the title it was looked up with.
  const resultKey = key ? `${key}|${typedTitle ?? ''}|${choice.lrclibId ?? ''}` : null;
  const [retry, setRetry] = useState(0);
  const [debug, setDebug] = useState(false);
  // A new song's name can arrive before its length, and until it does the length is the last song's.
  // `carriedMs` is that previous length: while the reported one still equals it, the length is waited on
  // like a missing one.
  const lastSong = useRef<{ identity: string; carriedMs?: number; durationMs?: number } | null>(null);
  // Waits for the track details to settle (longer while the duration is missing), then looks it up.
  // A duration arriving later changes the key, which restarts the wait and looks up again with it.
  useEffect(() => {
    if (!key) return;
    const identity = key.slice(0, key.lastIndexOf('\u0000'));
    const before = lastSong.current;
    const song = before?.identity === identity ? before : { identity, carriedMs: before?.durationMs, durationMs: media.durationMs };
    song.durationMs = media.durationMs;
    lastSong.current = song;
    const carried = media.durationMs !== undefined && media.durationMs === song.carriedMs;
    if (resultKey && kept.has(resultKey)) return;
    let alive = true;
    const track = { title: media.title, artist: media.artist, album: media.album, durationMs: media.durationMs };
    // An entry picked in Find lyrics is fetched by its number, with no wait for the track's details.
    const pickedId = choice.lrclibId;
    const timer = setTimeout(() => {
      void (pickedId !== undefined ? fetchLyricsById(pickedId) : fetchLyrics(track, typedTitle)).then((lyrics) => {
        if (alive && resultKey) setResult({ key: resultKey, lyrics });
      });
    }, pickedId !== undefined ? 0 : media.durationMs && !carried ? SETTLE_MS : MISSING_DURATION_WAIT_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, resultKey, typedTitle, choice.lrclibId, retry, media.title, media.artist, media.album, media.durationMs]);
  // Lyrics belong to one track: anything fetched for another key is never shown.
  const lyrics = useMemo((): Lyrics | 'loading' => !key ? { kind: 'none' } : result?.key === resultKey ? result.lyrics : (resultKey && kept.get(resultKey)?.lyrics) || 'loading', [key, resultKey, result]);
  const keepable = lyrics !== 'loading' && lyrics.kind !== 'error' && key ? lyrics : null;
  useEffect(() => {
    if (resultKey && keepable) return holdLyrics(resultKey, keepable);
  }, [resultKey, keepable]);
  const appActive = useAppActive();
  const active = focused && appActive;
  useEffect(() => {
    if (lyrics === 'loading' || lyrics.kind !== 'error') return;
    const timer = setTimeout(() => setRetry((value) => value + 1), ERROR_RETRY_MS);
    return () => clearTimeout(timer);
  }, [lyrics]);
  const showDebug = useCallback(() => setDebug(true), []);
  const versions = useMemo(() => lyrics !== 'loading' && (lyrics.kind === 'synced' || lyrics.kind === 'plain') ? lyrics.versions ?? [] : [], [lyrics]);
  // Each timing is told apart by its first and last sung lines: two can open together and differ at the end.
  const autoSpan = lyrics !== 'loading' && lyrics.kind === 'synced' ? sungSpan(lyrics.lines) : undefined;
  const auto = autoSpan ? nearestVersion(versions, autoSpan.firstMs, autoSpan.lastMs) : undefined;
  // A timing version the user picked wins over the automatic one, even over lyrics shown unsynced.
  const picked = choice.versionFirstMs === undefined ? undefined : nearestVersion(versions, choice.versionFirstMs, choice.versionLastMs);
  const chosenLines = picked?.lines ?? (lyrics !== 'loading' && lyrics.kind === 'synced' ? lyrics.lines : null);
  const lines = useMemo(() => chosenLines ? withIntroGap(chosenLines) : null, [chosenLines]);
  const nudge = useCallback((deltaMs: number) => updateChoice((current) => ({ ...current, offsetMs: current.offsetMs + deltaMs })), [updateChoice]);
  // Using an entry from Find lyrics replaces any timing picked for the automatic lyrics.
  const useEntry = useCallback((entry: LyricsEntry) => {
    updateChoice((current) => ({ ...current, lrclibId: entry.id, versionFirstMs: undefined, versionLastMs: undefined }));
    setDebug(false);
  }, [updateChoice]);
  const useAutomatic = useCallback(() => updateChoice((current) => ({ ...current, lrclibId: undefined })), [updateChoice]);
  const pickVersion = useCallback((version: TimingVersion | undefined) => updateChoice((current) => ({ ...current, versionFirstMs: version?.firstMs, versionLastMs: version?.lastMs })), [updateChoice]);
  const resetOffset = useCallback(() => updateChoice((current) => ({ ...current, offsetMs: 0 })), [updateChoice]);
  // Another title means another song's entries: an earlier timing pick no longer applies.
  const searchTitle = useCallback((title: string | undefined) => updateChoice((current) => ({ ...current, title: title?.trim().slice(0, MAX_TYPED_TITLE) || undefined, versionFirstMs: undefined, versionLastMs: undefined })), [updateChoice]);
  const width = size.width || 92;
  const height = size.height || 92;
  const { messageSize } = lyricsLayout(width, height);
  const hasMedia = connected && media.playbackState !== 'unavailable' && Boolean(media.title || media.artist);
  const canSeek = connected && Boolean(media.canSeek);

  let content;
  if (!hasMedia) content = <Message title="Nothing playing" size={messageSize} />;
  else if (lyrics === 'loading') content = <BreathingDots size={messageSize * 0.5} labelSize={messageSize} />;
  // Keyed by track and timing version, so a new song or timing mounts fresh: no scroll from the old position.
  else if (lines) content = <SyncedLyrics key={`${key}:${picked ? `${picked.firstMs}:${picked.lastMs}` : 'auto'}`} lines={lines} media={media} active={active} width={width} height={height} canSeek={canSeek} seekMedia={seekMedia} onLongPress={showDebug} offsetMs={choice.offsetMs} onNudge={nudge} onResetOffset={resetOffset} />;
  else if (lyrics.kind === 'plain') content = <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: messageSize }}>
    {versions.length > 0 ? <Text allowFontScaling={false} style={[styles.plainHint, { fontSize: messageSize * 0.8 }]}>Not synced to this video · long-press to pick a timing</Text> : null}
    <Text allowFontScaling={false} onLongPress={showDebug} style={[styles.plain, { fontSize: messageSize * 1.05, lineHeight: messageSize * 1.55 }]}>{lyrics.text}</Text>
  </ScrollView>;
  else if (lyrics.kind === 'instrumental') content = <BreathingDots size={messageSize * 0.5} label="Instrumental" labelSize={messageSize} />;
  else content = <Message title={lyrics.kind === 'error' ? 'Lyrics unavailable' : 'No lyrics found'} size={messageSize} />;

  return <View onLayout={(event) => {
    const { width: nextWidth, height: nextHeight } = event.nativeEvent.layout;
    setSize((current) => Math.abs(current.width - nextWidth) < 1 && Math.abs(current.height - nextHeight) < 1 ? current : { width: nextWidth, height: nextHeight });
  }} style={styles.widget}>
    {/* Long-press anywhere for what the PC reported and what the lookup tried. */}
    {/* Lyrics that scroll take their own long-press: a wrapping touchable would hold the touch and block
        the scrolling (synced lyrics handle every touch themselves; unsynced ones scroll natively). */}
    {lines || (lyrics !== 'loading' && lyrics.kind === 'plain') ? <View style={styles.fill}>{size.height ? content : null}</View>
      : <Pressable onLongPress={showDebug} delayLongPress={600} accessibilityHint="Long press for lyrics lookup details" style={styles.fill}>
        {size.height ? content : null}
      </Pressable>}
    {debug ? <LyricsDebug media={media} status={lyrics === 'loading' ? 'loading' : lyrics.kind} onClose={() => setDebug(false)}
      pickedId={choice.lrclibId} shown={picked ? { firstMs: picked.firstMs, lastMs: picked.lastMs } : autoSpan} onUseEntry={useEntry} onAutomatic={useAutomatic}
      sync={{ versions, shown: picked ?? auto, auto, synced: autoSpan !== undefined, reason: lyrics !== 'loading' && lyrics.kind === 'synced' ? lyrics.reason : undefined, picked: picked !== undefined, offsetMs: choice.offsetMs }}
      onPickVersion={pickVersion} onResetOffset={resetOffset} typedTitle={typedTitle} onSearchTitle={searchTitle} /> : null}
  </View>;
}

const durationLabel = (milliseconds?: number) => milliseconds === undefined ? 'not reported' : `${(milliseconds / 1000).toFixed(1)} s`;

// What the PC reported for the track and each lookup step, refreshed while a lookup is still running.
type SyncPanel = { versions: TimingVersion[]; shown?: TimingVersion; auto?: TimingVersion; synced: boolean; reason?: string; picked: boolean; offsetMs: number };

// The sync fixes, then what the PC reported for the track and each lookup step, refreshed while a lookup
// is still running. Tapping a timing version uses it for this track from now on.
function LyricsDebug({ media, status, onClose, pickedId, shown, onUseEntry, onAutomatic, sync, onPickVersion, onResetOffset, typedTitle, onSearchTitle }: { media: SystemMediaState; status: string; onClose: () => void; pickedId?: number; shown?: { firstMs: number; lastMs: number }; onUseEntry: (entry: LyricsEntry) => void; onAutomatic: () => void; sync: SyncPanel; onPickVersion: (version: TimingVersion | undefined) => void; onResetOffset: () => void; typedTitle?: string; onSearchTitle: (title: string | undefined) => void }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [finding, setFinding] = useState(false);
  const [, setRefresh] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setRefresh((value) => value + 1), 500);
    return () => clearInterval(interval);
  }, []);
  const trace = lyricsTrace(media, typedTitle);
  const rows = [
    `title: ${media.title ?? '(none)'}`,
    `artist: ${media.artist ?? '(none)'}`,
    `album: ${media.album ?? '(none)'}`,
    `duration: ${durationLabel(media.durationMs)}`,
    `player: ${media.sourceAppId ?? 'unknown'} (${media.playbackState})`,
    `lyrics: ${status}`,
    trace.key ? '' : 'lookup skipped: no title, or shorter than 30 s / longer than 15 min',
    ...trace.steps,
  ].filter(Boolean);
  // A native modal keeps the deck's scroll/swipe responders out of these touches.
  // Dismissal lives outside the scroll content, so a drag cannot become a close tap.
  return <Modal transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}>
    <SafeAreaProvider style={styles.debugOverlay}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.debugKeyboard}>
        <Pressable onPress={onClose} accessible={false} importantForAccessibility="no" style={StyleSheet.absoluteFill} />
        <SafeAreaView pointerEvents="box-none" style={styles.debugSafeArea}>
          <View accessibilityViewIsModal style={styles.debug}>
            <View style={styles.debugHeader}>
              {finding ? <Pressable onPress={() => setFinding(false)} accessibilityRole="button" accessibilityLabel="Back to lyrics details" style={styles.debugBack}>
                <ChevronLeft size={20} color={colors.text} />
              </Pressable> : null}
              <Text accessibilityRole="header" style={styles.debugTitle}>{finding ? 'Find lyrics' : 'Lyrics details'}</Text>
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close lyrics details" style={styles.debugClose}>
                <X size={20} color={colors.text} />
              </Pressable>
            </View>
            {finding ? <LyricsFinder media={media} pickedId={pickedId} shown={shown} onUse={onUseEntry} onAutomatic={onAutomatic} /> : <ScrollView style={styles.debugScroll} contentContainerStyle={styles.debugContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentInsetAdjustmentBehavior="never" directionalLockEnabled bounces={false} overScrollMode="never" indicatorStyle="white">
              <Text allowFontScaling={false} style={styles.debugHeading}>Sync</Text>
              <View style={styles.debugRow}>
                <Text allowFontScaling={false} style={styles.debugText}>offset: {sync.offsetMs === 0 ? 'none' : `${signedSeconds(sync.offsetMs)} (${sync.offsetMs < 0 ? 'lyrics later' : 'lyrics earlier'})`}</Text>
                {sync.offsetMs !== 0 ? <Pressable onPress={onResetOffset} hitSlop={6} accessibilityRole="button" accessibilityLabel="Reset the lyrics offset" style={styles.debugChip}><Text allowFontScaling={false} style={styles.debugChipText}>Reset</Text></Pressable> : null}
              </View>
              {sync.versions.length > 0 ? <>
                <Text allowFontScaling={false} style={styles.debugText}>timings found ({sync.picked ? 'picked by you' : !sync.synced ? 'none used: the lengths differ, so shown unsynced' : sync.reason ? `automatic: ${sync.reason}` : 'automatic'}):</Text>
                {sync.versions.map((version) => {
                  // Exactly one timing is ticked: the one on screen.
                  const shown = version === sync.shown;
                  return <Pressable key={`${version.firstMs}:${version.lastMs}`} onPress={() => onPickVersion(version)} accessibilityRole="button" accessibilityState={{ selected: shown }} accessibilityLabel={`Use the timing starting at ${(version.firstMs / 1000).toFixed(1)} seconds`} style={[styles.debugChip, shown && styles.debugChipSelected]}>
                    <Text allowFontScaling={false} style={styles.debugChipText}>{shown ? '✓ ' : ''}starts {(version.firstMs / 1000).toFixed(1)} s, ends {(version.lastMs / 1000).toFixed(1)} s · {version.entries} {version.entries === 1 ? 'entry' : 'entries'}{version === sync.auto ? ' · automatic' : ''}</Text>
                  </Pressable>;
                })}
                {sync.picked ? <Pressable onPress={() => onPickVersion(undefined)} accessibilityRole="button" accessibilityLabel="Go back to the automatic timing" style={styles.debugChip}><Text allowFontScaling={false} style={styles.debugChipText}>Back to automatic</Text></Pressable> : null}
              </> : null}
              <Text allowFontScaling={false} style={styles.debugHeading}>Lyrics</Text>
              <Text allowFontScaling={false} style={styles.debugText}>{pickedId !== undefined ? `using the entry you picked (LRCLIB #${pickedId})` : 'Wrong or missing lyrics? Search LRCLIB and pick the right entry.'}</Text>
              <Pressable onPress={() => setFinding(true)} accessibilityRole="button" accessibilityLabel="Find lyrics on LRCLIB" style={({ pressed }) => [styles.debugPrimary, pressed && { opacity: 0.76 }]}>
                <Search size={15} color={colors.onAccent} /><Text allowFontScaling={false} style={styles.debugPrimaryText}>Find lyrics</Text>
              </Pressable>
              {pickedId !== undefined ? <Pressable onPress={onAutomatic} hitSlop={6} accessibilityRole="button" accessibilityLabel="Go back to automatic lyrics" style={styles.debugChip}><Text allowFontScaling={false} style={styles.debugChipText}>Back to automatic</Text></Pressable> : null}
              {typedTitle ? <View style={styles.debugRow}>
                <Text allowFontScaling={false} style={styles.debugText}>searching with “{typedTitle}” instead of the PC’s title</Text>
                <Pressable onPress={() => onSearchTitle(undefined)} hitSlop={6} accessibilityRole="button" accessibilityLabel="Use the PC's title again" style={styles.debugChip}><Text allowFontScaling={false} style={styles.debugChipText}>Use PC title</Text></Pressable>
              </View> : null}
              <Text allowFontScaling={false} style={styles.debugHeading}>Details</Text>
              {rows.map((row, index) => <Text key={index} allowFontScaling={false} selectable style={styles.debugText}>{row}</Text>)}
            </ScrollView>}
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </SafeAreaProvider>
  </Modal>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  widget: { flex: 1, width: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', borderRadius: 6 },
  fill: { flex: 1, overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 8 },
  message: { color: colors.muted, fontWeight: '600', textAlign: 'center' },
  line: { color: colors.text, fontWeight: '700', textAlign: 'left' },
  plain: { color: colors.text, opacity: 0.85, fontWeight: '600' },
  dots: { flexDirection: 'row', alignItems: 'center' },
  syncControls: { position: 'absolute', alignItems: 'flex-end', gap: 2 },
  syncRow: { flexDirection: 'row', gap: 4 },
  syncButton: { alignItems: 'center', justifyContent: 'center', borderRadius: 999, backgroundColor: colors.floatSoft },
  offsetLabel: { color: colors.muted, fontWeight: '600', paddingHorizontal: 4, borderRadius: 6, backgroundColor: colors.floatSoft, overflow: 'hidden' },
  debugOverlay: { flex: 1, backgroundColor: colors.scrim },
  debugKeyboard: { flex: 1 },
  debugSafeArea: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  debug: { flex: 1, width: '100%', maxWidth: 560, maxHeight: '90%', minHeight: 0, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, overflow: 'hidden' },
  debugHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, paddingLeft: 16, paddingRight: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  debugTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '600' },
  debugClose: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  debugBack: { width: 40, height: 40, marginLeft: -12, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  debugPrimary: { height: 41, borderRadius: 5, backgroundColor: colors.accent, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  debugPrimaryText: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
  debugScroll: { flex: 1, minHeight: 0 },
  debugContent: { padding: 16, gap: 8 },
  debugText: { color: colors.text, fontSize: 11, lineHeight: 15, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  debugHeading: { color: colors.muted, fontSize: 11, fontWeight: '700', marginTop: 4, textTransform: 'uppercase' },
  debugRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  debugChip: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  debugChipSelected: { borderColor: colors.accent },
  debugChipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  plainHint: { color: colors.faint, fontWeight: '600', marginBottom: 8 },
});
