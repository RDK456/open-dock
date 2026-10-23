import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

// Android only: a foreground service with a notification keeps the deck connected (and the mic listening for the
// wake phrase) while the app is in the background.
const native = Platform.OS === 'android' ? requireOptionalNativeModule<{ start(title: string, text: string, microphone: boolean): void; stop(): void }>('KeepAlive') : null;

export function startKeepAlive(title: string, text: string, microphone: boolean) {
  try { native?.start(title, text, microphone); } catch { /* Android refused (for example, the app was not in front); the deck still works while open */ }
}

export function stopKeepAlive() {
  try { native?.stop(); } catch { /* not running */ }
}
