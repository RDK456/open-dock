import { AppState } from 'react-native';

// The last minute of PC stats samples. It lives outside the connection context so a sample each
// second only redraws the stats widgets, not the whole deck.
export type Sample = Record<string, unknown>;
type Listener = (sample: Sample | null) => void;
let history: Sample[] = [];
const listeners = new Set<Listener>();
const isSample = (value: unknown): value is Sample => !!value && typeof value === 'object' && !Array.isArray(value);

// Called by the connection for each pc_stats message: { history: [...] } replaces, { stats } appends.
export function receivePcStats(message: { history?: unknown; stats?: unknown }) {
  if (Array.isArray(message.history)) {
    history = message.history.filter(isSample).slice(-60);
    listeners.forEach((listener) => listener(null));
  } else if (isSample(message.stats)) {
    history = [...history.slice(-59), message.stats];
    listeners.forEach((listener) => listener(message.stats as Sample));
  }
}
export function clearPcStats() {
  history = [];
  listeners.forEach((listener) => listener(null));
}
/** The whole minute, e.g. for a widget page that just loaded. */
export const pcStatsHistory = () => history;
/** Called with each new sample, or null when the history was replaced. */
export function subscribePcStats(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// What the PC samples is what the stats widgets on screen show. Each web widget layer reports its
// needs (from OpenDockStats.needs in its WebView); the connection sends the PC their union, and an
// empty list while none are on screen or the app is in the background.
const needsByLayer = new Map<number, string[]>();
let sendNeeds: ((needs: string[]) => void) | null = null;
let lastSent = '';
let pending: ReturnType<typeof setTimeout> | null = null;
function currentNeeds() {
  return AppState.currentState === 'active' ? [...new Set([...needsByLayer.values()].flat())].sort() : [];
}
// Batches the burst of changes when a page mounts or unmounts.
function publishNeeds(force = false) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    const needs = currentNeeds(), key = needs.join();
    if (sendNeeds && (force || key !== lastSent)) { sendNeeds(needs); lastSent = key; }
  }, 150);
}
/** A layer's current needs, or null when it leaves the screen. */
export function setLayerNeeds(layer: number, needs: string[] | null) {
  if (needs?.length) needsByLayer.set(layer, needs);
  else needsByLayer.delete(layer);
  publishNeeds();
}
/** Called by the connection: `send` once it's ready, null when it closes. Re-sends the current needs. */
export function setPcStatsSender(send: ((needs: string[]) => void) | null) {
  sendNeeds = send;
  lastSent = '';
  if (send) publishNeeds(true);
}
AppState.addEventListener('change', () => publishNeeds());
export const validNeeds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 16 && value.every((need) => typeof need === 'string' && /^[a-z]{1,16}$/.test(need));
