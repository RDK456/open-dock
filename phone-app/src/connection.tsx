import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';
import { loadDeckPages } from './deck';
import { validSurfaceLayout } from './deck-layout';
import { expire, parsePlayers, settle, type PlayersState } from './media-players';
import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import type { WidgetSurface } from './now-playing-layout';
import { clearPcStats, receivePcStats, setPcStatsSender } from './pc-stats-feed';
import { countMessage } from './perf-overlay';
import { setPetWorld } from './pet-world';
import { findPcs } from './discovery';

export type PcConnection = { host: string; port: number; token: string; deviceName?: string; transport?: 'wifi' | 'usb' };
export type DeckMediaCommand = 'play_pause' | 'next_track' | 'previous_track' | 'volume_up' | 'volume_down' | 'mute';
export type DeckStep = { type: 'media'; command: DeckMediaCommand } | { type: 'hotkey'; keys: string[] } | { type: 'launch_app'; app: string } | { type: 'launch_file'; path: string } | { type: 'launch_folder'; path: string } | { type: 'type_text'; text: string } | { type: 'open_url'; url: string } | { type: 'delay'; ms: number };
export type DeckAction = DeckStep | { type: 'run_script'; path: string; allowOnPc: boolean } | { type: 'plugin_action'; pluginId: string; actionId: string; allowOnPc: boolean; inputs?: Record<string, string> } | { type: 'sequence'; steps: DeckStep[] } | { type: 'select_profile'; profileId: string } | { type: 'select_page'; pageId: string } | { type: 'open_folder'; folderId: string } | { type: 'system'; command: SystemCommand };
export type SystemCommand = 'lock' | 'sleep' | 'restart' | 'shutdown' | 'sign_out' | 'brightness_up' | 'brightness_down' | 'screenshot';
/** Touchpad and keyboard input; `move` and `scroll` are in PC pixels and wheel steps. */
export type PointerEvent = { kind: 'move' | 'scroll'; dx: number; dy: number } | { kind: 'zoom'; steps: number } | { kind: 'click' | 'press' | 'release'; button: 'left' | 'right' | 'middle' } | { kind: 'text'; text: string } | { kind: 'key'; key: string };
export type DeckPlacement = { row: number; column: number; rowSpan: number; columnSpan: number };
export type DeckButton = { id: string; label: string; icon: string; placement?: DeckPlacement; iconSvg?: string; appIconData?: string; action: DeckAction; longPress?: DeckAction };
export type PetOptions = { outfit?: string; mood?: boolean; sound?: boolean; camera?: boolean; sleepy?: number; hyper?: number; shy?: number; grumpy?: number; quietFrom?: number; quietTo?: number };
export type DeckWidget = { id: string; type: 'clock'; placement: DeckPlacement; face?: string; color?: string; opacity?: number } | { id: string; type: 'now_playing'; placement: DeckPlacement } | { id: string; type: 'lyrics'; placement: DeckPlacement } | { id: string; type: 'pet'; placement: DeckPlacement; face?: string; color?: string; opacity?: number; pet?: PetOptions } | { id: string; type: 'pc_stats'; placement: DeckPlacement; face?: string; metric?: string; color?: string; gpu?: string; opacity?: number } | { id: string; type: 'plugin'; pluginId: string; widgetId: string; renderType: string; values: Record<string, string>; placement: DeckPlacement };
export type DeckFolder = { id: string; name: string; rows: number; columns: number; buttons: DeckButton[]; widgets: DeckWidget[] };
export type DeckPage = { id: string; name: string; rows: number; columns: number; buttons: DeckButton[]; widgets: DeckWidget[]; folders: DeckFolder[] };
export type DeckProfile = { id: string; name: string; pages: DeckPage[]; activePageId: string };
export type DeckConfig = { schemaVersion: number; revision: number; profiles: DeckProfile[]; activeProfileId: string };
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type PlaybackState = 'playing' | 'paused' | 'stopped' | 'unavailable';
export type SystemMediaState = { sourceAppId?: string; sourceName?: string; title?: string; artist?: string; album?: string; playbackState: PlaybackState; positionMs?: number; durationMs?: number; artworkDataUrl?: string; volumePercent?: number; canSeek?: boolean; playbackRate?: number;
  /** When positionMs was reported (Date.now()); while playing, the position has moved on since. */
  receivedAt?: number };
export type ActionError = 'accessibility_permission_required' | 'app_launch_failed' | 'stale_revision' | 'unknown_button' | 'control_failed';

type ConnectionContextValue = {
  connection: PcConnection | null;
  pairedDevices: PcConnection[];
  status: ConnectionStatus;
  protocolError: string | null;
  playbackState: PlaybackState;
  /** Every media player on the PC and which one the controls follow; null until the PC reports. */
  mediaPlayers: PlayersState | null;
  /** Follow this player, or Auto when null. */
  selectMediaPlayer: (playerId: string | null) => boolean;
  deckConfig: DeckConfig | null;
  independentNavigation: boolean;
  selectedProfileId: string | null;
  selectedPageId: string | null;
  actionError: ActionError | null;
  connect: (connection: PcConnection) => Promise<void>;
  disconnect: () => Promise<void>;
  removePairedDevice: (id: string) => Promise<void>;
  /** Presses a deck key; `longPress` runs its long-press action (the same action when it has none). */
  sendButton: (buttonId: string, longPress?: boolean) => boolean;
  sendMediaCommand: (command: DeckMediaCommand) => boolean;
  sendSystemVolume: (volumePercent: number) => boolean;
  seekMedia: (positionMs: number) => boolean;
  selectProfile: (profileId: string) => boolean;
  selectPage: (pageId: string) => boolean;
  reportWidgetSurface: (surface: WidgetSurface) => void;
  /** Sends touchpad or keyboard input; false when there is no connection. Fire and forget. */
  sendPointer: (event: PointerEvent) => boolean;
  /** Pastes a drawn signature on the PC. Strokes are points on a 1600×600 canvas. Resolves to an error, or null when pasted. */
  sendSignature: (strokes: [number, number][][]) => Promise<string | null>;
  /** Adds or replaces `button` and/or removes `removeId` on a page (or a folder in it). Resolves to an error, or null when saved. */
  editButton: (edit: { pageId: string; folderId?: string; button?: DeckButton; removeId?: string }) => Promise<string | null>;
  /** Sends a spoken sentence ("open spotify"); resolves with what the PC did, or why it could not. */
  sendVoice: (text: string) => Promise<{ ok: boolean; text: string }>;
  /** Tells the PC the mic is (or stopped) listening for a command, for its voice island. */
  sendVoiceState: (listening: boolean, text: string) => void;
};

const STORAGE_KEY = 'opendock.pc-connection';
const PAIRED_KEY = 'opendock.pc-connections';
const LEGACY_STORAGE_KEY = 'decklink.pc-connection';
const MAX_RECONNECT_ATTEMPTS = 3;
// Some phones (iPhones especially) let a connection to an address nobody answers hang for over a minute.
const CONNECT_TIMEOUT_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 4000;
const USB_PROBE_MS = 10_000;
const DECK_CACHE_KEY = 'opendock.deck-snapshot';
const DEVICE_SELECTION_KEY = 'opendock.device-navigation';
const LEGACY_SOURCE_KEY = 'opendock.legacy-import-source';
const LEGACY_IMPORTED_KEY = 'opendock.legacy-imported';
const PHONE_ID_KEY = 'opendock.phone-id';
const PHONE_NAME_KEY = 'opendock.phone-name';

/** This phone's name as the PC lists it; a model name until the user picks one. */
export async function getPhoneName(): Promise<string> {
  const saved = (await SecureStore.getItemAsync(PHONE_NAME_KEY).catch(() => null))?.trim();
  const model = (Platform.constants as { Model?: string } | undefined)?.Model;
  return saved || model || 'Phone';
}

export async function setPhoneName(name: string): Promise<void> {
  await SecureStore.setItemAsync(PHONE_NAME_KEY, name.trim().slice(0, 40));
}

/** Who this phone is to the PC, so the PC can keep a deck for it. */
async function phoneIdentity(): Promise<{ deviceId: string; deviceName: string }> {
  let deviceId = await SecureStore.getItemAsync(PHONE_ID_KEY).catch(() => null);
  if (!deviceId) {
    deviceId = `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await SecureStore.setItemAsync(PHONE_ID_KEY, deviceId).catch(() => {});
  }
  return { deviceId, deviceName: await getPhoneName() };
}
const ConnectionContext = createContext<ConnectionContextValue | null>(null);
const EMPTY_MEDIA_STATE: SystemMediaState = { playbackState: 'unavailable' };
// The PC's playback speed: 0 while a browser buffers; missing means normal speed.
const playbackRate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 16 ? value : undefined;

function isLoopback(host: string) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function connectionId(connection: PcConnection) {
  return `${connection.host.toLowerCase()}:${connection.port}`;
}

async function legacyDeckForPairing(connection: PcConnection) {
  if (await SecureStore.getItemAsync(`${LEGACY_IMPORTED_KEY}.${connectionId(connection)}`)) return null;
  const pages = await loadDeckPages();
  if (!pages.some((page) => page.shortcuts.length > 0)) return null;
  let sourceId = await SecureStore.getItemAsync(LEGACY_SOURCE_KEY);
  if (!sourceId) {
    sourceId = `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await SecureStore.setItemAsync(LEGACY_SOURCE_KEY, sourceId);
  }
  return { sourceId, pages };
}

function websocketUrl(connection: PcConnection) {
  const address = connection.transport === 'usb' ? '127.0.0.1' : connection.host;
  const formattedHost = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  return `ws://${formattedHost}:${connection.port}/ws`;
}

function validDeckButton(value: unknown): value is DeckButton {
  if (!value || typeof value !== 'object') return false;
  const button = value as Partial<DeckButton>;
  const placement = button.placement;
  return typeof button.id === 'string' && typeof button.label === 'string' && typeof button.icon === 'string' &&
    (placement === undefined || (placement !== null && typeof placement === 'object' && Number.isInteger(placement.row) && Number.isInteger(placement.column) && Number.isInteger(placement.rowSpan) && Number.isInteger(placement.columnSpan))) &&
    (!button.iconSvg || (typeof button.iconSvg === 'string' && button.iconSvg.length <= 8192 && button.iconSvg.startsWith('<svg') && button.iconSvg.endsWith('</svg>') && !/<script|<foreignobject|onload=|onclick=|href=|url\(/i.test(button.iconSvg))) &&
    (!button.appIconData || (typeof button.appIconData === 'string' && button.appIconData.length <= 65536 && button.appIconData.startsWith('data:image/png;base64,'))) &&
    !!button.action && typeof button.action.type === 'string' &&
    (button.longPress === undefined || (!!button.longPress && typeof button.longPress.type === 'string'));
}

function utf8ByteLength(value: string) {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return length;
}

function validDeckWidget(value: unknown): value is DeckWidget {
  if (!value || typeof value !== 'object') return false;
  const widget = value as Partial<DeckWidget>;
  const placement = widget.placement;
  if (typeof widget.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(widget.id) || !placement || typeof placement !== 'object' ||
      ![placement.row, placement.column, placement.rowSpan, placement.columnSpan].every(Number.isInteger)) return false;
  if ((widget.type === 'clock' || widget.type === 'pet' || widget.type === 'pc_stats') && (widget as { opacity?: unknown }).opacity !== undefined) {
    const opacity = (widget as { opacity?: unknown }).opacity;
    if (typeof opacity !== 'number' || !Number.isInteger(opacity) || opacity < 0 || opacity > 100) return false;
  }
  if (widget.type === 'clock') {
    const clock = widget as Extract<DeckWidget, { type: 'clock' }>;
    return (clock.face === undefined || (typeof clock.face === 'string' && /^[a-z]{1,24}$/.test(clock.face))) &&
      (clock.color === undefined || (typeof clock.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(clock.color)));
  }
  if (widget.type === 'pet') {
    const pet = widget as Extract<DeckWidget, { type: 'pet' }>;
    const options = pet.pet;
    if (options !== undefined) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
      const level = (v: unknown, max: number) => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max);
      const flag = (v: unknown) => v === undefined || typeof v === 'boolean';
      if (!(options.outfit === undefined || (typeof options.outfit === 'string' && /^[a-z]{1,16}$/.test(options.outfit))) || ![options.mood, options.sound, options.camera].every(flag) ||
          ![options.sleepy, options.hyper, options.shy, options.grumpy].every((v) => level(v, 10)) || !level(options.quietFrom, 23) || !level(options.quietTo, 23)) return false;
    }
    return (pet.face === undefined || (typeof pet.face === 'string' && /^[a-z]{1,24}$/.test(pet.face))) &&
      (pet.color === undefined || (typeof pet.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(pet.color)));
  }
  if (widget.type === 'pc_stats') {
    const stats = widget as Extract<DeckWidget, { type: 'pc_stats' }>;
    return [stats.face, stats.metric].every((id) => id === undefined || (typeof id === 'string' && /^[a-z]{1,24}$/.test(id))) &&
      (stats.color === undefined || (typeof stats.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(stats.color))) &&
      (stats.gpu === undefined || (typeof stats.gpu === 'string' && /^[a-z0-9-]{1,48}$/.test(stats.gpu)));
  }
  if (widget.type === 'now_playing' || widget.type === 'lyrics') return true;
  if (widget.type !== 'plugin' || !('pluginId' in widget) || !('widgetId' in widget) || !('renderType' in widget) || !('values' in widget)) return false;
  const pluginWidget = widget as Extract<DeckWidget, { type: 'plugin' }>;
  if (![pluginWidget.pluginId, pluginWidget.widgetId, pluginWidget.renderType].every((id) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id)) ||
      !pluginWidget.values || typeof pluginWidget.values !== 'object' || Array.isArray(pluginWidget.values)) return false;
  const entries = Object.entries(pluginWidget.values);
  return entries.length <= 16 && entries.every(([id, text]) => /^[A-Za-z0-9._-]{1,64}$/.test(id) && typeof text === 'string' && utf8ByteLength(text) <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(text)) &&
    entries.reduce((total, [, text]) => total + utf8ByteLength(text), 0) <= 8192;
}

function validSurface(value: { rows?: unknown; columns?: unknown; buttons?: unknown; widgets?: unknown }, allowFolderButtons: boolean): boolean {
  const { rows, columns, buttons, widgets } = value;
  return Number.isInteger(rows) && Number.isInteger(columns) && (rows as number) >= 1 && (rows as number) <= 6 && (columns as number) >= 1 && (columns as number) <= 6 &&
    Array.isArray(buttons) && Array.isArray(widgets) && buttons.length + widgets.length <= (rows as number) * (columns as number) &&
    buttons.every((button) => validDeckButton(button) && (allowFolderButtons || button.action.type !== 'open_folder')) && widgets.every(validDeckWidget) &&
    validSurfaceLayout(value as Parameters<typeof validSurfaceLayout>[0]);
}

function validDeckPage(value: unknown): value is DeckPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Partial<DeckPage>;
  return typeof page.id === 'string' && typeof page.name === 'string' && validSurface({ ...page }, true) &&
    Array.isArray(page.folders) && page.folders.length <= 12 &&
    page.folders.every((folder) => folder && typeof folder.id === 'string' && typeof folder.name === 'string' && validSurface({ ...folder }, false)) &&
    (page.buttons ?? []).every((button) => button.action.type !== 'open_folder' || (page.folders ?? []).some((folder) => folder.id === (button.action as { folderId?: string }).folderId));
}

function validDeckConfig(value: unknown): value is DeckConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<DeckConfig>;
  return config.schemaVersion === 1 && Number.isSafeInteger(config.revision) && Array.isArray(config.profiles) && config.profiles.length > 0 && config.profiles.length <= 32 &&
    config.profiles.every((profile) => profile && typeof profile.id === 'string' && typeof profile.name === 'string' && Array.isArray(profile.pages) && profile.pages.length > 0 && profile.pages.length <= 32 &&
      profile.pages.every(validDeckPage));
}

// Whether a deck button (anywhere in the config) is a play/pause media key.
function isPlayPauseButton(config: DeckConfig, buttonId: string): boolean {
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(visit);
    const record = value as Record<string, unknown>;
    if (record.id === buttonId && record.action && typeof record.action === 'object') {
      const action = record.action as { type?: string; command?: string };
      if (action.type === 'media' && action.command === 'play_pause') return true;
    }
    return Object.values(record).some(visit);
  };
  return visit(config.profiles);
}

/** The play position now: the last report, counted forward while playing. */
export function livePositionMs(media: SystemMediaState, now = Date.now()): number {
  const rate = media.playbackState === 'playing' ? media.playbackRate ?? 1 : 0;
  return Math.max(0, (media.positionMs ?? 0) + Math.max(0, now - (media.receivedAt ?? now)) * rate);
}

// Media state lives outside the connection context: the play position changes it every few seconds,
// and only Now Playing and Lyrics show it. In the context, each change re-rendered the whole deck.
let mediaSnapshot: SystemMediaState = EMPTY_MEDIA_STATE;
const mediaListeners = new Set<() => void>();
function setMediaState(next: SystemMediaState | ((current: SystemMediaState) => SystemMediaState)) {
  const value = typeof next === 'function' ? next(mediaSnapshot) : next;
  if (value === mediaSnapshot) return;
  mediaSnapshot = value;
  setPetWorld({ music: value.playbackState === 'playing' });
  mediaListeners.forEach((listener) => listener());
}
const subscribeMedia = (listener: () => void) => { mediaListeners.add(listener); return () => { mediaListeners.delete(listener); }; };
/** The PC's media session (title, artwork, position...). Re-renders only the component that calls it. */
export function useMediaState(): SystemMediaState {
  return useSyncExternalStore(subscribeMedia, () => mediaSnapshot);
}

export function ConnectionProvider({ children }: PropsWithChildren) {
  const socketRef = useRef<WebSocket | null>(null);
  const widgetSurfaceRef = useRef<WidgetSurface | null>(null);
  const pendingRequestsRef = useRef(new Set<string>());
  const signatureReplyRef = useRef<((error: string | null) => void) | null>(null);
  const editRepliesRef = useRef(new Map<string, (error: string | null) => void>());
  const voiceRepliesRef = useRef(new Map<string, (result: { ok: boolean; text: string }) => void>());
  const openConnectionRef = useRef<((next: PcConnection, retrying: boolean) => void) | null>(null);
  // Resolves once the saved pairings are loaded. A pairing link can open the app before that, and `connect` must not run first.
  const [restored] = useState(() => {
    let done = () => {};
    const promise = new Promise<void>((resolve) => { done = resolve; });
    return { promise, done: () => done() };
  });
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const targetRef = useRef<PcConnection | null>(null);
  const discoveringRef = useRef(false);
  // Set once the PC has accepted the key. Anything else it receives before that is answered "unauthorized".
  const authenticatedRef = useRef(false);
  const unauthorizedRef = useRef(false);
  const shouldReconnectRef = useRef(false);
  const terminalErrorRef = useRef(false);
  const [connection, setConnection] = useState<PcConnection | null>(null);
  const [pairedDevices, setPairedDevices] = useState<PcConnection[]>([]);
  const pairedDevicesRef = useRef<PcConnection[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [protocolError, setProtocolError] = useState<string | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('unavailable');
  // Play/pause shows its new state the moment it's pressed. For 1.5 s after, reports of the old state
  // were sent before the press took effect and are ignored; the PC confirms within ~300 ms.
  const playbackRef = useRef<PlaybackState>('unavailable');
  const expectedPlaybackRef = useRef<{ state: PlaybackState; until: number } | null>(null);
  // What the PC last said, so a press the PC never confirmed does not leave the wrong state showing.
  const lastReportedPlaybackRef = useRef<PlaybackState | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mediaPlayers, setMediaPlayers] = useState<PlayersState | null>(null);
  const [deckConfig, setDeckConfig] = useState<DeckConfig | null>(null);
  const [independentNavigation, setIndependentNavigation] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ConnectionContextValue['actionError']>(null);

  useEffect(() => { playbackRef.current = playbackState; }, [playbackState]);
  // In the background the PC stops sending media and playback updates, so the phone's radio and
  // JavaScript can rest; coming back fetches one fresh snapshot.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && authenticatedRef.current) socket.send(JSON.stringify({ type: 'set_streaming', active: state === 'active' }));
      // Opening the app is a reason to try right now, not after the backoff.
      else if (state === 'active' && shouldReconnectRef.current && targetRef.current) {
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        reconnectAttemptRef.current = 0;
        openConnectionRef.current?.(targetRef.current, true);
      }
    });
    return () => subscription.remove();
  }, []);
  // The playback state to show for a report from the PC, or null to keep the pressed state.
  const settlePlayback = (reported: PlaybackState): PlaybackState | null => {
    lastReportedPlaybackRef.current = reported;
    const result = settle(expectedPlaybackRef.current, reported, Date.now());
    expectedPlaybackRef.current = result.expected;
    return result.show;
  };

  const persistPairedDevices = useCallback((devices: PcConnection[]) => {
    pairedDevicesRef.current = devices;
    setPairedDevices(devices);
    return SecureStore.setItemAsync(PAIRED_KEY, JSON.stringify(devices));
  }, []);

  const openConnection = useCallback((next: PcConnection, retrying = false) => {
    pendingRequestsRef.current.clear();
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    const previous = socketRef.current;
    socketRef.current = null;
    previous?.close();
    if (!retrying) {
      shouldReconnectRef.current = true;
      terminalErrorRef.current = false;
      reconnectAttemptRef.current = 0;
    }
    targetRef.current = next;
    authenticatedRef.current = false;
    if (!retrying) unauthorizedRef.current = false;
    setConnection(next);
    setStatus('connecting');
    if (!retrying) {
      setDeckConfig(null);
      setIndependentNavigation(false);
      setSelectedProfileId(null);
      setSelectedPageId(null);
      setProtocolError(null);
      setPlaybackState('unavailable');
      setMediaPlayers(null);
      lastReportedPlaybackRef.current = null;
      setMediaState(EMPTY_MEDIA_STATE);
      setActionError(null);
      clearPcStats();
    }

    const retry = () => {
      if (!shouldReconnectRef.current) return;
      const attempt = reconnectAttemptRef.current;
      // Keep trying in the background so the deck comes back by itself when the PC does; show it as offline meanwhile.
      setStatus(unauthorizedRef.current ? 'error' : attempt >= MAX_RECONNECT_ATTEMPTS ? 'disconnected' : 'connecting');
      // A PC that is not answering may have a new address on this Wi-Fi (or the cable came out): look for it by name and follow it there.
      // Scans early and then about every two minutes: a /24 sweep is 254 requests, and repeating it every 12 s while the PC is off leaks memory.
      if (next.deviceName && !discoveringRef.current && AppState.currentState === 'active' && (attempt <= 2 || attempt % 30 === 0)) {
        discoveringRef.current = true;
        void findPcs().then((pcs) => {
          const moved = pcs.find((pc) => pc.name === next.deviceName && (next.transport === 'usb' || pc.host !== next.host || pc.port !== next.port));
          // A scan takes seconds; by then the link may be back (socket open) or the user may have moved on.
          if (moved && shouldReconnectRef.current && targetRef.current?.deviceName === next.deviceName && socketRef.current?.readyState !== WebSocket.OPEN) {
            const found = { ...next, host: moved.host, port: moved.port, transport: 'wifi' as const };
            openConnectionRef.current?.(found, true);
            // Remember the new address, so the next start and Retry go straight there.
            void persistPairedDevices(pairedDevicesRef.current.map((device) => connectionId(device) === connectionId(next) ? found : device));
            void SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(found));
          }
        }).catch(() => undefined).finally(() => { discoveringRef.current = false; });
      }
      // Alternate between Wi-Fi and the USB cable, so whichever link is up takes over by itself.
      const other: PcConnection | null = Platform.OS !== 'android' ? null
        : next.transport === 'usb' ? (isLoopback(next.host) ? null : { ...next, transport: 'wifi' })
          : { ...next, transport: 'usb' };
      // Quick, steady tries (1, 2, then every 4 s): the deck should be back within seconds of the PC.
      const delay = unauthorizedRef.current ? 10_000 : Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** attempt);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (shouldReconnectRef.current) openConnectionRef.current?.(other ?? next, true);
      }, delay);
    };

    try {
      const socket = new WebSocket(websocketUrl(next));
      socketRef.current = socket;
      let opened = false;
      const giveUp = setTimeout(() => {
        if (opened || socketRef.current !== socket) return;
        socketRef.current = null;
        try { socket.close(); } catch { /* it never opened */ }
        setPcStatsSender(null);
        pendingRequestsRef.current.clear();
        if (shouldReconnectRef.current) retry();
        else if (!terminalErrorRef.current) setStatus('disconnected');
      }, CONNECT_TIMEOUT_MS);
      // Only on a fresh connect: re-parsing the cached deck (with its icons) on every retry while the PC is away exhausts memory.
      if (!retrying) void Storage.getItem(`${DECK_CACHE_KEY}.${connectionId(next)}`).then((saved) => {
        if (socketRef.current !== socket || !saved) return;
        try {
          const cached: unknown = JSON.parse(saved);
          if (validDeckConfig(cached)) setDeckConfig((current) => current && current.revision > cached.revision ? current : cached);
        } catch {
          void Storage.removeItem(`${DECK_CACHE_KEY}.${connectionId(next)}`);
        }
      });
      socket.onopen = () => {
        opened = true;
        clearTimeout(giveUp);
        void Promise.all([legacyDeckForPairing(next), Storage.getItem(`${DEVICE_SELECTION_KEY}.${connectionId(next)}`), phoneIdentity()]).then(([legacyDeck, savedSelection, identity]) => {
          let selection: { profileId: string; pageId: string } | null = null;
          try {
            const parsed = savedSelection ? JSON.parse(savedSelection) as Partial<{ profileId: string; pageId: string }> : null;
            if (typeof parsed?.profileId === 'string' && typeof parsed.pageId === 'string') selection = { profileId: parsed.profileId, pageId: parsed.pageId };
          } catch { void Storage.removeItem(`${DEVICE_SELECTION_KEY}.${connectionId(next)}`); }
          if (socketRef.current === socket) socket.send(JSON.stringify({ type: 'authenticate', token: next.token, protocolVersion: 2, legacyDeckAvailable: Boolean(legacyDeck), supportsIndependentNavigation: true, ...identity, ...(selection ? { selectedProfileId: selection.profileId, selectedPageId: selection.pageId } : {}), ...(legacyDeck ? { legacySourceId: legacyDeck.sourceId } : {}) }));
          else socket.close();
        }).catch(async () => {
          // Whatever failed above, the PC still needs to know which phone this is, or it shows the shared deck.
          const identity = await phoneIdentity().catch(() => null);
          if (socketRef.current === socket) socket.send(JSON.stringify({ type: 'authenticate', token: next.token, protocolVersion: 2, supportsIndependentNavigation: true, ...(identity ?? {}) }));
        });
      };
      socket.onmessage = async (event) => {
        if (socketRef.current !== socket || typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data) as { type?: string; name?: string; message?: string; state?: unknown; ok?: boolean; reason?: string; error?: unknown; requestId?: string; sourceId?: string; volumePercent?: unknown; done?: unknown; game?: unknown };
          countMessage(message.type ?? 'unknown');
          if (message.type === 'ready') {
            // The PC's own name for itself replaces whatever the pairing saved (often its IP address).
            const pcName = typeof message.name === 'string' ? message.name.trim() : '';
            if (pcName && pcName !== next.deviceName) {
              const renamed = { ...next, deviceName: pcName };
              setConnection((current) => current && connectionId(current) === connectionId(next) ? renamed : current);
              void persistPairedDevices(pairedDevicesRef.current.map((device) => connectionId(device) === connectionId(next) ? renamed : device));
              void SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(renamed));
            }
            reconnectAttemptRef.current = 0;
            unauthorizedRef.current = false;
            authenticatedRef.current = true;
            setStatus('connected');
            if (widgetSurfaceRef.current) socket.send(JSON.stringify({ type: 'widget_surface', surface: widgetSurfaceRef.current }));
            // In the background the PC sends nothing (see the AppState effect in this provider).
            if (AppState.currentState !== 'active') socket.send(JSON.stringify({ type: 'set_streaming', active: false }));
            // The PC samples only the readings the stats widgets on screen show.
            setPcStatsSender((needs) => { if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'pc_stats_subscribe', needs })); });
          }
          if (message.type === 'playback_state' && typeof message.state === 'string' && ['playing', 'paused', 'stopped', 'unavailable'].includes(message.state)) {
            // This check runs every 500 ms (100 ms after a control), faster than the media state, so
            // it also updates Now Playing's play/pause.
            const settled = settlePlayback(message.state as PlaybackState);
            if (settled) {
              setPlaybackState(settled);
              setMediaState((current) => current.playbackState === settled || current.playbackState === 'unavailable' ? current : { ...current, playbackState: settled });
            }
          }
          if (message.type === 'media_players') {
            const parsed = parsePlayers(message);
            if (parsed) setMediaPlayers(parsed);
          }
          if (message.type === 'media_state') {
            const state = message.state;
            if (!state || typeof state !== 'object' || Array.isArray(state)) {
              setMediaState(EMPTY_MEDIA_STATE);
            } else {
              const value = state as Record<string, unknown>;
              const text = (key: string, max: number) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= max ? value[key] as string : undefined;
              const number = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) >= 0 && (value[key] as number) <= 86_400_000 ? value[key] as number : undefined;
              const playback = value.playbackState;
              const artwork = text('artworkDataUrl', 2_800_000);
              const reported: PlaybackState = typeof playback === 'string' && ['playing', 'paused', 'stopped', 'unavailable'].includes(playback) ? playback as PlaybackState : 'unavailable';
              const settled = settlePlayback(reported);
              setMediaState((current) => ({
                sourceAppId: text('sourceAppId', 256),
                sourceName: text('sourceName', 64),
                title: text('title', 512),
                artist: text('artist', 512),
                album: text('album', 512),
                playbackState: settled ?? current.playbackState,
                positionMs: number('positionMs'),
                durationMs: number('durationMs'),
                volumePercent: typeof value.volumePercent === 'number' && Number.isFinite(value.volumePercent) && value.volumePercent >= 0 && value.volumePercent <= 100 ? Math.round(value.volumePercent) : undefined,
                canSeek: value.canSeek === true,
                playbackRate: playbackRate(value.playbackRate),
                receivedAt: Date.now(),
                artworkDataUrl: artwork && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(artwork) ? artwork : undefined,
              }));
            }
          }
          if (message.type === 'pet_context') setPetWorld({ game: typeof message.game === 'string' && message.game.length <= 64 ? message.game : null });
          if (message.type === 'pc_stats') receivePcStats(message as { history?: unknown; stats?: unknown });
          if (message.type === 'media_progress') {
            const progress = message as { playbackState?: unknown; positionMs?: unknown; durationMs?: unknown; volumePercent?: unknown; playbackRate?: unknown };
            const finiteTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000 ? value : undefined;
            setMediaState((current) => ({
              ...current,
              playbackState: typeof progress.playbackState === 'string' && ['playing', 'paused', 'stopped', 'unavailable'].includes(progress.playbackState) ? settlePlayback(progress.playbackState as PlaybackState) ?? current.playbackState : current.playbackState,
              positionMs: finiteTime(progress.positionMs),
              durationMs: finiteTime(progress.durationMs),
              playbackRate: playbackRate(progress.playbackRate),
              receivedAt: Date.now(),
              volumePercent: typeof progress.volumePercent === 'number' && Number.isFinite(progress.volumePercent) && progress.volumePercent >= 0 && progress.volumePercent <= 100 ? Math.round(progress.volumePercent) : current.volumePercent,
            }));
          }
          if (message.type === 'signature_result') {
            signatureReplyRef.current?.(message.ok ? null : typeof message.error === 'string' ? message.error : 'Could not paste the signature');
            signatureReplyRef.current = null;
          }
          if (message.type === 'voice_result' && message.requestId) {
            const text = message.ok ? typeof message.done === 'string' ? message.done : 'Done' : typeof message.error === 'string' ? message.error : 'The PC could not do that';
            voiceRepliesRef.current.get(message.requestId)?.({ ok: Boolean(message.ok), text });
          }
          if (message.type === 'edit_result' && message.requestId) {
            const error = message.ok ? null : message.error === 'stale_revision' ? 'The deck changed on the PC. Try again.' : typeof message.error === 'string' ? message.error : 'The PC could not save that button';
            editRepliesRef.current.get(message.requestId)?.(error);
          }
          if (message.type === 'action_result' && message.requestId && pendingRequestsRef.current.delete(message.requestId)) {
            const reason = message.reason;
            setActionError(message.ok ? null : reason === 'accessibility_permission_required' || reason === 'app_launch_failed' || reason === 'stale_revision' || reason === 'unknown_button' ? reason : 'control_failed');
          }
          if (message.type === 'deck_snapshot') {
            const snapshot = JSON.parse(event.data) as { protocolVersion?: number; config?: unknown; independentNavigation?: boolean; selection?: { profileId?: string; pageId?: string } };
            const config = snapshot.config;
            if (snapshot.protocolVersion === 2 && validDeckConfig(config)) {
              setDeckConfig(config);
              const selectedProfile = config.profiles.find((profile) => profile.id === snapshot.selection?.profileId) ?? config.profiles.find((profile) => profile.id === config.activeProfileId);
              const selectedPage = selectedProfile?.pages.find((page) => page.id === snapshot.selection?.pageId) ?? selectedProfile?.pages.find((page) => page.id === selectedProfile.activePageId);
              setIndependentNavigation(snapshot.independentNavigation === true);
              setSelectedProfileId(selectedProfile?.id ?? null);
              setSelectedPageId(selectedPage?.id ?? null);
              if (snapshot.independentNavigation === true && selectedProfile && selectedPage) {
                void Storage.setItem(`${DEVICE_SELECTION_KEY}.${connectionId(next)}`, JSON.stringify({ profileId: selectedProfile.id, pageId: selectedPage.id }));
              }
              void Storage.setItem(`${DECK_CACHE_KEY}.${connectionId(next)}`, JSON.stringify(config));
              void SecureStore.getItemAsync(LEGACY_SOURCE_KEY).then((sourceId) => {
                if (sourceId && config.profiles.some((profile) => profile.id === `import-${sourceId}`)) {
                  return SecureStore.setItemAsync(`${LEGACY_IMPORTED_KEY}.${connectionId(next)}`, 'true');
                }
              }).catch(() => {});
            } else {
              setStatus('error');
            }
          }
          if (message.type === 'legacy_deck_request' && message.sourceId) {
            void legacyDeckForPairing(next).then((legacyDeck) => {
              if (legacyDeck && legacyDeck.sourceId === message.sourceId && socketRef.current === socket) {
                socket.send(JSON.stringify({ type: 'legacy_deck', legacyDeck }));
              }
            });
          }
          if (message.type === 'error' && message.message === 'unauthorized') {
            // Not final: the PC also says this to a message that arrives before the key, or while it starts up.
            // Keep trying slowly, so a pairing the PC takes back shows as an error but a hiccup heals itself.
            unauthorizedRef.current = true;
            setStatus('error');
            socket.close();
          }
          if (message.type === 'error' && message.message === 'update_required') {
            shouldReconnectRef.current = false;
            terminalErrorRef.current = true;
            setProtocolError('Update the Open Dock desktop app to connect to this phone app.');
            setStatus('error');
            socket.close();
          }
        } catch {
          setStatus('error');
        }
      };
      socket.onerror = () => {
        if (socketRef.current === socket) setStatus('error');
      };
      socket.onclose = () => {
        clearTimeout(giveUp);
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        setPcStatsSender(null);
        pendingRequestsRef.current.clear();
        if (shouldReconnectRef.current) retry();
        else if (!terminalErrorRef.current) setStatus('disconnected');
      };
    } catch {
      socketRef.current = null;
      setStatus('error');
      retry();
    }
  }, [persistPairedDevices]);

  useEffect(() => {
    openConnectionRef.current = openConnection;
    return () => { openConnectionRef.current = null; };
  }, [openConnection]);

  // On Wi-Fi, check now and then whether a USB cable is in (the PC keeps an adb reverse tunnel up while it is) and move to it.
  useEffect(() => {
    if (Platform.OS !== 'android' || status !== 'connected' || !connection || connection.transport === 'usb') return;
    const target = connection;
    const timer = setInterval(() => {
      const probe = new WebSocket(websocketUrl({ ...target, transport: 'usb' }));
      const done = setTimeout(() => probe.close(), 2000);
      probe.onopen = () => {
        clearTimeout(done);
        probe.close();
        if (shouldReconnectRef.current) openConnectionRef.current?.({ ...target, transport: 'usb' }, true);
      };
      probe.onerror = () => clearTimeout(done);
    }, USB_PROBE_MS);
    return () => clearInterval(timer);
  }, [status, connection]);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      const pairedValue = await SecureStore.getItemAsync(PAIRED_KEY);
      if (pairedValue) {
        try {
          const savedDevices = JSON.parse(pairedValue) as PcConnection[];
          if (Array.isArray(savedDevices)) {
            const validDevices = savedDevices.filter((device) => device && typeof device.host === 'string' && device.host && Number.isInteger(device.port) && typeof device.token === 'string' && device.token);
            pairedDevicesRef.current = validDevices;
            setPairedDevices(validDevices);
          }
        } catch {
          void SecureStore.deleteItemAsync(PAIRED_KEY);
        }
      }
      const saved = await SecureStore.getItemAsync(STORAGE_KEY);
      const legacy = saved ? null : await SecureStore.getItemAsync(LEGACY_STORAGE_KEY);
      const value = saved ?? legacy;
      if (!active || !value) return;
      try {
        const parsed = JSON.parse(value) as PcConnection;
        if (parsed.host && parsed.port && parsed.token) {
          if (legacy) {
            await SecureStore.setItemAsync(STORAGE_KEY, legacy);
            await SecureStore.deleteItemAsync(LEGACY_STORAGE_KEY);
          }
          if (!active) return;
          const device = { ...parsed, deviceName: parsed.deviceName || parsed.host };
          void persistPairedDevices([device, ...pairedDevicesRef.current.filter((item) => connectionId(item) !== connectionId(device))]);
          openConnection(device);
        }
      } catch {
        void SecureStore.deleteItemAsync(STORAGE_KEY);
        void SecureStore.deleteItemAsync(LEGACY_STORAGE_KEY);
      }
    };
    void restore().finally(() => restored.done());
    return () => {
      active = false;
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [openConnection, persistPairedDevices, restored]);

  const connect = useCallback(async (next: PcConnection) => {
    await restored.promise;
    const device = { ...next, deviceName: next.deviceName?.trim() || next.host };
    openConnection(device);
    const updated = [device, ...pairedDevicesRef.current.filter((item) => connectionId(item) !== connectionId(device))];
    await Promise.all([
      persistPairedDevices(updated),
      SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(device)),
    ]);
  }, [openConnection, persistPairedDevices, restored]);

  const disconnect = useCallback(async () => {
    pendingRequestsRef.current.clear();
    shouldReconnectRef.current = false;
    terminalErrorRef.current = false;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, 'Disconnected by user');
    setConnection(null);
    setStatus('disconnected');
    setPlaybackState('unavailable');
    setMediaPlayers(null);
    lastReportedPlaybackRef.current = null;
    setMediaState(EMPTY_MEDIA_STATE);
    setIndependentNavigation(false);
    setSelectedProfileId(null);
    setSelectedPageId(null);
    setActionError(null);
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  }, []);

  const removePairedDevice = useCallback(async (id: string) => {
    if (connection && connectionId(connection) === id) await disconnect();
    await persistPairedDevices(pairedDevicesRef.current.filter((device) => connectionId(device) !== id));
  }, [connection, disconnect, persistPairedDevices]);

  const sendRequest = useCallback((type: string, idField: string, id: string | number, extra?: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (status !== 'connected' || socket?.readyState !== WebSocket.OPEN || !deckConfig) return false;
    setActionError(null);
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingRequestsRef.current.add(requestId);
    try {
      socket.send(JSON.stringify({ type, requestId, revision: deckConfig.revision, [idField]: id, ...extra }));
    } catch {
      pendingRequestsRef.current.delete(requestId);
      setActionError('control_failed');
      return false;
    }
    return true;
  }, [deckConfig, status]);
  // Shows a play/pause press immediately; the PC's report confirms it (see settlePlayback).
  const showPlayPausePressed = useCallback(() => {
    const now = playbackRef.current;
    if (now === 'unavailable') return;
    const next: PlaybackState = now === 'playing' ? 'paused' : 'playing';
    expectedPlaybackRef.current = { state: next, until: Date.now() + 1500 };
    setPlaybackState(next);
    setMediaState((current) => ({ ...current, playbackState: next, positionMs: livePositionMs(current), receivedAt: Date.now() }));
    // If the PC has not confirmed the press by then, go back to what it last reported.
    if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = setTimeout(() => {
      expiryTimerRef.current = null;
      const result = expire(expectedPlaybackRef.current, lastReportedPlaybackRef.current, Date.now());
      if (result.expected === expectedPlaybackRef.current) return;
      expectedPlaybackRef.current = result.expected;
      const back = result.show;
      if (back) {
        setPlaybackState(back);
        setMediaState((current) => ({ ...current, playbackState: back, positionMs: livePositionMs(current), receivedAt: Date.now() }));
      }
    }, 1600);
  }, []);
  const sendButton = useCallback((buttonId: string, longPress = false) => {
    const sent = sendRequest('invoke_button', 'buttonId', buttonId, longPress ? { longPress: true } : undefined);
    if (sent && !longPress && deckConfig && isPlayPauseButton(deckConfig, buttonId)) showPlayPausePressed();
    return sent;
  }, [sendRequest, deckConfig, showPlayPausePressed]);
  const sendMediaCommand = useCallback((command: DeckMediaCommand) => {
    const sent = sendRequest('invoke_media_command', 'command', command);
    if (sent && command === 'play_pause') showPlayPausePressed();
    return sent;
  }, [sendRequest, showPlayPausePressed]);
  const sendSystemVolume = useCallback((volumePercent: number) => sendRequest('set_system_volume', 'volumePercent', Math.round(Math.max(0, Math.min(100, volumePercent)))), [sendRequest]);
  const seekMedia = useCallback((positionMs: number) => sendRequest('seek_media', 'positionMs', Math.round(Math.max(0, positionMs))), [sendRequest]);
  const selectMediaPlayer = useCallback((playerId: string | null) => {
    const socket = socketRef.current;
    if (status !== 'connected' || socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify({ type: 'select_media_player', playerId }));
      return true;
    } catch {
      return false;
    }
  }, [status]);
  // Without the PC, the phone still moves through its saved copy of the deck; the PC's next snapshot takes over again.
  const navigateLocally = useCallback((profileId: string | null, pageId: string | null) => {
    const profile = deckConfig?.profiles.find((item) => profileId ? item.id === profileId : item.pages.some((page) => page.id === pageId));
    if (!deckConfig || !profile) return false;
    const page = pageId ?? profile.activePageId;
    setDeckConfig({ ...deckConfig, activeProfileId: profile.id, profiles: deckConfig.profiles.map((item) => item.id === profile.id ? { ...item, activePageId: page } : item) });
    setSelectedProfileId(profile.id);
    setSelectedPageId(page);
    return true;
  }, [deckConfig]);
  const selectProfile = useCallback((profileId: string) => sendRequest('select_profile', 'profileId', profileId) || (status !== 'connected' && navigateLocally(profileId, null)), [sendRequest, navigateLocally, status]);
  const selectPage = useCallback((pageId: string) => sendRequest('select_page', 'pageId', pageId) || (status !== 'connected' && navigateLocally(null, pageId)), [sendRequest, navigateLocally, status]);
  // Tells the desktop how big the phone's widget area is, so its Now Playing preview matches.
  // The latest value is resent after every reconnect.
  const reportWidgetSurface = useCallback((surface: WidgetSurface) => {
    const previous = widgetSurfaceRef.current;
    if (previous && (Object.keys(surface) as (keyof WidgetSurface)[]).every((key) => previous[key] === surface[key])) return;
    widgetSurfaceRef.current = surface;
    const socket = socketRef.current;
    if (status === 'connected' && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'widget_surface', surface }));
  }, [status]);

  const sendPointer = useCallback((event: PointerEvent) => {
    const socket = socketRef.current;
    if (status !== 'connected' || socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify({ type: 'pointer', event }));
      return true;
    } catch {
      return false;
    }
  }, [status]);

  const sendSignature = useCallback((strokes: [number, number][][]) => new Promise<string | null>((resolve) => {
    const socket = socketRef.current;
    if (status !== 'connected' || socket?.readyState !== WebSocket.OPEN) return resolve('Connect to your PC first');
    signatureReplyRef.current?.('Replaced by a newer signature');
    const timer = setTimeout(() => { if (signatureReplyRef.current === reply) { signatureReplyRef.current = null; resolve('The PC did not answer'); } }, 15_000);
    const reply = (error: string | null) => { clearTimeout(timer); resolve(error); };
    signatureReplyRef.current = reply;
    try {
      socket.send(JSON.stringify({ type: 'signature', strokes }));
    } catch {
      signatureReplyRef.current = null;
      reply('Could not reach the PC');
    }
  }), [status]);

  const editButton = useCallback((edit: { pageId: string; folderId?: string; button?: DeckButton; removeId?: string }) => new Promise<string | null>((resolve) => {
    const socket = socketRef.current;
    if (status !== 'connected' || socket?.readyState !== WebSocket.OPEN || !deckConfig) return resolve('Connect to your PC first');
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replies = editRepliesRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = (error: string | null) => { clearTimeout(timer); replies.delete(requestId); resolve(error); };
    timer = setTimeout(() => reply('The PC did not answer'), 10_000);
    replies.set(requestId, reply);
    try {
      socket.send(JSON.stringify({ type: 'edit_button', requestId, revision: deckConfig.revision, ...edit }));
    } catch {
      reply('Could not reach the PC');
    }
  }), [deckConfig, status]);

  const sendVoiceState = useCallback((listening: boolean, text: string) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify({ type: 'voice_state', listening, text })); } catch { /* the island is a nicety */ }
  }, []);

  const sendVoice = useCallback((text: string) => new Promise<{ ok: boolean; text: string }>((resolve) => {
    const socket = socketRef.current;
    if (status !== 'connected' || socket?.readyState !== WebSocket.OPEN) return resolve({ ok: false, text: 'Connect to your PC first' });
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replies = voiceRepliesRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = (result: { ok: boolean; text: string }) => { clearTimeout(timer); replies.delete(requestId); resolve(result); };
    timer = setTimeout(() => reply({ ok: false, text: 'The PC did not answer' }), 10_000);
    replies.set(requestId, reply);
    try {
      socket.send(JSON.stringify({ type: 'voice_command', requestId, text }));
    } catch {
      reply({ ok: false, text: 'Could not reach the PC' });
    }
  }), [status]);

  return (
    <ConnectionContext.Provider value={{ connection, pairedDevices, status, protocolError, playbackState, mediaPlayers, selectMediaPlayer, deckConfig, independentNavigation, selectedProfileId, selectedPageId, actionError, connect, disconnect, removePairedDevice, sendButton, sendMediaCommand, sendSystemVolume, seekMedia, selectProfile, selectPage, reportWidgetSurface, sendPointer, sendSignature, editButton, sendVoice, sendVoiceState }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function usePcConnection() {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error('usePcConnection must be used inside ConnectionProvider');
  return value;
}
