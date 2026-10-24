import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { startActivityAsync } from 'expo-intent-launcher';
import { useStyles, type Colors } from './theme';

// Android only: Open Dock reads the latest GitHub release and hands its APK to Android's installer,
// which refuses any APK not signed with Open Dock's release key. iOS updates come from Apple.
const RELEASES = 'https://github.com/RDK456/open-dock/releases/latest/download';
const APK_URL = `${RELEASES}/OpenDock.apk`;
const DAY = 24 * 60 * 60 * 1000;
const FLAG_GRANT_READ_URI_PERMISSION = 1;
export const CURRENT_VERSION = Constants.expoConfig?.version ?? '0.0.0';

type UpdateState =
  | { kind: 'idle' | 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; version: string; notes: string; bytes: number | null }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string; file: File }
  | { kind: 'error'; message: string };

let state: UpdateState = { kind: 'idle' };
let lastCheck = 0;
let dismissed = '';
const listeners = new Set<() => void>();
const apkFile = () => new File(Paths.cache, 'OpenDock.apk');
const set = (next: UpdateState) => { state = next; listeners.forEach((listener) => listener()); };

export function isNewer(latest: string, current: string) {
  const a = latest.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

export async function checkForUpdate() {
  if (Platform.OS !== 'android' || state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'ready') return;
  lastCheck = Date.now();
  set({ kind: 'checking' });
  let response: Response;
  try {
    response = await fetch(`${RELEASES}/latest.json`, { cache: 'no-store' });
  } catch {
    set({ kind: 'error', message: "Couldn't reach GitHub. Check your internet connection, then try again." });
    return;
  }
  // 404 means no release is published yet (or the repo isn't public), so there's nothing newer.
  if (response.status === 404) { set({ kind: 'current' }); return; }
  if (!response.ok) { set({ kind: 'error', message: `GitHub didn't answer (error ${response.status}). Try again later.` }); return; }
  try {
    const latest = await response.json() as { version?: string; notes?: string };
    const version = (latest.version ?? '').replace(/^v/, '');
    if (!isNewer(version, CURRENT_VERSION)) {
      if (apkFile().exists) apkFile().delete(); // left over from the update that's now installed
      set({ kind: 'current' });
      return;
    }
    const head = await fetch(APK_URL, { method: 'HEAD' }).catch(() => null);
    const bytes = Number(head?.headers.get('content-length')) || null;
    set({ kind: 'available', version, notes: latest.notes ?? '', bytes });
  } catch {
    set({ kind: 'error', message: "GitHub sent an update file Open Dock couldn't read. Try again later." });
  }
}

async function download() {
  if (state.kind !== 'available') return;
  const { version } = state;
  set({ kind: 'downloading', version, percent: 0 });
  try {
    const file = await File.downloadFileAsync(APK_URL, apkFile(), {
      idempotent: true,
      onProgress: ({ bytesWritten, totalBytes }) => {
        const percent = totalBytes ? Math.floor((bytesWritten / totalBytes) * 100) : 0;
        if (state.kind === 'downloading' && percent !== state.percent) set({ kind: 'downloading', version, percent });
      },
    });
    set({ kind: 'ready', version, file });
    await install();
  } catch {
    set({ kind: 'error', message: "The download didn't finish. Try again, or download the update in your browser." });
  }
}

// The first time, Android itself asks the user to allow installs from Open Dock, then continues.
async function install() {
  if (state.kind !== 'ready') return;
  try {
    await startActivityAsync('android.intent.action.VIEW', {
      data: state.file.contentUri,
      type: 'application/vnd.android.package-archive',
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
  } catch {
    set({ kind: 'error', message: "Android couldn't open the installer. Download the update in your browser instead." });
  }
}

function useUpdateState() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}

/** True while there's an update the user hasn't acted on; drives the Connect tab badge. */
export function useUpdateBadge() {
  const current = useUpdateState();
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void checkForUpdate();
    const subscription = AppState.addEventListener('change', (next) => { if (next === 'active' && Date.now() - lastCheck > DAY) void checkForUpdate(); });
    return () => subscription.remove();
  }, []);
  return (current.kind === 'available' && current.version !== dismissed) || current.kind === 'ready';
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

export function AppUpdatesSection() {
  const styles = useStyles(makeStyles);
  const current = useUpdateState();
  if (Platform.OS !== 'android') return null;

  const notes = current.kind === 'available' ? current.notes.split('\n').map((line) => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 3).join(', ') : '';
  const title = current.kind === 'available' ? `Open Dock ${current.version} is available`
    : current.kind === 'downloading' ? `Downloading Open Dock ${current.version}`
    : current.kind === 'ready' ? `Open Dock ${current.version} is ready to install`
    : current.kind === 'error' ? "Couldn't update Open Dock"
    : 'App updates';
  const detail = current.kind === 'checking' ? 'Checking for updates…'
    : current.kind === 'current' ? `Open Dock ${CURRENT_VERSION} is up to date`
    : current.kind === 'available' ? [current.bytes ? megabytes(current.bytes) : '', notes].filter(Boolean).join(' · ')
    : current.kind === 'downloading' ? `${current.percent}% · You can keep using the deck`
    : current.kind === 'ready' ? 'Android asks you to confirm the update. Your decks and paired PCs stay.'
    : current.kind === 'error' ? current.message
    : `Open Dock ${CURRENT_VERSION}`;

  return <View style={styles.card}>
    <Text style={styles.title}>{title}</Text>
    {detail ? <Text style={[styles.detail, current.kind === 'error' && styles.error]}>{detail}</Text> : null}
    {current.kind === 'downloading' ? <View style={styles.bar}><View style={[styles.fill, { width: `${current.percent}%` }]} /></View> : null}
    {current.kind === 'available' ? <View style={styles.row}>
      {dismissed !== current.version ? <Button label="Later" onPress={() => { dismissed = current.version; set({ ...current }); }} /> : null}
      <Button label="Download" primary onPress={() => void download()} />
    </View>
      : current.kind === 'ready' ? <Button label="Install update" primary onPress={() => void install()} />
      : current.kind === 'error' ? <View style={styles.row}>
        <Button label="Use browser" onPress={() => void Linking.openURL(APK_URL)} />
        <Button label="Try again" primary onPress={() => { set({ kind: 'idle' }); void checkForUpdate(); }} />
      </View>
      : <Button label="Check for updates" disabled={current.kind === 'checking'} onPress={() => void checkForUpdate()} />}
  </View>;
}

function Button({ label, primary, disabled, onPress }: { label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return <Pressable style={({ pressed }) => [styles.button, primary && styles.primary, (pressed || disabled) && styles.pressed]} disabled={disabled} onPress={onPress} accessibilityRole="button">
    <Text style={[styles.buttonText, primary && styles.primaryText]}>{label}</Text>
  </Pressable>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { marginTop: 14, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.panel },
  title: { color: colors.text, fontSize: 13, fontWeight: '500' },
  detail: { color: colors.muted, fontSize: 12, marginTop: 5, lineHeight: 16 },
  error: { color: colors.red },
  bar: { height: 4, marginTop: 10, borderRadius: 2, overflow: 'hidden', backgroundColor: colors.border },
  fill: { height: '100%', backgroundColor: colors.accent },
  row: { flexDirection: 'row', gap: 6 },
  button: { flex: 1, height: 36, marginTop: 10, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center' },
  primary: { borderColor: colors.accent, backgroundColor: colors.accent },
  pressed: { opacity: 0.6 },
  buttonText: { color: colors.text, fontSize: 13, fontWeight: '500' },
  primaryText: { color: colors.bg, fontWeight: '600' },
});
