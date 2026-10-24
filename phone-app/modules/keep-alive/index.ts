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
  canDrawOverlays(): boolean;
  requestOverlayPermission(): void;
  showIsland(state: string, text: string): void;
  hideIsland(): void;
  installedApkSha256(): Promise<string>;
  applyApkPatch(patchPath: string, outPath: string): Promise<string>;
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

/** The voice island over other apps needs "Display over other apps" (always true off Android: no island there). */
export function canShowIsland() {
  try { return native ? native.canDrawOverlays() : true; } catch { return true; }
}

export function askToShowIsland() {
  try { native?.requestOverlayPermission(); } catch { /* the phone has no such screen */ }
}

export type IslandState = 'listening' | 'working' | 'done' | 'failed' | 'idle';

/** Shows (or, with 'idle', hides) the voice island at the top of the screen, over every app. */
export function setIsland(state: IslandState, text = '') {
  try { if (state === 'idle') native?.hideIsland(); else native?.showIsland(state, text); } catch { /* no overlay */ }
}

export function askToRunUnrestricted() {
  try { native?.requestIgnoreBatteryOptimizations(); } catch { /* the phone has no such screen */ }
}

/** Delta updates: the installed APK's SHA-256, or null where it can't be read (then the full APK is used). */
export async function installedApkSha256(): Promise<string | null> {
  try { return native ? await native.installedApkSha256() : null; } catch { return null; }
}

/** Rebuilds the new APK at `outPath` from the installed one and the patch; resolves to its SHA-256. */
export async function applyApkPatch(patchPath: string, outPath: string): Promise<string> {
  if (!native) throw new Error('no native module');
  return native.applyApkPatch(patchPath, outPath);
}
