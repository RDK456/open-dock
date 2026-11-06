import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

// The PC's clipboard history, for the Clipboard widget. It lives outside the connection context so a
// new clip only redraws the clipboard widgets, not the whole deck.
export type Clip = { id: number; text: string; atMs: number };
export type ClipboardResult = { id: number; ok: boolean; error?: string; seq: number };
type State = { supported: boolean; items: Clip[]; result: ClipboardResult | null };

let state: State = { supported: true, items: [], result: null };
const listeners = new Set<() => void>();
const set = (next: State) => { state = next; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const validClip = (value: unknown): value is Clip => {
  const clip = value as Partial<Clip> | null;
  return !!clip && typeof clip === 'object' && Number.isSafeInteger(clip.id) && typeof clip.text === 'string' && clip.text.length <= 4000 && typeof clip.atMs === 'number' && Number.isFinite(clip.atMs);
};

/** Called by the connection for each clipboard message from the PC. */
export function receiveClipboard(message: { supported?: unknown; items?: unknown }) {
  if (!Array.isArray(message.items)) return;
  set({ ...state, supported: message.supported !== false, items: message.items.filter(validClip).slice(0, 20) });
}
let resultSeq = 0;
export function receiveClipboardResult(message: { id?: unknown; ok?: unknown; error?: unknown }) {
  if (typeof message.id !== 'number') return;
  set({ ...state, result: { id: message.id, ok: message.ok === true, error: typeof message.error === 'string' ? message.error.slice(0, 120) : undefined, seq: ++resultSeq } });
}
export function clearClipboard() { set({ supported: true, items: [], result: null }); }

export const useClipboard = () => useSyncExternalStore(subscribe, () => state);

// The PC reads its clipboard only while a clipboard widget is on screen here and the app is in front.
type Send = (message: Record<string, unknown>) => void;
let sender: Send | null = null;
let wanted = 0;
let told = false;
function publish() {
  const on = wanted > 0 && AppState.currentState === 'active';
  if (sender && on !== told) { sender({ type: 'clipboard_subscribe', on }); told = on; }
}
/** Called by the connection: `send` once it's ready, null when it closes. A new connection starts unsubscribed. */
export function setClipboardSender(send: Send | null) {
  sender = send;
  told = false;
  publish();
}
AppState.addEventListener('change', publish);

/** While `active`, this widget asks the PC for the clipboard history. */
export function useClipboardDemand(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    wanted++;
    publish();
    return () => { wanted--; publish(); };
  }, [active]);
}

/** Puts a clip back on the PC's clipboard; false when the phone isn't connected. */
export function copyClipToPc(id: number): boolean {
  if (!sender) return false;
  sender({ type: 'clipboard_copy', id });
  return true;
}
