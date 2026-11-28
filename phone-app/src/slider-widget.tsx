import { useEffect, useRef, useState } from 'react';
import { Image, PanResponder, Text, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { AppWindow, Mic, MicOff, Sun, Volume2, VolumeX } from 'lucide-react-native';
import { useMediaState, useSystemMuted, type DeckMediaCommand, type LevelReply } from './connection';
import { Pressable } from './motion';
import { useTheme } from './theme';
import { fade } from './wallpaper';

export const SLIDER_LOOKS = ['bar', 'pill', 'vertical', 'ring', 'notch'] as const;

type Props = {
  face?: string; app?: string; look?: string; color?: string; connected: boolean;
  sendVolume: (value: number) => boolean; sendBrightness: (value: number) => boolean;
  sendAppVolume: (app: string, value: number) => boolean; requestLevel: (target: string, icon?: boolean) => Promise<LevelReply>;
  sendLevel: (target: string, value: number) => boolean; toggleMute: (target: string) => boolean; sendMediaCommand: (command: DeckMediaCommand) => boolean;
};

// A dial for the PC's volume, the microphone, screen brightness or one app's volume, in one of five designs.
// Tapping its icon mutes it (not brightness); an app dial shows the app's own icon. Brightness and
// app levels are read from the PC when the dial appears (apps again every 5 s, as they start and stop playing).
// An app dial with no app of its own follows the app in focus on the PC, checked every 1.5 s.
export function SliderWidget({ face, app, look = 'bar', color, connected, sendVolume, sendBrightness, sendAppVolume, requestLevel, sendLevel, toggleMute, sendMediaCommand }: Props) {
  const { colors } = useTheme();
  const brightness = face === 'brightness';
  const perApp = face === 'app';
  const mic = face === 'mic';
  const volume = useMediaState().volumePercent;
  const systemMuted = useSystemMuted();
  const [level, setLevel] = useState<number | undefined>(undefined);
  const [readMuted, setReadMuted] = useState<boolean | undefined>(undefined);
  const [appIcon, setAppIcon] = useState<string | undefined>(undefined);
  // The icon is sent once per app: asked for again only when the app in focus changes.
  const iconFor = useRef<string | undefined>(undefined);
  const [focusedApp, setFocusedApp] = useState<string | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrub, setScrub] = useState<number | null>(null);
  const dragging = useRef(false);
  const target = brightness ? 'brightness' : mic ? 'mic' : perApp ? app ? `app:${app}` : 'app-focused' : null;
  useEffect(() => {
    if (!connected || !target) return;
    let live = true;
    // Not while a finger is on the dial, so a reply doesn't yank it back.
    let wantIcon = perApp;
    const read = () => {
      if (dragging.current) return;
      void requestLevel(target, wantIcon).then((next) => {
        if (!live) return;
        setLevel(next.level ?? undefined);
        setReadMuted(next.muted);
        setFocusedApp(next.app);
        const shownApp = next.app ?? app;
        if (next.icon) { setAppIcon(next.icon); iconFor.current = shownApp; wantIcon = false; }
        else if (perApp && shownApp !== iconFor.current) wantIcon = true;
      });
    };
    read();
    const timer = perApp || mic ? setInterval(read, perApp && !app ? 1500 : 5000) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [connected, target, perApp, mic, app, requestLevel]);
  const muted = target ? readMuted : systemMuted;
  const muteTarget = mic ? 'mic' : perApp ? app ? `app:${app}` : 'app-focused' : null;
  const tapMute = () => {
    if (brightness) return;
    setReadMuted((now) => now === undefined ? now : !now);
    if (muteTarget) toggleMute(muteTarget); else sendMediaCommand('mute');
  };

  const value = target ? level : volume;
  const disabled = !connected || value === undefined;
  const send = (next: number) => {
    if (target) setLevel(next);
    // An empty app tells the PC to use the app in focus.
    return brightness ? sendBrightness(next) : mic ? sendLevel('mic', next) : perApp ? sendAppVolume(app ?? '', next) : sendVolume(next);
  };
  const vertical = look === 'vertical' || look === 'ring';

  // The responder is made once; it reads what changes through this ref, refreshed after each render.
  const latest = useRef({ size, value, disabled, send, look, brightness, lastSent: 0, start: 0 });
  useEffect(() => {
    latest.current = { ...latest.current, size, value, disabled, send, look, brightness };
  });
  // PanResponder calls these after render, when the ref holds the live props.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => {
    // Bars follow the finger to where it is; the ring turns by how far the finger moved (a full turn per 160 px).
    const at = (event: GestureResponderEvent, dx: number, dy: number) => {
      const { size: box, look: kind, start } = latest.current;
      if (kind === 'ring') return start - dy / 160 + dx / 320;
      return kind === 'vertical' ? 1 - event.nativeEvent.locationY / Math.max(1, box.height) : event.nativeEvent.locationX / Math.max(1, box.width);
    };
    const clamp = (next: number) => Math.round(Math.max(0, Math.min(1, next)) * 100) / 100;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !latest.current.disabled,
      onMoveShouldSetPanResponder: () => !latest.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        dragging.current = true;
        latest.current.start = (latest.current.value ?? 0) / 100;
        if (latest.current.look !== 'ring') setScrub(clamp(at(event, 0, 0)));
        else setScrub(latest.current.start);
      },
      onPanResponderMove: (event, gesture) => {
        const next = clamp(at(event, gesture.dx, gesture.dy));
        setScrub(next);
        // Volume follows the finger (every 100 ms); brightness talks to the monitor, so only on release.
        const now = Date.now();
        if (!latest.current.brightness && now - latest.current.lastSent >= 100) {
          latest.current.lastSent = now;
          latest.current.send(Math.round(next * 100));
        }
      },
      onPanResponderRelease: (event, gesture) => {
        dragging.current = false;
        const next = clamp(at(event, gesture.dx, gesture.dy));
        setScrub(null);
        latest.current.send(Math.round(next * 100));
      },
      onPanResponderTerminate: () => { dragging.current = false; setScrub(null); },
    });
  });

  const shown = scrub ?? (value ?? 0) / 100;
  const percent = value === undefined && scrub === null ? '—' : `${Math.round(shown * 100)}%`;
  const accent = muted ? colors.muted : color ?? colors.blue;
  const unit = Math.max(22, Math.min(vertical ? size.width / 2 : size.height, (vertical ? size.height : size.width) / 4) || 40);
  const Icon = brightness ? Sun : mic ? muted ? MicOff : Mic : muted ? VolumeX : perApp ? AppWindow : Volume2;
  const name = perApp ? app ?? focusedApp ?? 'App in focus' : null;
  const label = brightness ? 'PC brightness' : mic ? 'Microphone' : perApp ? `${name} volume` : 'PC volume';
  const glyph = (tint: string) => perApp && appIcon && !muted
    ? <Image source={{ uri: appIcon }} style={{ width: unit * 0.56, height: unit * 0.56 }} accessibilityIgnoresInvertColors />
    : <Icon size={unit * 0.5} color={tint} strokeWidth={1.8} />;
  const icon = (tint: string) => brightness ? glyph(tint)
    : <Pressable onPress={tapMute} disabled={!connected} hitSlop={8} accessibilityRole="button" accessibilityLabel={muted ? `Unmute ${label}` : `Mute ${label}`}>{glyph(tint)}</Pressable>;
  const caption = (tint: string, scale = 1) => <View style={{ alignItems: vertical ? 'center' : 'flex-end' }}>
    <Text allowFontScaling={false} style={{ color: tint, fontSize: unit * 0.34 * scale, fontWeight: '600', fontVariant: ['tabular-nums'], includeFontPadding: false }}>{percent}</Text>
    {name ? <Text allowFontScaling={false} numberOfLines={1} style={{ color: tint, opacity: 0.75, fontSize: unit * 0.22 * scale, maxWidth: unit * 2.4 }}>{name}</Text> : null}
  </View>;

  let body;
  if (look === 'pill' || look === 'vertical') {
    // One big capsule that fills as it goes up; icon and level sit inside it.
    const radius = Math.min(size.width, size.height) / 2;
    body = <View style={{ flex: 1, borderRadius: radius, overflow: 'hidden', backgroundColor: fade(accent, 0.18) }}>
      <View style={[{ position: 'absolute', backgroundColor: accent }, look === 'pill' ? { left: 0, top: 0, bottom: 0, width: `${shown * 100}%` } : { left: 0, right: 0, bottom: 0, height: `${shown * 100}%` }]} />
      <View style={{ flex: 1, flexDirection: look === 'pill' ? 'row' : 'column-reverse', alignItems: 'center', justifyContent: 'space-between', padding: unit * 0.35 }}>
        {icon(colors.text)}
        {caption(colors.text)}
      </View>
    </View>;
  } else if (look === 'ring') {
    // A 270° gauge, open at the bottom.
    const box = Math.max(10, Math.min(size.width, size.height) - 8);
    const stroke = Math.max(4, box * 0.09);
    const r = (box - stroke) / 2;
    const arc = 2 * Math.PI * r * 0.75;
    body = <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={box} height={box} style={{ position: 'absolute', transform: [{ rotate: '135deg' }] }}>
        <Circle cx={box / 2} cy={box / 2} r={r} stroke={fade(accent, 0.2)} strokeWidth={stroke} strokeLinecap="round" fill="none" strokeDasharray={`${arc} ${2 * Math.PI * r}`} />
        <Circle cx={box / 2} cy={box / 2} r={r} stroke={accent} strokeWidth={stroke} strokeLinecap="round" fill="none" strokeDasharray={`${Math.max(0.01, arc * shown)} ${2 * Math.PI * r}`} />
      </Svg>
      {icon(accent)}
      {caption(colors.text, 0.9)}
    </View>;
  } else if (look === 'notch') {
    // Ten blocks that light up, like a hi-fi level meter.
    body = <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: unit * 0.25, paddingHorizontal: unit * 0.3 }}>
      {icon(accent)}
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: unit * 0.8 }}>
        {Array.from({ length: 10 }, (_, index) => <View key={index} style={{ flex: 1, height: `${40 + index * 6.6}%`, borderRadius: 3, backgroundColor: index < Math.round(shown * 10) ? accent : fade(accent, 0.18) }} />)}
      </View>
      {caption(colors.text)}
    </View>;
  } else {
    const rail = Math.max(5, unit * 0.12);
    const knob = Math.max(14, unit * 0.4);
    body = <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: unit * 0.25, paddingHorizontal: unit * 0.3 }}>
      {icon(accent)}
      <View style={{ flex: 1, height: knob, justifyContent: 'center' }}>
        <View style={{ height: rail, borderRadius: rail / 2, overflow: 'hidden', backgroundColor: colors.border }}><View style={{ height: '100%', width: `${shown * 100}%`, backgroundColor: accent }} /></View>
        <View style={{ position: 'absolute', left: `${shown * 100}%`, width: knob, height: knob, marginLeft: -knob / 2, borderRadius: knob / 2, borderWidth: 2, borderColor: colors.text, backgroundColor: accent }} />
      </View>
      {caption(colors.muted)}
    </View>;
  }

  return <View onLayout={(event) => setSize(event.nativeEvent.layout)} {...responder.panHandlers}
    accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityState={{ disabled }}
    accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100) }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={(event) => { if (!disabled) send(Math.max(0, Math.min(100, Math.round(shown * 100) + (event.nativeEvent.actionName === 'increment' ? 5 : -5)))); }}
    style={{ flex: 1, alignSelf: 'stretch', padding: look === 'pill' || look === 'vertical' ? 6 : 0, opacity: disabled ? 0.45 : 1 }}>
    {body}
  </View>;
}
