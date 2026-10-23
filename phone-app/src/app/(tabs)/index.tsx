import { useCallback, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useIsFocused, useRouter } from 'expo-router';
import { Animated, BackHandler, Easing, Image, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppWindow, ChevronLeft, ChevronRight, FolderClosed, Command, File, FolderOpen, Globe, Headphones, Keyboard, Layers2, ListOrdered, Maximize2, Mic, Minimize2, Monitor, Music, Package, Pencil, Check, Plus, TextCursorInput, PanelsTopLeft, Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX, Wifi } from 'lucide-react-native';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import * as ScreenOrientation from 'expo-screen-orientation';
import { NavigationBar } from 'expo-navigation-bar';
import { SvgXml } from 'react-native-svg';
import { DeckButton, DeckMediaCommand, DeckPlacement, DeckWidget, PlaybackState, SystemMediaState, livePositionMs, useMediaState, usePcConnection } from '../../connection';
import { nowPlayingLayout, NowPlayingRow } from '../../now-playing-layout';
import { LyricsWidget } from '../../lyrics-widget';
import { WebWidgetLayer, type WebWidget } from '../../web-widgets';
import { countRender, PerfOverlay } from '../../perf-overlay';
import { useDeckScreenPower } from '../../screen-power';
import { Wallpaper } from '../../wallpaper';
import { ButtonEditor, type EditTarget } from '../../button-editor';
import { DeckStack } from '../../deck-stack';
import { PuckRail, usePins } from '../../puck-rail';
import { buttonPlacement, surfaceOccupancy, type SurfaceItem } from '../../deck-layout';
import { useStyles, useTheme, type Colors } from '../../theme';
import { inkIcon, inkIconAs } from '../../theme-colors';
import { TabBarHiddenContext } from '../../navigation/tab-bar-context';
import { useTabBarClearance } from '../../tab-inset';
import { MediaToastView, PlayerSheet, SourceChip, useMediaSource } from '../../media-source';
import { playerColor, type PlayersState } from '../../media-players';
const appIcon = require('../../../assets/favicon.png') as number;

const shortcutIcons: Record<string, typeof Command> = {
  command: Command,
  monitor: Monitor,
  music: Music,
  mic: Mic,
  headphones: Headphones,
  'app-window': AppWindow,
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const TOUCH_LIGHT = 130;

// How each look's keys move. arrive: ms to deal a key in (0 is a spring), stagger: ms between keys, rise: px they
// travel up, grow: the scale they start at, depth: how far a press sinks, press: ms to sink (0 is instant or a spring).
const KEY_MOTION = {
  spring: { arrive: 0, stagger: 28, rise: 14, grow: 0.92, depth: 0.93, press: 0, easing: Easing.linear },
  glide: { arrive: 220, stagger: 18, rise: 6, grow: 1, depth: 0.97, press: 110, easing: Easing.out(Easing.cubic) },
  slow: { arrive: 720, stagger: 60, rise: 16, grow: 0.99, depth: 0.985, press: 280, easing: Easing.bezier(0.16, 1, 0.3, 1) },
  // A display redrawing: keys blink in over four hard steps.
  step: { arrive: 300, stagger: 40, rise: 0, grow: 1, depth: 0.95, press: 0, easing: (t: number) => Math.floor(t * 4) / 4 },
};

/** A deck key that sinks under the finger and springs back, animated on the native thread. */
function SpringKey({ style, launch, order = 0, onPress, children, ...props }: Omit<ComponentProps<typeof Pressable>, 'style' | 'children'> & { style: StyleProp<ViewStyle>; launch?: boolean; order?: number; children?: ReactNode }) {
  const { colors, key: design } = useTheme();
  const [scale] = useState(() => new Animated.Value(1));
  const [bloom] = useState(() => new Animated.Value(1));
  // Glass: a soft light sits under the finger and follows it across the key.
  const [lightAt] = useState(() => new Animated.ValueXY());
  const [lit] = useState(() => new Animated.Value(0));
  const follow = (x: number, y: number) => lightAt.setValue({ x: x - TOUCH_LIGHT / 2, y: y - TOUCH_LIGHT / 2 });
  const light = (on: boolean) => Animated.timing(lit, { toValue: on ? 1 : 0, duration: on ? 120 : 420, useNativeDriver: true }).start();
  // Keys arrive one after another when a page appears, like cards dealt onto the table.
  const [appear] = useState(() => new Animated.Value(0));
  const motion = KEY_MOTION[design.motion];
  useEffect(() => {
    const delay = Math.min(order, 12) * motion.stagger;
    (motion.arrive ? Animated.timing(appear, { toValue: 1, delay, duration: motion.arrive, easing: motion.easing, useNativeDriver: true })
      : Animated.spring(appear, { toValue: 1, delay, useNativeDriver: true, speed: 14, bounciness: 7 })).start();
  }, [appear, order, motion]);
  const to = (toValue: number) => (design.motion === 'spring' ? Animated.spring(scale, { toValue, useNativeDriver: true, speed: 40, bounciness: 7 })
    : Animated.timing(scale, { toValue, duration: motion.press, easing: Easing.out(Easing.cubic), useNativeDriver: true })).start();
  const fire: typeof onPress = (event) => {
    // Opening an app, file, folder or site: a ripple blooms from the key while the PC opens it.
    if (launch) {
      bloom.setValue(0);
      Animated.timing(bloom, { toValue: 1, duration: 560, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
    void Haptics.selectionAsync();
    onPress?.(event);
  };
  return <AnimatedPressable {...props} onPress={fire} style={[style, { opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [motion.rise, 0] }) }, { scale: Animated.multiply(scale, appear.interpolate({ inputRange: [0, 1], outputRange: [motion.grow, 1] })) }] }]}
    onPressIn={(event) => { to(motion.depth); if (design.touchLight) { follow(event.nativeEvent.locationX, event.nativeEvent.locationY); light(true); } }}
    onPressOut={() => { to(1); if (design.touchLight) light(false); }}
    onTouchMove={design.touchLight ? (event) => follow(event.nativeEvent.locationX, event.nativeEvent.locationY) : undefined}>
    {design.touchLight ? <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: TOUCH_LIGHT, height: TOUCH_LIGHT, borderRadius: TOUCH_LIGHT / 2, backgroundColor: design.touchLight, boxShadow: `0px 0px 40px 24px ${design.touchLight}`, opacity: lit.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] }), transform: lightAt.getTranslateTransform() }} /> : null}
    {launch ? <Animated.View pointerEvents="none" style={{ position: 'absolute', alignSelf: 'center', top: '50%', width: 160, height: 160, marginTop: -80, borderRadius: 80, backgroundColor: colors.accent, opacity: bloom.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }), transform: [{ scale: bloom.interpolate({ inputRange: [0, 1], outputRange: [0.1, 1.6] }) }] }} /> : null}
    {children}
  </AnimatedPressable>;
}

function controlIcon(button: DeckButton, playback: PlaybackState) {
  const { action } = button;
  if (button.icon !== 'auto' && !button.appIconData) return shortcutIcons[button.icon] ?? Command;
  if (action.type === 'media') {
    const media: Record<DeckMediaCommand, typeof Command> = {
      previous_track: SkipBack,
      play_pause: playback === 'playing' ? Pause : Play,
      next_track: SkipForward,
      volume_down: Volume1,
      volume_up: Volume2,
      mute: VolumeX,
    };
    return media[action.command];
  }
  if (action.type === 'launch_app') return AppWindow;
  if (action.type === 'launch_file') return File;
  if (action.type === 'launch_folder') return FolderOpen;
  if (action.type === 'run_script') return File;
  if (action.type === 'plugin_action') return Package;
  if (action.type === 'sequence') return ListOrdered;
  if (action.type === 'select_profile') return Layers2;
  if (action.type === 'select_page') return PanelsTopLeft;
  if (action.type === 'open_folder') return FolderClosed;
  if (action.type === 'type_text') return TextCursorInput;
  if (action.type === 'open_url') return Globe;
  return Keyboard;
}

function PluginTextWidget({ widget, immersive = false }: { widget: Extract<DeckWidget, { type: 'plugin' }>; immersive?: boolean }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const title = widget.values.title?.trim() ?? '';
  const body = widget.values.body?.trim() ?? '';
  const contentHeight = Math.max(20, (size.height || 84) - 12);
  const charsPerLine = Math.max(8, Math.floor((size.width || 92) / 8));
  const titleLines = title ? Math.min(2, Math.ceil(title.length / charsPerLine)) : 0;
  const bodyLines = body ? Math.min(6, Math.ceil(body.length / charsPerLine)) : 0;
  const lineHeight = Math.max(9, (contentHeight - (titleLines && bodyLines ? 4 : 0)) / Math.max(1, titleLines + bodyLines));
  const titleSize = Math.max(8, Math.min(24, (size.width || 92) * 0.09, lineHeight / 1.12));
  const bodySize = Math.max(7, Math.min(17, (size.width || 92) * 0.065, lineHeight / 1.2));
  if (widget.renderType !== 'text') return <View style={styles.pluginWidgetContent}><Package size={20} color={colors.muted} /><Text style={styles.pluginWidgetUnavailable}>Widget unavailable</Text></View>;
  return <View onLayout={(event) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1 ? current : { width, height });
  }} style={[styles.pluginWidgetContent, immersive && styles.immersivePluginWidgetContent]}>
    {title ? <Text allowFontScaling={false} numberOfLines={2} adjustsFontSizeToFit style={[styles.pluginWidgetTitle, { fontSize: titleSize, lineHeight: titleSize * 1.12 }]}>{title}</Text> : null}
    {body ? <Text allowFontScaling={false} numberOfLines={immersive ? 4 : 6} adjustsFontSizeToFit style={[styles.pluginWidgetBody, { fontSize: bodySize, lineHeight: bodySize * 1.2 }]}>{body}</Text> : null}
    {!title && !body ? <Text style={styles.pluginWidgetUnavailable}>Text widget</Text> : null}
  </View>;
}

function mediaTimeLabel(milliseconds: number | undefined) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return '--:--';
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

type ScrubBarProps = {
  value: number;
  disabled: boolean;
  height: number;
  trackHeight: number;
  knobSize: number;
  alwaysShowKnob?: boolean;
  hitSlop?: { top: number; bottom: number };
  accessibilityLabel: string;
  accessibilityValue: { min: number; max: number; now: number };
  accessibilityStep: number;
  onScrub?: (value: number) => void;
  onCommit: (value: number) => boolean;
};

// A bar you press and drag along; values are 0–1. Once it has the touch it refuses to hand it
// over, so the widget page swipe and the portrait scroll view can't cancel a scrub halfway.
function ScrubBar({ value, disabled, height, trackHeight, knobSize, alwaysShowKnob = false, hitSlop, accessibilityLabel, accessibilityValue, accessibilityStep, onScrub, onCommit }: ScrubBarProps) {
  const styles = useStyles(makeStyles);
  const [width, setWidth] = useState(1);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; value: number } | null>(null);
  // The responder is created once, so it reads the latest props through this ref.
  const latest = useRef({ width, disabled, onScrub, onCommit });
  useEffect(() => {
    latest.current = { width, disabled, onScrub, onCommit };
  });
  // After a release, keep showing the chosen value until the PC reports it (or 1.5 s pass).
  useEffect(() => {
    if (dragging || dragValue === null) return;
    const timeout = setTimeout(() => setDragValue(null), 1500);
    return () => clearTimeout(timeout);
  }, [dragValue, dragging]);
  // PanResponder calls these after render, when the refs hold the live gesture and props.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => {
    const update = (next: number) => {
      if (!drag.current) return;
      drag.current.value = next;
      setDragValue(next);
      latest.current.onScrub?.(next);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !latest.current.disabled,
      onMoveShouldSetPanResponder: () => !latest.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (event) => {
        const startX = event.nativeEvent.locationX;
        drag.current = { startX, value: 0 };
        setDragging(true);
        update(clampUnit(startX / latest.current.width));
      },
      // Track the finger from where it landed plus how far it moved; locationX alone jumps
      // when the finger slides over another view or off the bar.
      onPanResponderMove: (_, gesture) => {
        if (drag.current) update(clampUnit((drag.current.startX + gesture.dx) / latest.current.width));
      },
      onPanResponderRelease: () => {
        const finished = drag.current;
        drag.current = null;
        setDragging(false);
        if (finished && !latest.current.onCommit(finished.value)) setDragValue(null);
      },
      onPanResponderTerminate: () => {
        drag.current = null;
        setDragging(false);
        setDragValue(null);
      },
    });
  });
  const shown = dragValue !== null && (dragging || Math.abs(dragValue - value) >= 0.01) ? dragValue : value;
  const rail = dragging ? trackHeight * 1.8 : trackHeight;
  return <View accessibilityRole="adjustable" accessibilityLabel={accessibilityLabel} accessibilityValue={accessibilityValue} accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={(event) => {
    setDragValue(null);
    onCommit(clampUnit(value + (event.nativeEvent.actionName === 'increment' ? accessibilityStep : -accessibilityStep)));
  }} hitSlop={hitSlop} onLayout={(event) => setWidth(Math.max(1, event.nativeEvent.layout.width))} {...responder.panHandlers} style={[styles.scrubBar, { height }]}>
    <View pointerEvents="none" style={[styles.scrubRail, { height: rail, borderRadius: rail / 2 }]}><View style={[styles.scrubFill, { width: `${shown * 100}%` }]} /></View>
    {alwaysShowKnob || dragging ? <View pointerEvents="none" style={[styles.scrubKnob, { left: `${shown * 100}%`, width: knobSize, height: knobSize, marginLeft: -knobSize / 2, borderRadius: knobSize / 2 }]} /> : null}
  </View>;
}

function SystemVolumeSlider({ value, disabled, height, controlSize, labelSize, onChange, onInteract, onClose }: { value?: number; disabled: boolean; height: number; controlSize: number; labelSize: number; onChange: (value: number) => boolean; onInteract: () => void; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const lastSent = useRef(0);
  return <View style={[styles.nowPlayingVolume, { height, gap: controlSize * 0.3 }, disabled && styles.nowPlayingVolumeDisabled]}>
    <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Hide volume" style={[styles.nowPlayingControl, styles.nowPlayingVolumeClose, { width: controlSize, height: controlSize }]}>
      <Volume2 size={controlSize * 0.5} color={colors.blue} strokeWidth={1.8} />
    </Pressable>
    <View style={styles.nowPlayingVolumeTrack}><ScrubBar value={(value ?? 0) / 100} disabled={disabled} height={height} trackHeight={5} knobSize={Math.max(12, height * 0.36)} alwaysShowKnob accessibilityLabel="System volume" accessibilityValue={{ min: 0, max: 100, now: Math.round((scrubValue ?? (value ?? 0) / 100) * 100) }} accessibilityStep={0.05} onScrub={(next) => {
      setScrubValue(next);
      onInteract();
      // Live volume while scrubbing, at most every 100 ms; the release always sends the final value.
      const now = Date.now();
      if (now - lastSent.current >= 100) {
        lastSent.current = now;
        onChange(Math.round(next * 100));
      }
    }} onCommit={(next) => {
      setScrubValue(null);
      onInteract();
      return onChange(Math.round(next * 100));
    }} /></View>
    <Text allowFontScaling={false} style={[styles.nowPlayingVolumeLabel, { fontSize: labelSize, minWidth: labelSize * 3.4 }]}>{value === undefined ? '—' : `${Math.round(scrubValue !== null ? scrubValue * 100 : value)}%`}</Text>
  </View>;
}

// The PC sends the play position when it changes (play/pause, seek, track) and as a correction every
// ~10 s; in between, this counts it forward locally, re-rendering only Now Playing once a second.
function useLivePosition(media: SystemMediaState) {
  const playing = media.playbackState === 'playing';
  // A clock that only the timer moves; each report carries its own arrival time (receivedAt).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [playing]);
  // Right after a report `now` can be older than it; livePositionMs then shows the report as is.
  return livePositionMs(media, now);
}

function NowPlayingWidget({ media, connected, sendCommand, sendVolume, seekMedia, source }: { media: SystemMediaState; connected: boolean; sendCommand: (command: DeckMediaCommand) => boolean; sendVolume: (volumePercent: number) => boolean; seekMedia: (positionMs: number) => boolean; source?: { players: PlayersState | null; multiple: boolean; interactive: boolean; onPress: () => void } }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every size decision comes from the shared layout, which the desktop preview also uses.
  const layout = nowPlayingLayout(size.width || 92, size.height || 92);
  const hideVolume = useCallback(() => {
    if (volumeTimer.current) clearTimeout(volumeTimer.current);
    volumeTimer.current = null;
    setVolumeOpen(false);
  }, []);
  // The slider hides after 5 seconds without a touch; each interaction restarts the countdown.
  const keepVolumeOpen = useCallback(() => {
    if (volumeTimer.current) clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(hideVolume, 5000);
  }, [hideVolume]);
  useEffect(() => () => {
    if (volumeTimer.current) clearTimeout(volumeTimer.current);
  }, []);
  // Who is playing: the player the PC says the controls follow, else the app named in the media state.
  const controlled = source?.players?.players.find((player) => player.id === source.players?.controlling);
  const sourceName = controlled?.name ?? media.sourceName;
  const sourceInfo = source && sourceName ? { name: sourceName, color: playerColor(controlled?.id ?? media.sourceAppId ?? sourceName) } : null;
  const on = (row: NowPlayingRow) => layout.show.includes(row);
  const stacked = layout.mode !== 'row';
  const textAlign = stacked ? 'center' : 'left';
  const hasTrack = Boolean(media.title || media.artist || media.album);
  const supportingText = media.artist || media.album || (media.playbackState === 'unavailable' ? 'Waiting for media' : media.playbackState === 'paused' ? 'Paused' : 'System media');
  const duration = media.durationMs && media.durationMs > 0 ? media.durationMs : 0;
  const livePosition = useLivePosition(media);
  const currentPosition = duration ? Math.max(0, Math.min(duration, livePosition)) : livePosition;
  const progress = duration ? currentPosition / duration : 0;
  const canSeek = connected && Boolean(media.canSeek) && duration > 0;
  const artRadius = Math.max(5, layout.artSize * 0.13);
  const controlItems: { command: DeckMediaCommand; icon: typeof SkipBack; label: string; prominent?: boolean }[] = [
    { command: 'previous_track', icon: SkipBack, label: 'Previous track' },
    { command: 'play_pause', icon: media.playbackState === 'playing' ? Pause : Play, label: media.playbackState === 'playing' ? 'Pause' : 'Play', prominent: true },
    { command: 'next_track', icon: SkipForward, label: 'Next track' },
  ];
  return <View onLayout={(event) => {
    const { width: nextWidth, height: nextHeight } = event.nativeEvent.layout;
    setSize((current) => Math.abs(current.width - nextWidth) < 1 && Math.abs(current.height - nextHeight) < 1 ? current : { width: nextWidth, height: nextHeight });
  }} style={styles.nowPlayingWidget}>
    {media.artworkDataUrl ? <>
      <View pointerEvents="none" style={styles.nowPlayingBackdropFrame}><Image source={{ uri: media.artworkDataUrl }} style={styles.nowPlayingBackdrop} blurRadius={24} resizeMode="cover" /></View>
      <View pointerEvents="none" style={styles.nowPlayingBackdropTint} />
    </> : null}
    {sourceInfo && size.width >= 150 && size.height >= 90 ? <View pointerEvents="box-none" style={styles.sourceChipWrap}><SourceChip name={sourceInfo.name} color={sourceInfo.color} multiple={source?.multiple ?? false} interactive={source?.interactive ?? false} onPress={source!.onPress} /></View> : null}
    <View style={[styles.nowPlayingContent, { flexDirection: stacked ? 'column' : 'row', padding: layout.padding, gap: layout.gap }]}>
      {media.artworkDataUrl ? <Image source={{ uri: media.artworkDataUrl }} style={[styles.nowPlayingArtwork, { width: layout.artSize, height: layout.artSize, borderRadius: artRadius }]} resizeMode="cover" /> : <View style={[styles.nowPlayingFallback, { width: layout.artSize, height: layout.artSize, borderRadius: artRadius }]}><Music size={Math.max(12, layout.artSize * 0.43)} color={colors.blue} strokeWidth={1.7} /></View>}
      <View style={[styles.nowPlayingColumn, stacked ? styles.nowPlayingColumnStacked : styles.nowPlayingColumnRow, { gap: layout.gap }]}>
        <Text allowFontScaling={false} numberOfLines={1} style={[styles.nowPlayingTitle, { fontSize: layout.titleSize, lineHeight: layout.titleSize * 1.25, textAlign }]}>{hasTrack ? media.title || media.artist || media.album : 'No media'}</Text>
        {on('detail') ? <Text allowFontScaling={false} numberOfLines={1} style={[styles.nowPlayingDetail, { fontSize: layout.detailSize, lineHeight: layout.detailSize * 1.3, textAlign }]}>{supportingText}</Text> : null}
        {on('album') && media.album && media.album !== supportingText ? <Text allowFontScaling={false} numberOfLines={1} style={[styles.nowPlayingAlbum, { fontSize: layout.detailSize, lineHeight: layout.detailSize * 1.3, textAlign }]}>{media.album}</Text> : null}
        {on('progress') ? canSeek
          // Seeks once on release; the time label follows the finger while dragging.
          ? <ScrubBar value={progress} disabled={false} height={layout.barHeight + 2} trackHeight={layout.barHeight} knobSize={Math.max(12, layout.barHeight * 3)} hitSlop={{ top: 12, bottom: 12 }} accessibilityLabel="Playback position" accessibilityValue={{ min: 0, max: Math.round(duration / 1000), now: Math.round((scrubPosition ?? currentPosition) / 1000) }} accessibilityStep={Math.min(1, 10_000 / duration)} onScrub={(next) => setScrubPosition(next * duration)} onCommit={(next) => {
            setScrubPosition(null);
            return seekMedia(next * duration);
          }} />
          : <View style={[styles.nowPlayingProgressRow, { height: layout.barHeight + 2 }]}><View style={[styles.nowPlayingProgressTrack, { height: layout.barHeight }]}><View style={[styles.nowPlayingProgress, { width: `${progress * 100}%` }]} /></View></View> : null}
        {on('times') && duration > 0 ? <View style={styles.nowPlayingTimeLabels}>
          <Text allowFontScaling={false} style={[styles.nowPlayingTimeLabel, { fontSize: layout.timeSize, lineHeight: layout.timeSize * 1.3 }]}>{mediaTimeLabel(scrubPosition ?? currentPosition)}</Text>
          <Text allowFontScaling={false} style={[styles.nowPlayingTimeLabel, { fontSize: layout.timeSize, lineHeight: layout.timeSize * 1.3 }]}>{mediaTimeLabel(duration)}</Text>
        </View> : null}
        {on('controls') ? volumeOpen && layout.volumeButton
          ? <SystemVolumeSlider value={media.volumePercent} disabled={!connected || media.volumePercent === undefined} height={layout.primaryControlSize} controlSize={layout.controlSize} labelSize={layout.timeSize * 1.1} onChange={sendVolume} onInteract={keepVolumeOpen} onClose={hideVolume} />
          : <View style={[styles.nowPlayingControls, { height: layout.primaryControlSize, gap: layout.gap * 1.3 }]}>
            {controlItems.map(({ command, icon: Icon, label, prominent }) => {
              const box = prominent ? layout.primaryControlSize : layout.controlSize;
              return <Pressable key={command} onPress={() => sendCommand(command)} disabled={!connected} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.nowPlayingControl, prominent && styles.nowPlayingPrimaryControl, { width: box, height: box }, pressed && connected && styles.nowPlayingControlPressed, !connected && styles.nowPlayingControlDisabled]}>
                <Icon size={box * (prominent ? 0.55 : 0.5)} color={prominent ? colors.text : colors.muted} strokeWidth={1.8} />
              </Pressable>;
            })}
            {layout.volumeButton ? <Pressable onPress={() => { setVolumeOpen(true); keepVolumeOpen(); }} disabled={!connected} accessibilityRole="button" accessibilityLabel="Volume" style={({ pressed }) => [styles.nowPlayingControl, { width: layout.controlSize, height: layout.controlSize }, pressed && connected && styles.nowPlayingControlPressed, !connected && styles.nowPlayingControlDisabled]}>
              <Volume2 size={layout.controlSize * 0.5} color={colors.muted} strokeWidth={1.8} />
            </Pressable> : null}
          </View> : null}
      </View>
    </View>
  </View>;
}

// These subscribe to media state directly, so a position update re-renders them and nothing else.
function LiveNowPlaying(props: Omit<Parameters<typeof NowPlayingWidget>[0], 'media'>) {
  countRender('nowPlaying');
  return <NowPlayingWidget media={useMediaState()} {...props} />;
}
function LiveLyrics(props: Omit<Parameters<typeof LyricsWidget>[0], 'media'>) {
  countRender('lyrics');
  return <LyricsWidget media={useMediaState()} {...props} />;
}

// A row of pill buttons, scrolled so the selected one is in view (profiles and pages can be many).
function ChipRow({ label, items, selectedId, onSelect }: { label: string; items: { id: string; name: string }[]; selectedId?: string; onSelect: (id: string) => void }) {
  const styles = useStyles(makeStyles);
  const scroller = useRef<ScrollView>(null);
  const positions = useRef(new Map<string, number>());
  useEffect(() => {
    const x = selectedId ? positions.current.get(selectedId) : undefined;
    if (x !== undefined) scroller.current?.scrollTo({ x: Math.max(0, x - 18), animated: true });
  }, [selectedId]);
  return <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} style={styles.pageTabsScroll} contentContainerStyle={styles.pageTabs} accessibilityLabel={label}>
    {items.map((item) => <Pressable key={item.id} style={[styles.pageTab, item.id === selectedId && styles.pageTabActive]} onLayout={(event) => { positions.current.set(item.id, event.nativeEvent.layout.x); }} onPress={() => onSelect(item.id)} accessibilityRole="button" accessibilityLabel={`${label} ${item.name}`} accessibilityState={{ selected: item.id === selectedId }}>
      <Text style={[styles.pageTabText, item.id === selectedId && styles.pageTabTextActive]} numberOfLines={1}>{item.name}</Text>
    </Pressable>)}
  </ScrollView>;
}

export default function DeckScreen() {
  const { colors, scheme, look, key: design } = useTheme();
  // A key's surface in the chosen look; Bento deals its saturated blocks out to the keys in turn.
  const keySurface = (order: number) => {
    const tile = design.tiles?.[order % design.tiles.length];
    return {
      ink: tile?.[1] ?? design.ink,
      style: { borderRadius: design.radius, borderWidth: design.borderWidth, borderColor: design.border, backgroundColor: tile?.[0] ?? design.bg, boxShadow: design.shadow, overflow: design.touchLight ? 'hidden' as const : undefined },
    };
  };
  // Icons the PC saved as SVG are drawn in the dark deck's light ink; give them the key's ink.
  const svgInk = (svg: string, ink: string) => (look === 'classic' ? inkIcon(svg, scheme) : inkIconAs(svg, ink));
  const styles = useStyles(makeStyles);
  countRender('deck');
  const power = useDeckScreenPower();
  const router = useRouter();
  const isFocused = useIsFocused();
  const setTabBarHidden = useContext(TabBarHiddenContext);
  const { connection, status, playbackState, actionError, deckConfig, independentNavigation, selectedProfileId, selectedPageId, sendButton, sendMediaCommand, sendSystemVolume, seekMedia, selectPage, selectProfile, reportWidgetSurface } = usePcConnection();
  const [feedback, setFeedback] = useState('');
  const [immersive, setImmersive] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [showImmersiveTools, setShowImmersiveTools] = useState(false);
  const [immersiveSize, setImmersiveSize] = useState({ width: 0, height: 0 });
  // The folder open on each page, by `profile:page`. Folders open and close on this phone only.
  const [openFolders, setOpenFolders] = useState<Record<string, string>>({});
  const [regularGridWidth, setRegularGridWidth] = useState(0);
  const [regularGridHeight, setRegularGridHeight] = useState(0);
  const bottomClearance = useTabBarClearance();
  const window = useWindowDimensions();
  // Sideways there is no height to spare, so the rail stands beside the card instead of under it.
  const wide = window.width > window.height;
  const mediaSource = useMediaSource();
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const immersiveToolsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeProfile = deckConfig?.profiles.find((profile) => profile.id === (independentNavigation ? selectedProfileId : deckConfig.activeProfileId));
  const activePage = activeProfile?.pages.find((page) => page.id === (independentNavigation ? selectedPageId : activeProfile.activePageId));
  const activePageIndex = activeProfile?.pages.findIndex((page) => page.id === activePage?.id) ?? -1;
  const pageKey = `${activeProfile?.id}:${activePage?.id}`;
  const folder = activePage?.folders.find((entry) => entry.id === openFolders[pageKey]);
  // What is drawn: the open folder, else the page.
  const surface = folder ?? activePage;
  const openFolder = (folderId: string) => setOpenFolders((current) => ({ ...current, [pageKey]: folderId }));
  const closeFolder = useCallback(() => setOpenFolders((current) => { const { [pageKey]: _closed, ...rest } = current; return rest; }), [pageKey]);

  useEffect(() => () => {
    if (feedbackTimer.current) {
      clearTimeout(feedbackTimer.current);
      feedbackTimer.current = null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const setOrientation = async () => {
      try {
        // Full screen follows the phone too: portrait gives a tall deck, landscape a wide one.
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.DEFAULT);
      } catch {
        if (alive && immersive) {
          setImmersive(false);
          setFeedback('Landscape mode is unavailable on this device');
        }
      }
    };
    void setOrientation();
    return () => { alive = false; };
  }, [immersive]);

  useEffect(() => {
    setTabBarHidden(immersive);
    return () => setTabBarHidden(false);
  }, [immersive, setTabBarHidden]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    NavigationBar.setHidden(immersive);
    return () => NavigationBar.setHidden(false);
  }, [immersive]);

  // Android's back button closes an open folder before it does anything else.
  useEffect(() => {
    if (!folder || immersive || !isFocused) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { closeFolder(); return true; });
    return () => subscription.remove();
  }, [folder, immersive, isFocused, closeFolder]);

  useEffect(() => {
    if (!immersive) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setImmersive(false);
      setShowImmersiveTools(false);
      return true;
    });
    return () => subscription.remove();
  }, [immersive]);

  useEffect(() => () => {
    if (immersiveToolsTimer.current) clearTimeout(immersiveToolsTimer.current);
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.DEFAULT);
  }, []);

  const revealImmersiveTools = () => {
    setShowImmersiveTools(true);
    if (immersiveToolsTimer.current) clearTimeout(immersiveToolsTimer.current);
    immersiveToolsTimer.current = setTimeout(() => {
      immersiveToolsTimer.current = null;
      setShowImmersiveTools(false);
    }, 2800);
  };

  const pageSwipeResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gesture) => !folder && Math.abs(gesture.dx) > 38 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4,
    onPanResponderRelease: (_, gesture) => {
      const pages = activeProfile?.pages ?? [];
      if (pages.length < 2 || activePageIndex < 0) return;
      const nextIndex = (activePageIndex + (gesture.dx < 0 ? 1 : -1) + pages.length) % pages.length;
      selectPage(pages[nextIndex].id);
    },
  });
  const connected = status === 'connected';
  const isPlaying = playbackState === 'playing';
  const columns = surface?.columns ?? 3;
  const rows = surface?.rows ?? 2;
  const occupied = surface ? surfaceOccupancy(surface) : new Map<number, SurfaceItem>();
  const hasItems = occupied.size > 0;
  const hasWidgets = (surface?.widgets.length ?? 0) > 0;
  const regularGap = 9;
  const [canvasIn] = useState(() => new Animated.Value(1));
  const immersiveScreenId = immersive ? folder?.id ?? activePage?.id ?? '' : '';
  useEffect(() => {
    if (!immersiveScreenId) return;
    canvasIn.setValue(0);
    Animated.spring(canvasIn, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 5 }).start();
  }, [immersiveScreenId, canvasIn]);
  // Keys share the card's height, so a page fits without scrolling on any phone, tablet or rotation;
  // below 54 px a key gets too small to hit, and the card scrolls instead.
  const fitCellHeight = regularGridHeight > 0 ? (regularGridHeight - regularGap * (rows - 1)) / rows : 100;
  const regularCellHeight = Math.min(150, Math.max(54, fitCellHeight));
  const [pins, togglePin] = usePins(activeProfile?.id);
  const profileButtons = activeProfile?.pages.flatMap((page) => [...page.buttons, ...page.folders.flatMap((entry) => entry.buttons)]) ?? [];
  const pinnedButtons = pins.flatMap((id) => profileButtons.filter((button) => button.id === id && button.action.type !== 'open_folder'));
  const regularCellWidth = Math.max(0, (regularGridWidth - regularGap * (Math.max(1, columns) - 1)) / Math.max(1, columns));
  const immersiveGap = 10;
  const immersiveAvailableHeight = Math.max(0, immersiveSize.height - 24);
  const immersiveCellWidth = Math.max(0, (immersiveSize.width - 24 - immersiveGap * (columns - 1)) / columns);
  const immersiveCellHeight = Math.max(1, (immersiveAvailableHeight - 24 - immersiveGap * (rows - 1)) / rows);
  const immersiveIconSize = Math.min(52, Math.max(26, Math.min(immersiveCellHeight, immersiveCellWidth) * 0.34));
  // Widget keys inset their content by a 1 px border plus clockWidgetKey's 4 px padding.
  const widgetKeyInset = 5;
  const immersiveSurfaceWidth = immersiveSize.width - 24;
  const immersiveSurfaceHeight = immersiveAvailableHeight - 24;
  useEffect(() => {
    if (!hasWidgets) return;
    if (immersive) {
      if (immersiveSurfaceWidth > 0 && immersiveSurfaceHeight > 0) reportWidgetSurface({ width: immersiveSurfaceWidth, height: immersiveSurfaceHeight, gap: immersiveGap, inset: widgetKeyInset, fixedRowHeight: null });
    } else if (regularGridWidth > 0) {
      reportWidgetSurface({ width: regularGridWidth, height: 0, gap: regularGap, inset: widgetKeyInset, fixedRowHeight: regularCellHeight });
    }
  }, [immersive, immersiveSurfaceHeight, immersiveSurfaceWidth, reportWidgetSurface, hasWidgets, regularGridWidth, regularCellHeight]);
  const actionErrorText = actionError === 'accessibility_permission_required' ? 'Allow Open Dock in Mac Accessibility settings'
    : actionError === 'app_launch_failed' ? 'PC could not launch this app. Check its target path'
    : actionError === 'stale_revision' ? 'Deck changed. Wait for sync, then try again'
    : actionError === 'unknown_button' ? 'Button is out of date. Refresh the deck and try again'
    : actionError ? 'PC could not perform control' : '';

  const press = (button: DeckButton, label: string) => {
    if (button.action.type === 'open_folder') {
      openFolder(button.action.folderId);
      return;
    }
    if (!connected) {
      router.push('/connect');
      return;
    }
    if (sendButton(button.id)) {
      setFeedback(`${label} sent`);
      if (feedbackTimer.current) {
        clearTimeout(feedbackTimer.current);
      }
      feedbackTimer.current = setTimeout(() => {
        feedbackTimer.current = null;
        setFeedback('');
      }, 1600);
    } else {
      setFeedback('PC connection lost');
    }
  };

  const enterImmersive = () => setImmersive(true);

  const cellFrame = (row: number, column: number, rowSpan = 1, columnSpan = 1, cellWidth = regularCellWidth, cellHeight = regularCellHeight, gap = regularGap, inset = 0, offsetY = 0) => ({
    position: 'absolute' as const,
    left: inset + column * (cellWidth + gap),
    top: offsetY + inset + row * (cellHeight + gap),
    width: cellWidth * columnSpan + gap * (columnSpan - 1),
    height: cellHeight * rowSpan + gap * (rowSpan - 1),
  });

  // Clock and PC stats widgets are drawn by one WebView layer over the widget area (web-widgets.tsx);
  // their tiles provide only the border and background. Each rectangle is a tile's content area.
  const webWidgets = (frame: (placement: DeckPlacement) => { left: number; top: number; width: number; height: number }): WebWidget[] =>
    (surface?.widgets ?? []).flatMap((widget): WebWidget[] => {
      if (widget.type !== 'clock' && widget.type !== 'pc_stats') return [];
      const box = frame(widget.placement);
      const rect = { id: widget.id, x: box.left + widgetKeyInset, y: box.top + widgetKeyInset, width: Math.max(1, box.width - 2 * widgetKeyInset), height: Math.max(1, box.height - 2 * widgetKeyInset) };
      return widget.type === 'clock'
        ? [{ ...rect, kind: 'clock', face: widget.face, color: widget.color }]
        : [{ ...rect, kind: 'stats', face: widget.face, metric: widget.metric, color: widget.color, gpu: widget.gpu, columns: widget.placement.columnSpan, rows: widget.placement.rowSpan }];
    });

  // Every cell of the grid, buttons and widgets alike. `big` draws it for landscape mode.
  const renderCells = (big: boolean) => {
    const cellWidth = big ? immersiveCellWidth : regularCellWidth;
    const cellHeight = big ? immersiveCellHeight : regularCellHeight;
    const gap = big ? immersiveGap : regularGap;
    const inset = big ? 12 : 0;
    const iconSize = big ? immersiveIconSize : 21;
    const frame = (placement: DeckPlacement) => cellFrame(placement.row, placement.column, placement.rowSpan, placement.columnSpan, cellWidth, cellHeight, gap, inset);
    return Array.from({ length: rows * columns }, (_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const item = occupied.get(index);
      if (!item) {
        const emptyFrame = cellFrame(row, column, 1, 1, cellWidth, cellHeight, gap, inset);
        return big
          ? <Pressable key={`empty-${index}`} onPress={revealImmersiveTools} style={[styles.immersiveEmptyKey, emptyFrame]} accessibilityLabel="Empty deck slot. Tap to show deck controls" />
          : editing && activePage
            ? <Pressable key={`empty-${index}`} style={[styles.key, styles.emptyKey, styles.addCell, emptyFrame]} onPress={() => setEditTarget({ pageId: activePage.id, folderId: folder?.id, placement: { row, column, rowSpan: 1, columnSpan: 1 } })} accessibilityRole="button" accessibilityLabel="Add a button here"><Plus size={20} color={colors.muted} /></Pressable>
            : <View key={`empty-${index}`} style={[styles.key, styles.emptyKey, emptyFrame]} />;
      }
      if (item.type === 'widget') {
        const placement = item.widget.placement;
        if (placement.row !== row || placement.column !== column) return null;
        return <View key={item.widget.id} style={[big ? styles.immersiveKey : styles.key, design.tiles ? { borderRadius: design.radius, borderWidth: 0, backgroundColor: colors.panel } : keySurface(0).style, styles.clockWidgetKey, frame(placement)]}>{item.widget.type === 'clock' || item.widget.type === 'pc_stats' ? null : item.widget.type === 'now_playing' ? <LiveNowPlaying connected={connected} sendCommand={sendMediaCommand} sendVolume={sendSystemVolume} seekMedia={seekMedia} source={{ players: mediaSource.players, multiple: mediaSource.multiple, interactive: mediaSource.canSwitch, onPress: mediaSource.openSheet }} /> : item.widget.type === 'lyrics' ? <LiveLyrics connected={connected} focused={isFocused} seekMedia={seekMedia} /> : <PluginTextWidget widget={item.widget} immersive={big} />}</View>;
      }
      const button = item.button;
      const placement = buttonPlacement(columns, button, surface?.buttons.indexOf(button) ?? 0);
      if (placement.row !== row || placement.column !== column) return null;
      const isFolder = button.action.type === 'open_folder';
      const isMediaKey = button.action.type === 'media' && ['play_pause', 'next_track', 'previous_track'].includes(button.action.command);
      const dynamicPlay = button.icon === 'auto' && button.action.type === 'media' && button.action.command === 'play_pause';
      const label = dynamicPlay ? (isPlaying ? 'Pause' : 'Play') : button.label;
      const Icon = controlIcon(button, playbackState);
      const order = placement.row * columns + placement.column;
      const surfaceLook = keySurface(order);
      return <SpringKey key={button.id} order={order} launch={!editing && ['launch_app', 'launch_file', 'launch_folder', 'open_url', 'open_folder'].includes(button.action.type)} style={[big ? styles.immersiveKey : styles.key, surfaceLook.style, frame(placement), editing && !big && styles.editingKey, !connected && !isFolder && styles.keyDisabled]} onPress={() => editing && !big && activePage ? setEditTarget({ pageId: activePage.id, folderId: folder?.id, button, placement }) : press(button, label)} onLongPress={editing && !big && !isFolder ? () => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); togglePin(button.id); } : isMediaKey && connected && mediaSource.canSwitch ? mediaSource.openSheet : undefined} delayLongPress={450} disabled={!connected && !isFolder} accessibilityRole="button" accessibilityLabel={isFolder ? `${label}, folder` : label} accessibilityHint={isMediaKey && mediaSource.multiple ? 'Long press to choose a media player' : undefined}>
        {isMediaKey && mediaSource.multiple ? <View pointerEvents="none" style={styles.mediaKeyDot} /> : null}
        {editing && !big && pins.includes(button.id) ? <View pointerEvents="none" style={styles.pinDot} /> : null}
        {button.appIconData ? <Image source={{ uri: button.appIconData }} style={big ? { width: iconSize, height: iconSize } : styles.appIcon} resizeMode="contain" /> : button.iconSvg && button.icon !== 'auto' ? <SvgXml xml={svgInk(button.iconSvg, surfaceLook.ink)} width={iconSize} height={iconSize} /> : <Icon size={iconSize} color={surfaceLook.ink} strokeWidth={design.iconStroke} />}
        {big ? null : <Text style={[styles.keyLabel, { color: surfaceLook.ink, fontFamily: design.font, fontSize: design.labelSize, fontWeight: design.labelWeight, lineHeight: Math.round(design.labelSize * 1.2), letterSpacing: design.tracking ?? (design.tiles ? -0.4 : 0) }]} numberOfLines={2}>{design.caps ? label.toUpperCase() : label}</Text>}
      </SpringKey>;
    });
  };

  if (immersive) {
    return <>
      <StatusBar hidden style="auto" />
      <SafeAreaView {...power.touchProps} style={styles.immersiveSafe} edges={['top', 'right', 'bottom', 'left']} onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setImmersiveSize((current) => current.width === width && current.height === height ? current : { width, height });
      }}>
        <Wallpaper />
        <Pressable style={styles.immersiveBackdrop} onPress={revealImmersiveTools} accessibilityLabel="Deck background. Tap for controls" />
        <View style={styles.immersiveGrid} pointerEvents="box-none">
          {surface ? <Animated.View style={[styles.immersiveDeckCanvas, { top: 12, height: immersiveAvailableHeight, opacity: canvasIn, transform: [{ scale: canvasIn.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }]} {...pageSwipeResponder.panHandlers}>
            {renderCells(true)}
            <WebWidgetLayer focused={isFocused} widgets={webWidgets((p) => cellFrame(p.row, p.column, p.rowSpan, p.columnSpan, immersiveCellWidth, immersiveCellHeight, immersiveGap, 12, 0))} />
          </Animated.View> : null}
        </View>
        {showImmersiveTools ? <View style={styles.immersiveTools}>
          {folder ? <Pressable style={styles.immersiveExit} onPress={() => { closeFolder(); revealImmersiveTools(); }} accessibilityRole="button" accessibilityLabel="Close folder"><ChevronLeft size={19} color={colors.text} /></Pressable> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.immersivePageTools}>
            {(activeProfile?.pages ?? []).map((page, index) => <Pressable key={page.id} onPress={() => { selectPage(page.id); revealImmersiveTools(); }} style={[styles.immersivePageButton, index === activePageIndex && styles.pageTabActive]} accessibilityRole="button" accessibilityLabel={`Show ${page.name} page`} accessibilityState={{ selected: index === activePageIndex }}>
              <Text style={[styles.pageTabText, index === activePageIndex && styles.pageTabTextActive]}>{page.name}</Text>
            </Pressable>)}
          </ScrollView>
          <Pressable style={styles.immersiveExit} onPress={() => { setImmersive(false); setShowImmersiveTools(false); }} accessibilityRole="button" accessibilityLabel="Exit immersive mode"><Minimize2 size={19} color={colors.text} /></Pressable>
        </View> : null}
        <MediaToastView toast={mediaSource.toast} bottom={12} onSwitch={(player) => mediaSource.choose(player.id, player.name)} onDismiss={mediaSource.dismissToast} />
        <PlayerSheet visible={mediaSource.sheetOpen} landscape state={mediaSource.players} onChoose={mediaSource.choose} onClose={mediaSource.closeSheet} />
      </SafeAreaView>
      <PerfOverlay />
      {power.overlay}
    </>;
  }

  return (
    <SafeAreaView {...power.touchProps} style={styles.safe} edges={['top']}>
      <StatusBar style="auto" />
      <Wallpaper />
      <View style={[styles.screen, { paddingBottom: bottomClearance + 6 }]}>
        <View style={styles.header}>
          <View style={styles.brand}><Image source={appIcon} style={styles.brandIcon} accessibilityIgnoresInvertColors /><Text style={styles.brandName}>Open Dock</Text></View>
          <View style={styles.headerActions}>
          {connected && activePage ? <Pressable style={[styles.immersiveToggle, editing && styles.editToggleOn]} onPress={() => setEditing((on) => !on)} accessibilityRole="button" accessibilityLabel={editing ? 'Done editing' : 'Edit deck'}>{editing ? <Check size={17} color={colors.onAccent} /> : <Pencil size={16} color={colors.muted} />}</Pressable> : null}
          <Pressable style={styles.immersiveToggle} onPress={enterImmersive} accessibilityRole="button" accessibilityLabel="Enter full-screen deck"><Maximize2 size={17} color={colors.muted} /></Pressable>
          <Pressable style={styles.connectionPill} onPress={() => router.push('/connect')} accessibilityRole="button" accessibilityLabel={`PC ${connected ? 'connected' : 'disconnected'}. Open connection settings`}>
            <View style={[styles.dot, connected ? styles.dotOnline : styles.dotOffline]} />
            <Text style={styles.connectionText} numberOfLines={1}>{connected ? (connection?.deviceName ?? 'Connected') : 'Connect PC'}</Text>
            <ChevronRight size={14} color={colors.faint} />
          </Pressable>
          </View>
        </View>

        {deckConfig && deckConfig.profiles.length > 1 ? <ChipRow label="Profile" items={deckConfig.profiles} selectedId={activeProfile?.id} onSelect={(id) => void selectProfile(id)} /> : null}
        {!connected && <Pressable style={styles.connectBanner} onPress={() => router.push('/connect')} accessibilityRole="button">
          <Monitor size={18} color={colors.muted} />
          <View style={styles.bannerCopy}><Text style={styles.bannerTitle}>Connect your PC</Text><Text style={styles.bannerSub}>Scan the QR code in Open Dock for desktop</Text></View>
          <ChevronRight size={16} color={colors.faint} />
        </Pressable>}

        {folder ? <View style={styles.sectionRow}>
          <Pressable style={styles.backButton} onPress={closeFolder} accessibilityRole="button" accessibilityLabel={`Back to ${activePage?.name}`}><ChevronLeft size={16} color={colors.muted} /><Text style={styles.backText} numberOfLines={1}>{activePage?.name}</Text></Pressable>
        </View> : null}
        {editing ? <Text style={styles.editHint}>Tap a key to change it, + to add one, long-press to pin it to the rail.</Text> : null}
        <View style={[styles.deckRow, wide && styles.deckRowWide]}>
        <View style={styles.stackArea}>
          {surface ? <DeckStack pages={(folder ? [{ id: folder.id, name: folder.name }] : activeProfile?.pages ?? [])} index={folder ? 0 : Math.max(0, activePageIndex)} onChange={(at) => { const page = activeProfile?.pages[at]; if (page && !folder) void selectPage(page.id); }}>
            <ScrollView scrollEnabled={fitCellHeight < 54} showsVerticalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }} onLayout={(event) => {
              const height = event.nativeEvent.layout.height;
              setRegularGridHeight((current) => Math.abs(current - height) < 0.5 ? current : height);
            }}>
              {hasItems || editing ? <View style={[styles.grid, { height: rows * regularCellHeight + Math.max(0, rows - 1) * regularGap }]} onLayout={(event) => {
                const width = event.nativeEvent.layout.width;
                setRegularGridWidth((current) => Math.abs(current - width) < 0.5 ? current : width);
              }}>
                {renderCells(false)}
                <WebWidgetLayer focused={isFocused} widgets={webWidgets((p) => cellFrame(p.row, p.column, p.rowSpan, p.columnSpan, regularCellWidth, regularCellHeight))} />
              </View> : <View style={styles.emptyDeck}><Command size={20} color={colors.faint} /><Text style={styles.emptyDeckText}>{folder ? 'This folder is empty.' : 'This page is empty.'}{'\n'}Tap the pencil to add keys.</Text></View>}
            </ScrollView>
          </DeckStack> : <View style={styles.emptyDeck}><Command size={20} color={colors.faint} /><Text style={styles.emptyDeckText}>{connected ? 'The desktop has no active deck page.' : 'Connect to a PC to load its deck.'}</Text></View>}
        </View>
        <View style={[styles.railRow, wide && styles.railSide]}>
          <PuckRail vertical={wide} pinned={pinnedButtons} playing={isPlaying} connected={connected} sendMedia={(command) => { sendMediaCommand(command); }} onPress={(button) => press(button, button.label)}
            renderIcon={(button, size) => { const Icon = controlIcon(button, playbackState); return button.appIconData ? <Image source={{ uri: button.appIconData }} style={{ width: size, height: size }} resizeMode="contain" /> : <Icon size={size} color={colors.text} strokeWidth={1.8} />; }} />
        </View>
        </View>
        {wide ? null : <View style={[styles.feedbackRow, styles.feedbackCompact]}>
          {actionError ? <><Wifi size={13} color={colors.faint} /><Text style={styles.feedbackText}>{actionErrorText}</Text></> : feedback ? <><View style={styles.feedbackDot} /><Text style={styles.feedbackText}>{feedback}</Text></> : <><Wifi size={13} color={colors.faint} /><Text style={styles.feedbackText}>{connected ? 'Ready to send controls' : 'Connect to enable controls'}</Text></>}
        </View>}
      </View>
      <MediaToastView toast={mediaSource.toast} bottom={bottomClearance} onSwitch={(player) => mediaSource.choose(player.id, player.name)} onDismiss={mediaSource.dismissToast} />
      {editTarget ? <ButtonEditor key={editTarget.button?.id ?? `${editTarget.placement.row}-${editTarget.placement.column}`} target={editTarget} onClose={() => setEditTarget(null)} /> : null}
      <PlayerSheet visible={mediaSource.sheetOpen} landscape={false} state={mediaSource.players} onChoose={mediaSource.choose} onClose={mediaSource.closeSheet} />
      <PerfOverlay />
      {power.overlay}
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  immersiveSafe: { flex: 1, backgroundColor: colors.bg },
  immersiveBackdrop: { ...StyleSheet.absoluteFill },
  immersiveGrid: { ...StyleSheet.absoluteFill },
  immersiveDeckCanvas: { position: 'absolute', left: 0, right: 0 },
  immersiveKey: { borderRadius: 16, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass, alignItems: 'center', justifyContent: 'center' },
  clockWidgetKey: { padding: 4, alignItems: 'center', justifyContent: 'center' },
  pluginWidgetContent: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 3, overflow: 'hidden' },
  immersivePluginWidgetContent: { gap: 7, paddingHorizontal: 8 },
  pluginWidgetTitle: { width: '100%', flexShrink: 1, color: colors.text, fontWeight: '600', textAlign: 'center', includeFontPadding: false },
  pluginWidgetBody: { width: '100%', flexShrink: 1, color: colors.muted, textAlign: 'center', includeFontPadding: false },
  pluginWidgetUnavailable: { color: colors.muted, fontSize: 10, textAlign: 'center' },
  sourceChipWrap: { position: 'absolute', top: 6, right: 6, zIndex: 5 },
  mediaKeyDot: { position: 'absolute', top: 7, right: 7, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.star },
  nowPlayingWidget: { flex: 1, width: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', borderRadius: 6 },
  nowPlayingContent: { flex: 1, minWidth: 0, minHeight: 0, alignItems: 'center', justifyContent: 'center' },
  nowPlayingBackdropFrame: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  nowPlayingBackdrop: { ...StyleSheet.absoluteFill, opacity: colors.artOpacity },
  nowPlayingBackdropTint: { ...StyleSheet.absoluteFill, backgroundColor: colors.tint },
  nowPlayingArtwork: { flexShrink: 0, backgroundColor: colors.panelRaised },
  nowPlayingFallback: { flexShrink: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panelRaised, borderWidth: 1, borderColor: colors.border },
  nowPlayingColumn: { minWidth: 0, justifyContent: 'center' },
  nowPlayingColumnStacked: { width: '100%' },
  nowPlayingColumnRow: { flex: 1 },
  nowPlayingTitle: { width: '100%', color: colors.text, fontWeight: '600', includeFontPadding: false },
  nowPlayingDetail: { width: '100%', color: colors.muted, includeFontPadding: false },
  nowPlayingAlbum: { width: '100%', color: colors.faint, includeFontPadding: false },
  nowPlayingProgressRow: { width: '100%', justifyContent: 'center' },
  nowPlayingProgressTrack: { width: '100%', overflow: 'hidden', borderRadius: 3, backgroundColor: colors.border },
  nowPlayingProgress: { height: '100%', borderRadius: 3, backgroundColor: colors.blue },
  nowPlayingTimeLabels: { width: '100%', flexDirection: 'row', justifyContent: 'space-between' },
  nowPlayingTimeLabel: { color: colors.faint, fontVariant: ['tabular-nums'], includeFontPadding: false },
  nowPlayingControls: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  nowPlayingControl: { alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  nowPlayingPrimaryControl: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  nowPlayingControlPressed: { backgroundColor: colors.border },
  nowPlayingControlDisabled: { opacity: 0.4 },
  nowPlayingVolume: { width: '100%', flexDirection: 'row', alignItems: 'center' },
  nowPlayingVolumeDisabled: { opacity: 0.45 },
  nowPlayingVolumeClose: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised },
  scrubBar: { alignSelf: 'stretch', justifyContent: 'center' },
  nowPlayingVolumeTrack: { flex: 1 },
  scrubRail: { width: '100%', overflow: 'hidden', backgroundColor: colors.border },
  scrubFill: { height: '100%', backgroundColor: colors.blue },
  scrubKnob: { position: 'absolute', borderWidth: 2, borderColor: colors.text, backgroundColor: colors.blue },
  nowPlayingVolumeLabel: { color: colors.muted, fontVariant: ['tabular-nums'], textAlign: 'right', includeFontPadding: false },
  immersiveEmptyKey: { borderRadius: 10, backgroundColor: 'transparent' },
  immersiveEmptyDeck: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  immersiveTools: { position: 'absolute', top: 8, left: 20, right: 20, minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 5, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.float },
  immersivePageTools: { flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  immersivePageButton: { height: 30, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 5 },
  immersiveExit: { width: 34, height: 34, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  content: { flexGrow: 1, paddingHorizontal: 18, paddingBottom: 24 },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  headerActions: { flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  immersiveToggle: { flexShrink: 0, width: 34, height: 34, borderWidth: 1, borderColor: colors.border, borderRadius: 6, backgroundColor: colors.panel, alignItems: 'center', justifyContent: 'center' },
  brandIcon: { width: 22, height: 22 },
  brand: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandName: { color: colors.text, fontWeight: '600', fontSize: 14 },
  connectionPill: { flexShrink: 1, minWidth: 0, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, borderRadius: 6, paddingHorizontal: 9, minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 5 },
  dotOnline: { backgroundColor: colors.mint },
  dotOffline: { backgroundColor: colors.faint },
  connectionText: { flexShrink: 1, minWidth: 0, fontSize: 13, color: colors.muted, fontWeight: '500' },
  titleRow: { marginTop: 18, marginBottom: 15 },
  title: { color: colors.text, fontWeight: '600', fontSize: 23, letterSpacing: -0.3 },
  subtitle: { color: colors.muted, fontSize: 14, marginTop: 5 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  managePages: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 5, paddingHorizontal: 7, borderRadius: 5, borderWidth: 1, borderColor: colors.border },
  managePagesText: { color: colors.muted, fontSize: 12 },
  pageTabsScroll: { flexGrow: 0, flexShrink: 0 },
  pageTabs: { flexDirection: 'row', gap: 6, paddingBottom: 16 },
  pageTab: { minHeight: 29, maxWidth: 180, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 15, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  pageTabActive: { backgroundColor: colors.pressed, borderColor: colors.borderActive },
  pageTabText: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  pageTabTextActive: { color: colors.text },
  connectBanner: { minHeight: 57, borderRadius: 16, paddingHorizontal: 12, marginBottom: 20, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder, flexDirection: 'row', alignItems: 'center', gap: 11 },
  bannerCopy: { flex: 1 },
  bannerTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  bannerSub: { color: colors.muted, fontSize: 12, marginTop: 4 },
  sectionTitle: { flexShrink: 1, color: colors.muted, fontSize: 14, fontWeight: '500' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 4, paddingRight: 8 },
  backText: { flexShrink: 1, maxWidth: 140, color: colors.muted, fontSize: 14 },
  grid: { position: 'relative' },
  key: { minHeight: 100, borderRadius: 16, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass, padding: 11, justifyContent: 'space-between' },
  emptyKey: { borderStyle: 'dashed', backgroundColor: 'transparent', opacity: 0.45 },
  appIcon: { width: 23, height: 23 },
  keyDisabled: { opacity: 0.52 },
  editingKey: { borderWidth: 1.5, borderColor: colors.accent },
  pinDot: { position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  screen: { flex: 1, paddingHorizontal: 16 },
  stackArea: { flex: 1, marginTop: 6, marginBottom: 8 },
  railRow: { paddingTop: 4 },
  railSide: { paddingTop: 0, justifyContent: 'center' },
  deckRow: { flex: 1 },
  deckRowWide: { flexDirection: 'row', gap: 12 },
  addCell: { alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed', borderColor: colors.borderStrong },
  editToggleOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  editHint: { color: colors.muted, fontSize: 13, marginBottom: 10 },
  keyLabel: { color: colors.text, fontSize: 13, fontWeight: '500', lineHeight: 14 },
  shortcutHint: { color: colors.faint, fontSize: 11, marginTop: -4 },
  addKey: { alignItems: 'flex-start', justifyContent: 'space-between', borderStyle: 'dashed', backgroundColor: 'transparent' },
  addLabel: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  feedbackCompact: { minHeight: 24, marginTop: 6 },
  feedbackRow: { minHeight: 40, marginTop: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  emptyDeckText: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  emptyDeck: { minHeight: 150, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24, paddingVertical: 28, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.panel },
  feedbackDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.mint },
  feedbackText: { color: colors.faint, fontSize: 13 },
});
