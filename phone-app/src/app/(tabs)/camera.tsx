import { useEffect, useState } from 'react';
import { PermissionsAndroid, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Pressable } from '../../motion';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera } from 'expo-camera';
import { Wallpaper } from '../../wallpaper';
import { usePcConnection } from '../../connection';
import { useStyles, type Colors } from '../../theme';
import { useTabBarClearance } from '../../tab-inset';
import { cameraAvailable, cameraSnapshot, onCameraUpdate, setCamera, startCamera, stopCamera, type CamCaps, type CamState } from '../../../modules/opencam';

const ZOOMS = [0.5, 1, 2, 3, 5];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const shutter = (ns: number) => (ns >= 100_000_000 ? `${(ns / 1e9).toFixed(1)}s` : `1/${Math.round(1e9 / ns)}`);
const RES_NAMES: Record<string, string> = { '3840x2160': '4K', '2560x1440': '1440p', '1920x1080': '1080p', '1280x720': '720p' };

function Chip({ label, on, ok = true, onPress }: { label: string; on?: boolean; ok?: boolean; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable disabled={!ok} onPress={onPress} style={[styles.chip, on && styles.chipOn, !ok && styles.off]}>
      <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function Stepper({ label, value, ok, down, up }: { label: string; value: string; ok: boolean; down: () => void; up: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.row, !ok && styles.off]}>
      <Text style={styles.label}>{label}</Text>
      <Chip label="−" ok={ok} onPress={down} /><Text style={styles.value}>{value}</Text><Chip label="+" ok={ok} onPress={up} />
    </View>
  );
}

export default function CameraScreen() {
  const styles = useStyles(makeStyles);
  const clearance = useTabBarClearance();
  const { connection, status } = usePcConnection();
  const [caps, setCaps] = useState<CamCaps>({});
  const [state, setState] = useState<CamState>({});
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const apply = (u: ReturnType<typeof cameraSnapshot>) => {
      if (!u) return;
      if (u.quit) { setRunning(false); setState({}); return; }
      setRunning(true);
      if (u.caps) setCaps(u.caps);
      if (u.state) setState(u.state);
    };
    apply(cameraSnapshot());
    return onCameraUpdate(apply);
  }, []);

  const start = async () => {
    if (!connection) return;
    const cam = await Camera.requestCameraPermissionsAsync();
    if (!cam.granted) return;
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
    startCamera(connection.token);
    setRunning(true);
  };
  const stop = () => { stopCamera(); setRunning(false); setState({}); };
  const set = (k: string, v: unknown) => setCamera(k, v);

  const modes = caps.modes ?? [];
  const resList = [...new Set(modes.map((m) => m.split('@')[0]))];
  const fpsList = modes.filter((m) => m.startsWith(`${state.res}@`)).map((m) => Number(m.split('@')[1]));
  const zoomMin = caps.zoomMin ?? 1;
  const zoomMax = caps.zoomMax ?? 1;
  const zoom = state.zoom ?? 1;
  const ev = state.ev ?? 0;
  const evMin = caps.evMin ?? 0;
  const evMax = caps.evMax ?? 0;
  const pro = state.mode === 'pro';
  const feed = !running ? 'Camera is off' : state.conn ? `Streaming over ${state.conn === 'usb' ? 'USB' : 'Wi-Fi'}${state.demand ? '' : ' (idle)'}` : 'Waiting for the PC';
  const offline = status !== 'connected' && !running;

  return (
    <SafeAreaView style={styles.safe}>
      <Wallpaper />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: clearance }]}>
        <Text style={styles.title}>Camera</Text>
        <Text style={styles.sub}>Use this phone as a webcam for your PC. Start it here, then open the Camera section on the PC.</Text>
        {!cameraAvailable ? <Text style={styles.sub}>Phone camera streaming is Android only.</Text> : (
          <>
            <View style={styles.card}>
              <Text style={styles.status}>{feed}</Text>
              {offline ? <Text style={styles.sub}>Connect to your PC first.</Text> : null}
              <Pressable disabled={offline} onPress={running ? stop : start} style={[styles.chip, styles.chipOn, styles.wide, offline && styles.off]}>
                <Text style={styles.chipTextOn}>{running ? 'Stop camera' : 'Start camera'}</Text>
              </Pressable>
            </View>
            {running ? (
              <View style={styles.card}>
                <View style={styles.row}>
                  <Chip label={state.live === false ? 'Paused' : 'LIVE'} on={state.live !== false} onPress={() => set('live', state.live === false)} />
                  <Chip label={state.facing === 'front' ? 'Front' : 'Back'} ok={(caps.facings?.length ?? 0) > 1} onPress={() => set('facing', state.facing === 'front' ? 'back' : 'front')} />
                  <Chip label="Torch" on={state.torch} ok={!!caps.torch} onPress={() => set('torch', !state.torch)} />
                  <Chip label="Stabilise" on={state.stab} ok={!!caps.stab} onPress={() => set('stab', !state.stab)} />
                </View>
                <View style={styles.row}>
                  {['video', 'pro', 'portrait'].map((m) => <Chip key={m} label={m} on={state.mode === m} ok={m !== 'portrait' || !!caps.portrait} onPress={() => set('mode', m)} />)}
                </View>
                <Text style={styles.label}>Zoom {zoom.toFixed(1)}×</Text>
                <View style={styles.row}>
                  {ZOOMS.filter((z) => z >= zoomMin && z <= zoomMax).map((z) => <Chip key={z} label={`${z}×`} on={Math.abs(zoom - z) < 0.05} onPress={() => set('zoom', z)} />)}
                  <Chip label="−" onPress={() => set('zoom', clamp(zoom - 0.5, zoomMin, zoomMax))} />
                  <Chip label="+" onPress={() => set('zoom', clamp(zoom + 0.5, zoomMin, zoomMax))} />
                </View>
                <Stepper label="Exposure" value={`${ev >= 0 ? '+' : ''}${(ev * (caps.evStep ?? 1)).toFixed(1)}`} ok={!pro && evMax > 0} down={() => set('ev', clamp(ev - 1, evMin, evMax))} up={() => set('ev', clamp(ev + 1, evMin, evMax))} />
                <View style={styles.row}>
                  <Chip label="Autofocus" on={state.af !== false} ok={!!caps.af} onPress={() => set('af', state.af === false)} />
                </View>
                <Stepper label="Focus" value={(state.focus ?? 0).toFixed(1)} ok={state.af === false && (caps.focusMax ?? 0) > 0} down={() => set('focus', clamp((state.focus ?? 0) - 0.5, 0, caps.focusMax ?? 0))} up={() => set('focus', clamp((state.focus ?? 0) + 0.5, 0, caps.focusMax ?? 0))} />
                {pro ? <>
                  <Stepper label="ISO" value={`${state.iso ?? '—'}`} ok={!!caps.manual} down={() => set('iso', clamp(Math.round((state.iso ?? 400) / 1.26), caps.isoMin ?? 100, caps.isoMax ?? 3200))} up={() => set('iso', clamp(Math.round((state.iso ?? 400) * 1.26), caps.isoMin ?? 100, caps.isoMax ?? 3200))} />
                  <Stepper label="Shutter" value={state.exp ? shutter(state.exp) : '—'} ok={!!caps.manual} down={() => set('exp', clamp(Math.round((state.exp ?? 16e6) / 1.26), caps.expMin ?? 1e5, caps.expMax ?? 1e9))} up={() => set('exp', clamp(Math.round((state.exp ?? 16e6) * 1.26), caps.expMin ?? 1e5, caps.expMax ?? 1e9))} />
                  {(caps.apertures?.length ?? 0) > 1 ? <View style={styles.row}><Text style={styles.label}>Aperture</Text>{caps.apertures!.map((a) => <Chip key={a} label={`f/${a}`} on={state.aperture === a} onPress={() => set('aperture', a)} />)}</View> : null}
                </> : null}
                <Text style={styles.label}>White balance</Text>
                <View style={styles.row}>{(caps.wb ?? []).map((w) => <Chip key={w} label={w} on={state.wb === w} onPress={() => set('wb', w)} />)}</View>
                <Text style={styles.label}>Resolution</Text>
                <View style={styles.row}>{resList.map((r) => <Chip key={r} label={RES_NAMES[r] ?? r} on={state.res === r} onPress={() => set('res', r)} />)}</View>
                <View style={styles.row}>{fpsList.map((f) => <Chip key={f} label={`${f} fps`} on={state.fps === f} onPress={() => set('fps', f)} />)}</View>
                <Stepper label="Bitrate" value={state.mbps ? `${state.mbps} Mbps` : 'Auto'} ok down={() => set('mbps', Math.max(0, (state.mbps ?? 0) - 2))} up={() => set('mbps', (state.mbps ?? 0) + 2)} />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 18, paddingTop: 12, gap: 12 },
  title: { color: colors.text, fontSize: 23, fontWeight: '600', letterSpacing: -0.3 },
  sub: { color: colors.muted, fontSize: 13, lineHeight: 17 },
  status: { color: colors.text, fontSize: 15, fontWeight: '600' },
  card: { padding: 14, gap: 10, borderRadius: 16, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', minWidth: 64 },
  value: { color: colors.text, fontSize: 14, fontWeight: '600', minWidth: 56, textAlign: 'center' },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: colors.onAccent, fontSize: 13, fontWeight: '600' },
  wide: { alignSelf: 'stretch' },
  off: { opacity: 0.35 },
});
