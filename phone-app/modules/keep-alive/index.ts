import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

// Android only: a foreground service with a notification keeps the deck connected (and the mic listening for the
// wake phrase) while the app is in the background.
const native = Platform.OS === 'android' ? requireOptionalNativeModule<{
  start(title: string, text: string, microphone: boolean): void;
  stop(): void;
  moveToBack(): void;
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): void;
}>('KeepAlive') : null;

export function startKeepAlive(title: string, text: string, microphone: boolean) {
  try { native?.start(title, text, microphone); } catch { /* Android refused (for example, the app was not in front); the deck still works while open */ }
}

export function stopKeepAlive() {
  try { native?.stop(); } catch { /* not running */ }
}

/** Sends the app behind other apps (like Home) without closing it. False when that is not possible here. */
export function moveToBack() {
  if (!native) return false;
  try { native.moveToBack(); return true; } catch { return false; }
}

/** True when Android lets Open Dock run in the background without battery limits (always true off Android). */
export function runsUnrestricted() {
  try { return native ? native.isIgnoringBatteryOptimizations() : true; } catch { return true; }
}

export function askToRunUnrestricted() {
  try { native?.requestIgnoreBatteryOptimizations(); } catch { /* the phone has no such screen */ }
}
