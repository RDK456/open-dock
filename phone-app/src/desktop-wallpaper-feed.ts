import { useSyncExternalStore } from 'react';
import { setPcAccent } from './theme';
import { setPcBackdrop } from './wallpaper';

// The Wallpaper Engine wallpapers on the PC, and picking one for its desktop. Outside the connection context so
// a new preview only redraws the wallpaper card.
export type PcWallpaper = { id: string; title: string; kind: string; preview: boolean };
export type PcDisplay = { index: number; label: string };
export type WallpaperResult = { id: string; ok: boolean; error?: string; seq: number };
type State = {
  /** False until the PC has answered. */
  loaded: boolean;
  supported: boolean;
  installed: boolean;
  items: PcWallpaper[];
  displays: PcDisplay[];
  thumbs: Record<string, string | null>;
  result: WallpaperResult | null;
  /** Counts every result and every reset, so a wait for the PC's answer ends either way. */
  seq: number;
  /** The wallpaper on the PC's main display, and its colour (#rrggbb). */
  current: string | null;
  color: string | null;
  /** "Match PC wallpaper", from the deck config. */
  match: boolean;
};

const EMPTY: State = { loaded: false, supported: true, installed: true, items: [], displays: [], thumbs: {}, result: null, seq: 0, current: null, color: null, match: false };
let state: State = EMPTY;
const listeners = new Set<() => void>();
const set = (next: State) => { state = next; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
const validItem = (value: unknown): value is PcWallpaper => {
  const item = value as Partial<PcWallpaper> | null;
  return !!item && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 80 && typeof item.title === 'string';
};

/** Called by the connection for each wallpaper message from the PC. */
export function receiveWallpapers(message: { supported?: unknown; installed?: unknown; items?: unknown; displays?: unknown; current?: unknown; color?: unknown }) {
  if (!Array.isArray(message.items)) return;
  const items = message.items.filter(validItem).slice(0, 500).map((item) => ({ id: item.id, title: text(item.title, 80), kind: text(item.kind, 16), preview: item.preview === true }));
  const displays = (Array.isArray(message.displays) ? message.displays : []).flatMap((value): PcDisplay[] => {
    const display = value as Partial<PcDisplay> | null;
    return display && Number.isInteger(display.index) && (display.index as number) >= 0 && (display.index as number) < 16 && typeof display.label === 'string' ? [{ index: display.index as number, label: display.label.slice(0, 40) }] : [];
  }).slice(0, 8);
  const current = typeof message.current === 'string' && message.current.length <= 80 ? message.current : null;
  const color = typeof message.color === 'string' && /^#[0-9a-f]{6}$/i.test(message.color) ? message.color : null;
  set({ ...state, loaded: true, supported: message.supported !== false, installed: message.installed !== false, items, displays, current, color });
  follow();
}
export function receiveWallpaperThumb(message: { id?: unknown; data?: unknown }) {
  if (typeof message.id !== 'string') return;
  const ok = typeof message.data === 'string' && message.data.length < 1_700_000 && /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/.test(message.data);
  set({ ...state, thumbs: { ...state.thumbs, [message.id]: ok ? message.data as string : null } });
}
let resultSeq = 0;
let lastMonitor: number | undefined;
export function receiveWallpaperResult(message: { id?: unknown; ok?: unknown; error?: unknown }) {
  if (typeof message.id !== 'string') return;
  const seq = ++resultSeq;
  set({ ...state, seq, result: { id: message.id, ok: message.ok === true, error: typeof message.error === 'string' ? message.error.slice(0, 120) : undefined, seq } });
  // Set on the main display (or all of them): ask again for its colour.
  if (message.ok === true && (lastMonitor === undefined || lastMonitor === 0) && state.match) loadWallpapers();
}

// --- Match PC wallpaper: the accent takes the wallpaper's colour, the background its picture.
let matched: string | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
function follow() {
  setPcAccent(state.match && state.color ? state.color : '');
  if (!state.match) {
    if (matched !== null) { matched = null; setPcBackdrop(null); }
  } else if (state.current && state.current !== matched && sender) {
    matched = state.current;
    sender({ type: 'wallpaper_backdrop', id: state.current });
  }
  // Wallpaper Engine can change the wallpaper by itself (playlists, its own window), so look again now and then.
  const want = state.match && sender !== null;
  if (want && !poll) poll = setInterval(() => loadWallpapers(), 30_000);
  if (!want && poll) { clearInterval(poll); poll = null; }
}
export function receiveWallpaperBackdrop(message: { id?: unknown; data?: unknown; sharp?: unknown }) {
  if (message.id !== matched || !state.match) return;
  const ok = typeof message.data === 'string' && message.data.length < 3_000_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(message.data);
  if (ok) setPcBackdrop(message.data as string);
  // Only the small preview so far (Wallpaper Engine writes its full snapshot a moment later): ask again next look.
  if (!ok || message.sharp !== true) matched = null;
}
/** Called with the deck config's setting, whenever a deck arrives. */
export function setWallpaperMatch(on: boolean) {
  if (on === state.match) return;
  set({ ...state, match: on });
  if (on) loadWallpapers();
  follow();
}
/** The switch on this phone: changes the setting on the PC, which sends every deck back with it. */
export function sendWallpaperMatch(on: boolean): boolean {
  if (!sender) return false;
  sender({ type: 'wallpaper_match', on });
  setWallpaperMatch(on);
  return true;
}
export function clearWallpapers() { requested.clear(); matched = null; set({ ...EMPTY, seq: ++resultSeq, match: state.match, color: state.color }); }

export const useDesktopWallpapers = () => useSyncExternalStore(subscribe, () => state);

type Send = (message: Record<string, unknown>) => void;
let sender: Send | null = null;
const requested = new Set<string>();
/** Called by the connection: `send` once it's ready, null when it closes. */
export function setWallpaperSender(send: Send | null) { sender = send; if (!send) requested.clear(); else if (state.match) loadWallpapers(); follow(); }

/** Asks the PC for its wallpapers; `refresh` rescans instead of using its last answer. False when not connected. */
export function loadWallpapers(refresh = false): boolean {
  if (!sender) return false;
  sender({ type: 'wallpaper_list', refresh });
  return true;
}
/** Asks for one preview, once per connection. */
export function loadWallpaperThumb(id: string) {
  if (!sender || requested.has(id)) return;
  requested.add(id);
  sender({ type: 'wallpaper_thumb', id });
}
/** Makes the PC show this wallpaper, on one display when `monitor` is given; false when the phone isn't connected. */
export function applyPcWallpaper(id: string, monitor?: number): boolean {
  if (!sender) return false;
  lastMonitor = monitor;
  sender({ type: 'wallpaper_apply', id, ...(monitor === undefined ? {} : { monitor }) });
  return true;
}
