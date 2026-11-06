import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import Storage from 'expo-sqlite/kv-store';
import { Pressable } from './motion';
import { useStyles, type Colors } from './theme';

// An optional lock kept on this phone only. It asks for the fingerprint, face or phone PIN, using the phone's own
// screen lock, so Open Dock stores no PIN. Read synchronously so a cold start is locked from the first frame.
const KEY = 'opendock.app-lock';
const AWAY_MS = 15_000;

let enabled = (() => { try { return Storage.getItemSync(KEY) === 'on'; } catch { return false; } })();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useAppLockEnabled = () => useSyncExternalStore(subscribe, () => enabled);

/** Whether this phone has a screen lock or biometrics to ask. */
async function canLock(): Promise<boolean> {
  try { return (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE; } catch { return false; }
}

async function check(): Promise<boolean> {
  try { return (await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Open Dock' })).success; } catch { return false; }
}

/** Turns the lock on or off, after the same check; returns what went wrong, or null. */
export async function setAppLock(on: boolean): Promise<string | null> {
  if (on && !(await canLock())) return 'Set a screen lock or fingerprint on this phone first.';
  if ((on || (await canLock())) && !(await check())) return 'The lock was not changed: the check was not completed.';
  enabled = on;
  try { Storage.setItemSync(KEY, on ? 'on' : 'off'); } catch { /* lasts until the app closes */ }
  listeners.forEach((listener) => listener());
  return null;
}

/** Covers the app until the check passes: at launch, and when you come back after more than 15 seconds away. */
export function AppLockGate({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  const on = useAppLockEnabled();
  const [locked, setLocked] = useState(on);
  const away = useRef<number | null>(null);
  const asking = useRef(false);

  const ask = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    try {
      // Someone who removed the phone's own lock must never be shut out of the app.
      if (!(await canLock()) || (await check())) setLocked(false);
    } finally { asking.current = false; }
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') away.current = Date.now();
      else if (state === 'active' && away.current !== null) {
        if (enabled && Date.now() - away.current > AWAY_MS) setLocked(true);
        away.current = null;
      }
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => { if (on && locked) void ask(); }, [on, locked, ask]);

  return (
    <View style={styles.fill}>
      {children}
      {on && locked ? (
        <View style={styles.cover} accessibilityViewIsModal>
          <Text style={styles.title}>Open Dock is locked</Text>
          <Pressable style={styles.button} onPress={() => void ask()} accessibilityRole="button"><Text style={styles.buttonText}>Unlock</Text></Pressable>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  fill: { flex: 1 },
  cover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 18 },
  title: { color: colors.text, fontSize: 18, fontWeight: '600' },
  button: { minHeight: 48, minWidth: 140, paddingHorizontal: 24, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: colors.onAccent, fontSize: 15, fontWeight: '600' },
});
