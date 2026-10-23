import appIcon from '../src-tauri/icons/128x128.png';
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import {
  AppWindow,
  ChevronUp,
  Check,
  ChevronDown,
  Command,
  Copy,
  File,
  FolderOpen,
  Headphones,
  Layers,
  Keyboard,
  Layers2,
  Package,
  LayoutDashboard,
  ListOrdered,
  Mic,
  Monitor,
  Music,
  PanelsTopLeft,
  PanelRight,
  X,
  Pause,
  Play,
  QrCode,
  Plus,
  Trash2,
  Ellipsis,
  FolderClosed,
  ArrowLeft,
  ChevronRight,
  Star,
  Settings,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Smartphone,
  Wifi,
  Volume1,
  Volume2,
  VolumeX,
  Zap,
  Lock,
  Moon,
  Power,
  RotateCcw,
  LogOut,
  Sun,
  SunDim,
  Camera,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import "./App.css";
import { NowPlayingPreview, REFERENCE_WIDGET_SURFACE } from "./NowPlayingPreview";
import { LyricsPreview } from "./LyricsPreview";
import { ClockFacePreview } from "./clock-faces/ClockFacePreview";
import { ClockWidgetSettings } from "./clock-faces/ClockSettings";
import { PcStatsPreview } from "./pc-stats/PcStatsPreview";
import { PcStatsSettings } from "./pc-stats/PcStatsSettings";
import { DeckLibrary, type LibraryChoice } from "./DeckLibrary";
import { AppPicker } from "./AppPicker";
import { DeckSelect } from "./DeckSelect";
import { PanelHeader, PanelSection } from "./SettingsPanel";
import { applyPageMove, clonePage, copyName, fitBytes, freshId, planPageMove, reorderProfile, type MoveDecisions, type MoveRequest, type Resolution } from "./deck-move";
import { canReceiveIcon, type IconTarget } from "./deck-icons";
import { buttonPlacement, canPlaceWidgetItem, defaultSpan, firstWidgetPlacement, fitPlacement, swapPlacements } from "./deck-grid";
import { widgetBlockSize, type WidgetSurface } from "./now-playing-layout";
import { version } from "../package.json";
import { UpdatesSetting, useUpdater } from "./updates";
import { AppearanceSetting, inkIcon, useTheme } from "./theme";

type ConnectionInfo = {
  host: string;
  deviceName: string;
  port: number;
  token: string;
  activeDevices: number;
  serverOnline: boolean;
  isMacos: boolean;
  androidUsbEnabled: boolean;
  androidUsb: { status: string; phone: string; detail: string };
  widgetSurface: WidgetSurface | null;
  pin: string;
};

type SystemCommand = 'lock' | 'sleep' | 'restart' | 'shutdown' | 'sign_out' | 'brightness_up' | 'brightness_down' | 'screenshot';
const SYSTEM_COMMANDS: [SystemCommand, string][] = [['screenshot', 'Screenshot'], ['lock', 'Lock'], ['sleep', 'Sleep'], ['brightness_up', 'Brightness up'], ['brightness_down', 'Brightness down'], ['sign_out', 'Sign out'], ['restart', 'Restart'], ['shutdown', 'Shut down']];
type MediaCommand = 'play_pause' | 'next_track' | 'previous_track' | 'volume_up' | 'volume_down' | 'mute';
type DeckStep = { type: 'media'; command: MediaCommand } | { type: 'hotkey'; keys: string[] } | { type: 'launch_app'; app: string } | { type: 'launch_file'; path: string } | { type: 'launch_folder'; path: string };
type DeckAction = DeckStep | { type: 'run_script'; path: string; allowOnPc: boolean } | { type: 'plugin_action'; pluginId: string; actionId: string; allowOnPc: boolean; inputs: Record<string, string> } | { type: 'launch_app'; app: string } | { type: 'sequence'; steps: DeckStep[] } | { type: 'select_profile'; profileId: string } | { type: 'select_page'; pageId: string } | { type: 'open_folder'; folderId: string } | { type: 'system'; command: SystemCommand };
type OpenDockPluginInput = { id: string; label: string; type: 'text' | 'number' | 'select'; default: string; options: string[]; optionLabels: string[] };
type OpenDockPluginWidget = { id: string; name: string; description: string; type: 'text'; inputs: OpenDockPluginInput[] };
type OpenDockPlugin = { id: string; name: string; version: string; description: string; actions: { id: string; name: string; description: string; script: string; inputs: OpenDockPluginInput[] }[]; widgets: OpenDockPluginWidget[] };
type OpenDockPluginListing = { plugins: OpenDockPlugin[]; warnings: string[] };
type DeckPlacement = { row: number; column: number; rowSpan: number; columnSpan: number };
type DeckButton = { id: string; label: string; icon: string; placement?: DeckPlacement; iconSvg?: string; appIconData?: string; action: DeckAction };
type DeckWidget = { id: string; type: 'clock'; placement: DeckPlacement; face?: string; color?: string } | { id: string; type: 'now_playing'; placement: DeckPlacement } | { id: string; type: 'lyrics'; placement: DeckPlacement } | { id: string; type: 'pc_stats'; placement: DeckPlacement; face?: string; metric?: string; color?: string; gpu?: string } | { id: string; type: 'plugin'; pluginId: string; widgetId: string; renderType: string; values: Record<string, string>; placement: DeckPlacement };
type WidgetScreen = { enabled: boolean; rows: number; columns: number; buttons: DeckButton[]; widgets: DeckWidget[] };
type PlaybackState = 'playing' | 'paused' | 'stopped' | 'unavailable';
type SystemMediaState = { sourceAppId?: string | null; title?: string | null; artist?: string | null; album?: string | null; playbackState: PlaybackState; positionMs?: number | null; durationMs?: number | null; artworkDataUrl?: string | null; volumePercent?: number | null; canSeek?: boolean; playbackRate?: number | null };
type SystemMediaProgress = Pick<SystemMediaState, 'playbackState' | 'positionMs' | 'durationMs' | 'volumePercent' | 'playbackRate'>;
type LucideRegistry = Record<string, typeof Command>;
type DeckFolder = { id: string; name: string; rows: number; columns: number; buttons: DeckButton[]; widgets: DeckWidget[] };
type DeckPage = { id: string; name: string; rows: number; columns: number; buttons: DeckButton[]; widgets: DeckWidget[]; folders: DeckFolder[] };
type DeckProfile = { id: string; name: string; pages: DeckPage[]; activePageId: string; defaultPageId: string; autoSwitchApps: string[]; autoSwitchEnabled: boolean };
type DeckConfig = { schemaVersion: number; revision: number; profiles: DeckProfile[]; activeProfileId: string; fallbackProfileId: string; migrationNotes?: string[] };
type LegacyImportSummary = { sourceId: string; pages: number; buttons: number; requested: boolean; ready: boolean };

function buttonsOf(profile: DeckProfile): DeckButton[] {
  return profile.pages.flatMap((page) => [...page.buttons, ...page.folders.flatMap((folder) => folder.buttons)]);
}

// Applies `rewrite` to every button in every profile, on pages and inside folders; returning null drops the button.
function rewriteButtons(profiles: DeckProfile[], rewrite: (button: DeckButton, profile: DeckProfile) => DeckButton | null): DeckProfile[] {
  return profiles.map((profile) => ({
    ...profile,
    pages: profile.pages.map((page) => ({
      ...page,
      buttons: page.buttons.flatMap((button) => rewrite(button, profile) ?? []),
      folders: page.folders.map((folder) => ({ ...folder, buttons: folder.buttons.flatMap((button) => rewrite(button, profile) ?? []) })),
    })),
  }));
}

// Where a dragged rail row would land: `index` counts rows before the dragged one leaves its place.
type RailDrop = { kind: 'page'; profileId: string; index: number; edge: 'before' | 'after' | 'into'; rowKey: string } | { kind: 'profile'; index: number; edge: 'before' | 'after'; rowKey: string } | null;

type WidgetCanvasItem = { type: 'button'; button: DeckButton } | { type: 'widget'; widget: DeckWidget };

// Mirrors the phone: a page with no buttons stretches the bounding box of its widget items
// across the whole widget area, so cells get bigger. `override` is a placement being resized.

function occupiedWidgetCells(screen: WidgetScreen): Map<number, WidgetCanvasItem> {
  const occupied = new Map<number, WidgetCanvasItem>();
  for (const button of screen.buttons) {
    const placement = buttonPlacement(screen, button);
    for (let row = placement.row; row < placement.row + placement.rowSpan; row++) {
      for (let column = placement.column; column < placement.column + placement.columnSpan; column++) occupied.set(row * screen.columns + column, { type: 'button', button });
    }
  }
  for (const widget of screen.widgets) {
    const placement = widget.placement;
    for (let row = placement.row; row < placement.row + placement.rowSpan; row++) {
      for (let column = placement.column; column < placement.column + placement.columnSpan; column++) occupied.set(row * screen.columns + column, { type: 'widget', widget });
    }
  }
  return occupied;
}

// What the USB tab says. The phone pairs itself over the cable, so there is nothing to scan.
function usbMessage(usb: { status: string; phone: string; detail: string } | undefined, enabled: boolean): string {
  const phone = usb?.phone ? usb.phone : 'the phone';
  if (!enabled || !usb || usb.status === 'off') return 'Press Set up USB first';
  switch (usb.status) {
    case 'no_adb': return 'Download the Android USB tool first';
    case 'no_phone': return 'Plug your Android phone into this PC';
    case 'unauthorized': return 'Unlock the phone and tap Allow USB debugging';
    case 'pairing': return `Pairing with ${phone}…`;
    case 'connected': return `${usb.phone || 'Your phone'} is connected by USB`;
    case 'idle': return `${usb.phone || 'The phone'} is plugged in but not connected. Open Open Dock on it, or press Retry`;
    case 'failed': return `Could not pair with ${phone}${usb.detail ? `. ${usb.detail}` : ''}`;
    default: return usb.detail || 'Checking the USB connection…';
  }
}

function App() {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [transport, setTransport] = useState<'wifi' | 'usb'>('wifi');
  const [usbEnabled, setUsbEnabled] = useState(false);
  const [usbBusy, setUsbBusy] = useState(false);
  const [usbError, setUsbError] = useState('');
  // Set when this PC has no adb: the card then offers Google's download (size in MB) instead of failing.
  const [adbDownloadMb, setAdbDownloadMb] = useState<number | null>(null);
  const [adbProgress, setAdbProgress] = useState('');
  const [pairingError, setPairingError] = useState('');
  const [screen, setScreen] = useState<'overview' | 'deck' | 'settings'>('overview');
  // Switching pages glides the sidebar's selected pill to its new item (a view transition), where the browser can.
  const go = (next: typeof screen) => {
    if (next === screen) return;
    const start = (document as Document & { startViewTransition?: (update: () => void) => unknown }).startViewTransition;
    if (!start || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setScreen(next); return; }
    start.call(document, () => flushSync(() => setScreen(next)));
  };
  const updater = useUpdater();
  const { checkNow } = updater;
  useEffect(() => {
    // The tray's "Check for Updates…" item.
    const stop = listen('check-for-updates', () => { setScreen('settings'); void checkNow(); });
    return () => { void stop.then((unlisten) => unlisten()); };
  }, [checkNow]);
  const [deckConfig, setDeckConfig] = useState<DeckConfig | null>(null);
  const [independentNavigation, setIndependentNavigation] = useState(false);
  const [navigationSettingBusy, setNavigationSettingBusy] = useState(false);
  const [navigationSettingError, setNavigationSettingError] = useState('');
  const [playbackState, setPlaybackState] = useState<PlaybackState>('unavailable');
  const [mediaState, setMediaState] = useState<SystemMediaState>({ playbackState: 'unavailable' });
  const [legacyImports, setLegacyImports] = useState<LegacyImportSummary[]>([]);
  const [importError, setImportError] = useState('');
  const [openDockPlugins, setOpenDockPlugins] = useState<OpenDockPlugin[]>([]);
  const [openDockPluginWarnings, setOpenDockPluginWarnings] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const info = await invoke<ConnectionInfo>("connection_info");
        if (live) {
          setConnection(info);
          setUsbEnabled(info.androidUsbEnabled);
          setLoadError(false);
        }
      } catch {
        if (live) setLoadError(true);
      }
      try {
        const offers = await invoke<LegacyImportSummary[]>('pending_legacy_imports');
        if (live) setLegacyImports(offers);
      } catch { /* Companion startup may still be initializing. */ }
    };
    void refresh();
    void invoke<DeckConfig>('deck_config').then((config) => { if (live) setDeckConfig(config); }).catch(() => {});
    void invoke<boolean>('get_independent_navigation').then((enabled) => { if (live) setIndependentNavigation(enabled); }).catch(() => {});
    void invoke<OpenDockPluginListing>('list_open_dock_plugins').then(({ plugins, warnings }) => { if (live) { setOpenDockPlugins(plugins); setOpenDockPluginWarnings(warnings); } }).catch(() => {});
    const timer = window.setInterval(refresh, 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let live = true;
    let eventRevision = 0;
    let unlistenState: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    void Promise.all([
      listen<SystemMediaState>('system-media-state', ({ payload }) => {
        eventRevision += 1;
        if (live) setMediaState(payload);
      }),
      listen<SystemMediaProgress>('system-media-progress', ({ payload }) => {
        eventRevision += 1;
        if (!live) return;
        setMediaState((current) => ({ ...current, ...payload }));
      }),
    ]).then(([stopState, stopProgress]) => {
      if (!live) {
        stopState();
        stopProgress();
        return;
      }
      unlistenState = stopState;
      unlistenProgress = stopProgress;
      const revision = eventRevision;
      void invoke<SystemMediaState>('get_system_media_state').then((snapshot) => {
        if (live && revision === eventRevision) setMediaState(snapshot);
      }).catch(() => {});
    }).catch(() => {});
    return () => {
      live = false;
      unlistenState?.();
      unlistenProgress?.();
    };
  }, []);

  useEffect(() => {
    if (!connection?.isMacos) return;
    const rootBackground = document.documentElement.style.backgroundColor;
    const bodyBackground = document.body.style.backgroundColor;
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    return () => {
      document.documentElement.style.backgroundColor = rootBackground;
      document.body.style.backgroundColor = bodyBackground;
    };
  }, [connection?.isMacos]);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try { const state = await invoke<PlaybackState>('get_playback_state'); if (live) setPlaybackState(state); } catch { if (live) setPlaybackState('unavailable'); }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  async function copyPairingDetails() {
    if (!connection) return;
    await navigator.clipboard.writeText(
      `${transport === 'usb' ? '127.0.0.1' : connection.host}:${connection.port}\n${connection.token}`,
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function enableAndroidUsb() {
    setUsbBusy(true);
    setUsbError('');
    try {
      await invoke('enable_android_usb');
      setUsbEnabled(true);
      setTransport('usb');
      setAdbDownloadMb(null);
    } catch (error) {
      if (String(error) === 'ADB_MISSING') {
        const status = await invoke<{ downloadMb: number }>('adb_status').catch(() => null);
        setAdbDownloadMb(status?.downloadMb ?? 10);
      } else setUsbError(String(error));
    } finally {
      setUsbBusy(false);
    }
  }

  async function installAdb() {
    setUsbBusy(true);
    setUsbError('');
    setAdbProgress('Starting…');
    const stop = await listen<{ stage: string; received: number; total: number }>('adb-progress', ({ payload }) => {
      setAdbProgress(payload.stage === 'download' ? `Downloading… ${Math.min(100, Math.floor((payload.received / payload.total) * 100))}%` : payload.stage === 'verify' ? 'Checking the download…' : 'Unpacking…');
    });
    try {
      await invoke('install_adb');
      setAdbDownloadMb(null);
      stop();
      setAdbProgress('');
      await enableAndroidUsb();
      return;
    } catch (error) {
      setUsbError(String(error));
    }
    stop();
    setAdbProgress('');
    setUsbBusy(false);
  }

  async function rotatePairingKey() {
    if (!window.confirm('Reset the pairing key? All connected phones will be disconnected and must scan the new QR code.')) return;
    setPairingError('');
    try {
      await invoke('rotate_pairing_key');
      const info = await invoke<ConnectionInfo>('connection_info');
      setConnection(info);
    } catch {
      setPairingError('Could not reset the pairing key.');
    }
  }

  async function saveIndependentNavigation(enabled: boolean) {
    setNavigationSettingBusy(true);
    setNavigationSettingError('');
    try {
      const saved = await invoke<boolean>('set_independent_navigation', { enabled });
      setIndependentNavigation(saved);
    } catch {
      setNavigationSettingError('Could not save this setting. Try again.');
    } finally {
      setNavigationSettingBusy(false);
    }
  }

  async function importPhoneDeck(sourceId: string) {
    setImportError('');
    try {
      const config = await invoke<DeckConfig>('import_legacy_deck', { sourceId });
      setDeckConfig(config);
      setLegacyImports((imports) => imports.filter((item) => item.sourceId !== sourceId));
      setScreen('deck');
    } catch (error) {
      setImportError(String(error));
    }
  }

  async function requestPhoneDeck(sourceId: string) {
    setImportError('');
    try {
      await invoke('request_legacy_deck_import', { sourceId });
    } catch (error) {
      setImportError(String(error));
    }
  }

  const online = connection?.serverOnline ?? false;
  const pairingQr = connection
    ? JSON.stringify({
        type: "open-dock-pair",
        version: 1,
        transport,
        host: connection.host,
        deviceName: connection.deviceName,
        port: connection.port,
        token: connection.token,
      })
    : "";

  return (
    <main className={`app-shell ${connection?.isMacos ? 'macos-native-sidebar' : connection ? 'glass-window' : ''}`}>
      <aside className="sidebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <img className="brand-icon" src={appIcon} width={22} height={22} alt="" />
          <span>Open Dock</span>
        </div>
        {/* The icon's dock dots, lit while a phone is connected. */}
        <div className={`dock-dots ${(connection?.activeDevices ?? 0) > 0 ? 'live' : ''}`} role="status" aria-label={(connection?.activeDevices ?? 0) > 0 ? 'Phone connected' : 'No phone connected'}><i /><i /><i /><i /><i /></div>

        <div className="nav-heading">Workspace</div>
        <nav aria-label="Workspace">
          <button className={`nav-item ${screen === 'overview' ? 'selected' : ''}`} title="Overview" aria-label="Overview" aria-current={screen === 'overview' ? 'page' : undefined} onClick={() => go('overview')}>
            <LayoutDashboard size={16} strokeWidth={1.8} /><span>Overview</span>
          </button>
          <button className={`nav-item ${screen === 'deck' ? 'selected' : ''}`} title="Deck" aria-label="Deck" aria-current={screen === 'deck' ? 'page' : undefined} onClick={() => go('deck')}>
            <Layers size={16} strokeWidth={1.8} /><span>Deck</span>
          </button>
          <button className={`nav-item ${screen === 'settings' ? 'selected' : ''}`} title="Settings" aria-label="Settings" aria-current={screen === 'settings' ? 'page' : undefined} onClick={() => go('settings')}>
            <Settings size={16} strokeWidth={1.8} /><span>Settings</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          {updater.state.kind === 'ready' ? <button type="button" className="update-pill" title="Restart to update" aria-label="Restart to update" onClick={() => void updater.restart()}><span className="status-dot" /><span className="pill-text">Restart to update</span></button> : <span className="version">{version}</span>}
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar" data-tauri-drag-region>
          <span>{screen === 'overview' ? 'Overview' : screen === 'deck' ? 'Deck' : 'Settings'}</span>
          <div className="network-badge">
            <Wifi size={14} strokeWidth={1.8} />
            {transport === 'usb' ? 'Android USB' : 'Local network'}
          </div>
        </header>

        <div key={screen} className={screen === 'deck' ? 'content deck-content' : 'content'}>
          {legacyImports.length > 0 ? <section className="legacy-imports" aria-label="Phone deck import">
            <div className="legacy-import-copy"><strong>{legacyImports.some((item) => item.ready) ? 'Phone deck ready to import' : 'Saved phone deck detected'}</strong><span>{legacyImports.map((item) => item.ready ? `${item.pages} pages · ${item.buttons} buttons ready as a new profile` : item.requested ? 'Transfer requested. Keep the phone connected.' : 'The saved buttons stay on the phone until you request a transfer.').join('  |  ')}</span></div>
            <div className="legacy-import-actions">{legacyImports.map((item) => <button key={item.sourceId} className="secondary-button" onClick={() => void (item.ready ? importPhoneDeck(item.sourceId) : requestPhoneDeck(item.sourceId))}>{item.ready ? 'Import phone deck' : item.requested ? 'Request again' : 'Transfer phone deck'}</button>)}</div>
            {importError ? <p className="usb-error" role="alert">{importError}</p> : null}
          </section> : null}
          {screen === 'deck' ? <DesktopDeckEditor config={deckConfig} onSaved={setDeckConfig} playbackState={playbackState} mediaState={mediaState} isMacos={connection?.isMacos ?? false} plugins={openDockPlugins} widgetSurface={connection?.widgetSurface ?? null} /> : screen === 'settings' ? <>
          <div className="page-heading"><div><h1>Settings</h1><p>Manage updates, device navigation and Open Dock plugins.</p></div></div>
          <AppearanceSetting />
          <UpdatesSetting updater={updater} />
          <StartWithWindowsSetting />
          <section className="device-navigation-setting">
            <div className="device-navigation-copy"><h2>Independent device navigation</h2><p>Let each connected phone use its own profile and page. Turn this off to mirror navigation across all phones.</p></div>
            <button className={`setting-switch ${independentNavigation ? 'enabled' : ''}`} type="button" role="switch" aria-checked={independentNavigation} aria-label="Independent device navigation" disabled={navigationSettingBusy} onClick={() => void saveIndependentNavigation(!independentNavigation)}><span /></button>
            {navigationSettingError ? <p className="setting-error" role="alert">{navigationSettingError}</p> : null}
          </section>
          <OpenDockPluginSettings plugins={openDockPlugins} warnings={openDockPluginWarnings} onChange={(plugins, warnings) => { setOpenDockPlugins(plugins); setOpenDockPluginWarnings(warnings); }} />
          </> : <>
          <div className="page-heading">
            <div>
              <h1>Overview</h1>
              <p>Connect your phone and control this computer.</p>
            </div>
            <div className={`ready-badge ${online ? "ready" : ""}`}>
              <span className="status-dot" />
              {online ? "Ready to pair" : loadError ? "Unavailable" : "Starting"}
            </div>
          </div>

          <section className="pair-card" aria-labelledby="pair-title">
            <div className="pair-copy">
              <div className="section-title-row">
                <div className="section-icon"><Smartphone size={17} /></div>
                <div>
                  <h2 id="pair-title">Pair a phone</h2>
                  <p>Scan this code from the Open Dock app on your phone.</p>
                </div>
              </div>

              <div className="connection-details">
                <div>
                  <span>PC address</span>
                  <code>
                    {connection
                      ? `${connection.host}:${connection.port}`
                      : loadError
                        ? "Unavailable"
                        : "Finding network…"}
                  </code>
                </div>
                <div>
                  <span>Pairing</span>
                  <span className="pairing-ready">
                    <ShieldCheck size={14} />
                    Key included in QR code
                  </span>
                </div>
                <div>
                  <span>Pairing PIN</span>
                  <code className="pairing-pin" aria-label="Pairing PIN for Find my PC">{connection?.pin ? `${connection.pin.slice(0, 3)} ${connection.pin.slice(3)}` : '——'}</code>
                </div>
              </div>

              <button
                className="secondary-button"
                onClick={copyPairingDetails}
                disabled={!connection}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? "Copied" : "Copy manual setup details"}
              </button>
              <div className="usb-setup">
                <div>
                  <strong>Android USB</strong>
                  <span>{adbDownloadMb !== null
                    ? `Open Dock needs Google's Android USB tool (adb, about ${adbDownloadMb} MB). It is downloaded from dl.google.com and kept inside Open Dock.`
                    : "Needs USB debugging turned on in the phone's Developer options."}</span>
                </div>
                <button className="secondary-button" onClick={() => void (adbDownloadMb !== null ? installAdb() : enableAndroidUsb())} disabled={!connection || usbBusy}>
                  {adbProgress || (usbBusy ? 'Setting up…' : adbDownloadMb !== null ? `Download (${adbDownloadMb} MB)` : usbEnabled ? 'Reconnect USB' : 'Set up USB')}
                </button>
              </div>
              {usbError ? <p className="usb-error" role="alert">{usbError}</p> : null}
              {transport === 'usb' && usbEnabled ? <p className="pair-note">Plug the Android phone in and Open Dock pairs it by itself. Keep USB debugging enabled while using Open Dock.</p> : null}
              {transport === 'usb' ? <p className="pair-note">On the phone: Settings → About phone → tap Build number 7 times → Developer options → turn on USB debugging, then tap Allow when asked.</p> : null}
              <p className="pair-note">iPhone USB data control needs a compatible MFi accessory. Use Wi-Fi on iOS.</p>
              <button className="secondary-button reset-pairing-button" onClick={() => void rotatePairingKey()}>Reset pairing key</button>
              {pairingError ? <p className="usb-error" role="alert">{pairingError}</p> : null}
              <p className="pair-note">
                Keep the QR code and PIN private. Anyone who has them can control this PC. Phones that use Find my PC enter the PIN; it changes after each use.
              </p>
              {connection?.isMacos && (
                <p className="pair-note mac-note">
                  Allow Open Dock under System Settings → Privacy &amp; Security → Accessibility to send shortcuts and volume keys. Now playing, play/pause and track skipping work without it.
                </p>
              )}
            </div>

            <div className="qr-column">
              <div className="transport-tabs" role="group" aria-label="Connection type">
                <button className={transport === 'wifi' ? 'transport-tab selected' : 'transport-tab'} onClick={() => setTransport('wifi')}>Wi-Fi</button>
                <button className={transport === 'usb' ? 'transport-tab selected' : 'transport-tab'} onClick={() => setTransport('usb')}>Android USB</button>
              </div>
              <div className="qr-frame">
                {transport === 'usb' ? (
                  <div className="qr-placeholder usb-status" role="status">
                    <Smartphone size={24} />
                    <span>{usbMessage(connection?.androidUsb, usbEnabled)}</span>
                    {usbEnabled && ['idle', 'failed'].includes(connection?.androidUsb?.status ?? '') ? <button className="secondary-button" onClick={() => void invoke('retry_android_usb')}>Retry</button> : null}
                  </div>
                ) : connection && online ? (
                  <QRCodeSVG
                    value={pairingQr}
                    size={184}
                    level="M"
                    marginSize={2}
                    aria-label="Open Dock phone pairing QR code"
                  />
                ) : (
                  <div className="qr-placeholder">
                    <QrCode size={24} />
                  <span>{loadError ? "QR unavailable" : "Starting…"}</span>
                  </div>
                )}
              </div>
              <span className="qr-caption">{transport === 'usb' ? 'Pairs by cable, no code to scan' : 'Wi-Fi pairing'}</span>
            </div>
          </section>

          <div className="section-heading">
            <h2>PC status</h2>
          </div>
          <div className="status-grid">
            <article className="status-card">
              <div className="card-heading">
                <span>Connection</span>
                <Wifi size={16} />
              </div>
              <strong>{online ? "Ready" : loadError ? "Unavailable" : "Starting"}</strong>
              <span className="card-foot">
                {connection?.activeDevices ?? 0} phones connected
              </span>
            </article>
            <article className="status-card">
              <div className="card-heading">
                <span>Controls</span>
                <Keyboard size={16} />
              </div>
              <strong>Shortcuts and media</strong>
              <span className="card-foot">Available from your phone</span>
            </article>
            <article className="status-card">
              <div className="card-heading">
                <span>Network</span>
                <Monitor size={16} />
              </div>
              <strong>Local only</strong>
              <span className="card-foot">No account or cloud relay</span>
            </article>
          </div>
          </>}
        </div>
      </section>
    </main>
  );
}

function OpenDockPluginSettings({ plugins, warnings, onChange }: { plugins: OpenDockPlugin[]; warnings: string[]; onChange: (plugins: OpenDockPlugin[], warnings: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    const listing = await invoke<OpenDockPluginListing>('list_open_dock_plugins');
    onChange(listing.plugins, listing.warnings);
  }
  async function install() {
    setBusy(true);
    setError('');
    try {
      const sourcePath = await openFileDialog({ title: 'Choose a Open Dock plugin folder', multiple: false, directory: true });
      if (typeof sourcePath !== 'string') return;
      await invoke<OpenDockPlugin>('install_open_dock_plugin', { sourcePath });
      await refresh();
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  async function uninstall(plugin: OpenDockPlugin) {
    if (!window.confirm(`Remove Open Dock plugin “${plugin.name}”? Deck items using its actions or widgets must be removed or reconfigured first.`)) return;
    setBusy(true);
    setError('');
    try {
      await invoke('uninstall_open_dock_plugin', { pluginId: plugin.id });
      await refresh();
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  return <section className="open-dock-plugin-settings">
    <div className="open-dock-plugin-heading"><div><h2><Package size={16} /> Open Dock plugins</h2><p>Install Open Dock-native actions and widgets for your deck.</p></div><button type="button" className="secondary-button" disabled={busy} onClick={() => void install()}><Plus size={14} /> Install plugin</button></div>
    <p className="open-dock-plugin-warning">Only install code from people you trust. Plugin scripts run as your PC user and may access your files and applications. Each deck button requires separate permission before it can run. Elgato Stream Deck packages are not supported.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {warnings.length ? <div className="open-dock-plugin-errors" role="status">{warnings.map((warning, index) => <p key={`${index}-${warning}`}>{warning}</p>)}</div> : null}
    {plugins.length ? <div className="open-dock-plugin-list">{plugins.map((plugin) => <article className="open-dock-plugin-item" key={plugin.id}><div><strong>{plugin.name} <span>v{plugin.version}</span></strong><small>{plugin.description || `${plugin.actions.length} actions`}</small><small>{plugin.actions.map((action) => action.name).join(' · ')}</small></div><button type="button" className="icon-button" aria-label={`Remove ${plugin.name}`} title="Remove plugin" disabled={busy} onClick={() => void uninstall(plugin)}><Trash2 size={14} /></button></article>)}</div> : <p className="open-dock-plugin-empty">No Open Dock plugins installed.</p>}
    <details className="open-dock-plugin-format"><summary>Plugin folder format</summary><code>{`manifest.json\nscripts/your-action.ps1  (Windows)\nscripts/your-action.sh    (macOS)`}</code><span>Manifest schema and a complete example: pc-companion/docs/open-dock-plugin-format.md</span></details>
  </section>;
}

function DesktopDeckEditor({ config: savedConfig, onSaved, playbackState, mediaState, isMacos, plugins, widgetSurface }: { config: DeckConfig | null; onSaved: (config: DeckConfig) => void; playbackState: PlaybackState; mediaState: SystemMediaState; isMacos: boolean; plugins: OpenDockPlugin[]; widgetSurface: WidgetSurface | null }) {
  const theme = useTheme();
  const [workingConfig, setWorkingConfig] = useState<DeckConfig | null>(savedConfig);
  const [profileId, setProfileId] = useState('');
  const [pageId, setPageId] = useState('');
  const [buttonId, setButtonId] = useState('');
  const [widgetId, setWidgetId] = useState('');
  const [folderId, setFolderId] = useState('');
  const [pendingCell, setPendingCell] = useState<{ row: number; column: number } | null>(null);
  const [appPicker, setAppPicker] = useState<'add' | 'autoswitch' | null>(null);
  // The right-hand panel: the library to add from, or the settings of the selected item.
  const [panel, setPanel] = useState<'add' | 'settings'>('add');
  // In a narrow window the rail becomes a popover and the side panel slides in; these say whether they are open.
  const [railOpen, setRailOpen] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  // Dragging pages and profiles in the rail.
  const [railDrag, setRailDrag] = useState<{ kind: 'page' | 'profile'; id: string; label: string; x: number; y: number; copy: boolean; ok: boolean; reason: string; drop: RailDrop } | null>(null);
  const [dragExpand, setDragExpand] = useState('');
  const [moveDialog, setMoveDialog] = useState<{ request: MoveRequest; decisions: MoveDecisions; incoming: string; outgoing: string; pageName: string; toName: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const railDragRef = useRef<{ kind: 'page' | 'profile'; id: string; profileId: string; label: string; pointerId: number; x: number; y: number; active: boolean; copy: boolean } | null>(null);
  const expandTimer = useRef<{ profileId: string; timer: number } | null>(null);
  const suppressRailClick = useRef(false);
  const [dragGhost, setDragGhost] = useState<{ label: string; x: number; y: number; ok: boolean } | null>(null);
  const addAt = useRef<{ at?: { row: number; column: number }; folderId: string | null }>({ folderId: null });
  const libraryDrag = useRef<{ choice: LibraryChoice; label: string; pointerId: number; x: number; y: number; active: boolean } | null>(null);
  const iconRequests = useRef(new Map<string, number>());
  const finishAddRef = useRef<((spec: { label: string; action: DeckAction }, at: { row: number; column: number } | undefined, folderId: string | null, icon?: { kind: 'app' | 'file'; target: string; prefetched?: string | null }) => void) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draggingButtonId, setDraggingButtonId] = useState('');
  const [dragOverButtonId, setDragOverButtonId] = useState('');
  const [dragOverCellKey, setDragOverCellKey] = useState('');
  const [resizePreview, setResizePreview] = useState<{ id: string; placement: DeckPlacement; valid: boolean } | null>(null);
  const [autoSwitchAppDraft, setAutoSwitchAppDraft] = useState('');
  const [menu, setMenu] = useState<{ kind: 'profile' | 'page'; profileId: string; pageId?: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<{ type: 'deletePage' | 'deleteProfile' | 'settings'; profileId: string; pageId?: string } | null>(null);
  const [depChoice, setDepChoice] = useState<'remove' | 'move'>('remove');
  const [depTarget, setDepTarget] = useState('');
  const [undo, setUndo] = useState<{ message: string; config: DeckConfig } | null>(null);
  const [renaming, setRenaming] = useState<{ kind: 'profile' | 'page'; id: string; profileId: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const failedRef = useRef<DeckConfig | null>(null);
  const workingRef = useRef<DeckConfig | null>(null);
  const saveRef = useRef<((next: DeckConfig) => Promise<void>) | null>(null);
  const buttonDrag = useRef<{ id: string; surface: 'page' | 'widgets'; kind: 'button' | 'widget'; pointerId: number; x: number; y: number; active: boolean } | null>(null);
  const resizeDrag = useRef<{ id: string; surface: 'page' | 'widgets'; kind: 'button' | 'widget'; pointerId: number; x: number; y: number; placement: DeckPlacement } | null>(null);
  const widgetCanvasRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setWorkingConfig(savedConfig); }, [savedConfig]);
  workingRef.current = workingConfig;
  // Edits save themselves shortly after the last change; a failed config isn't retried until it changes again.
  useEffect(() => {
    if (!workingConfig || workingConfig === savedConfig || workingConfig === failedRef.current || busy) return;
    const timer = window.setTimeout(() => void saveRef.current?.(workingConfig), 600);
    return () => window.clearTimeout(timer);
  }, [workingConfig, savedConfig, busy]);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(timer);
  }, [undo]);
  const config = workingConfig ?? savedConfig;

  useEffect(() => {
    if (!config) return;
    const profile = config.profiles.find((item) => item.id === (profileId || config.activeProfileId)) ?? config.profiles[0];
    const page = profile.pages.find((item) => item.id === (pageId || profile.activePageId)) ?? profile.pages[0];
    setProfileId(profile.id);
    setPageId(page.id);
    const folder = page.folders.find((item) => item.id === folderId);
    if (folderId && !folder) setFolderId('');
    // Selections that no longer exist (deleted, or on a page that was left) are dropped, never replaced.
    if (buttonId && !(folder ?? page).buttons.some((button) => button.id === buttonId)) setButtonId('');
    if (widgetId && !(folder ?? page).widgets.some((widget) => widget.id === widgetId)) setWidgetId('');
  }, [config, profileId, pageId, folderId, buttonId, widgetId]);
  useEffect(() => { setFolderId(''); setPendingCell(null); }, [profileId, pageId]);
  useEffect(() => { if (!buttonId && !widgetId) setPanel('add'); }, [buttonId, widgetId]);
  useEffect(() => { if (buttonId || widgetId) setSidePanelOpen(true); }, [buttonId, widgetId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const drag = railDragRef.current;
      if (!drag) return;
      if (event.key === 'Escape') {
        railDragRef.current = null;
        document.body.classList.remove('deck-dragging');
        if (expandTimer.current) window.clearTimeout(expandTimer.current.timer);
        expandTimer.current = null;
        setRailDrag(null);
        setDragExpand('');
      } else if (event.key === 'Alt') {
        drag.copy = event.type === 'keydown';
        setRailDrag((current) => current ? { ...current, copy: drag.copy } : current);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !libraryDrag.current) return;
      libraryDrag.current = null;
      document.body.classList.remove('deck-dragging');
      setDragGhost(null);
      setDragOverCellKey('');
      setDragOverButtonId('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { setPendingCell(null); }, [folderId]);

  const activeProfile = config?.profiles.find((item) => item.id === profileId) ?? config?.profiles[0];
  const activePage = activeProfile?.pages.find((item) => item.id === pageId) ?? activeProfile?.pages[0];
  useEffect(() => setAutoSwitchAppDraft(''), [activeProfile?.id]);

  if (!config || !activeProfile || !activePage) return <div className="deck-loading">Loading your PC deck…</div>;
  const deck = config;
  const profile = activeProfile;
  const page = activePage;
  const folder = page.folders.find((item) => item.id === folderId) ?? null;
  // The grid being edited is the page, or the folder opened from it. "Widget screen" is its older name.
  const widgetScreen: WidgetScreen = folder
    ? { enabled: true, rows: folder.rows, columns: folder.columns, buttons: folder.buttons, widgets: folder.widgets }
    : { enabled: true, rows: page.rows, columns: page.columns, buttons: page.buttons, widgets: page.widgets };
  const selected = widgetScreen.buttons.find((button) => button.id === buttonId) ?? null;
  const selectedWidget = widgetScreen.widgets.find((widget) => widget.id === widgetId) ?? null;
  const selectedWidgetDefinition = selectedWidget?.type === 'plugin'
    ? plugins.find((plugin) => plugin.id === selectedWidget.pluginId)?.widgets?.find((widget) => widget.id === selectedWidget.widgetId) ?? null
    : null;
  const pluginWidgetOptions = plugins.flatMap((plugin) => (plugin.widgets ?? []).map((widget) => ({
    value: `${plugin.id}::${widget.id}`,
    label: `${plugin.name} · ${widget.name}`,
    plugin,
    widget,
  })));
  const widgetOccupied = occupiedWidgetCells(widgetScreen);

  async function save(next: DeckConfig) {
    const fillPluginValues = (widgets: DeckWidget[]): DeckWidget[] => widgets.map((widget) => {
      if (widget.type !== 'plugin') return widget;
      const definition = plugins.find((plugin) => plugin.id === widget.pluginId)?.widgets?.find((candidate) => candidate.id === widget.widgetId);
      if (!definition) return widget;
      const values = Object.fromEntries(definition.inputs.map((input) => [input.id, widget.values[input.id] ?? (input.default || (input.type === 'select' ? input.options[0] ?? '' : ''))]));
      return { ...widget, values };
    });
    const normalized: DeckConfig = {
      ...next,
      profiles: next.profiles.map((item) => ({
        ...item,
        pages: item.pages.map((deckPage) => ({
          ...deckPage,
          widgets: fillPluginValues(deckPage.widgets),
          folders: deckPage.folders.map((entry) => ({ ...entry, widgets: fillPluginValues(entry.widgets) })),
        })),
      })),
    };
    for (const widget of normalized.profiles.flatMap((item) => item.pages.flatMap((deckPage) => [...deckPage.widgets, ...deckPage.folders.flatMap((entry) => entry.widgets)]))) {
      if (widget.type !== 'plugin') continue;
      const definition = plugins.find((plugin) => plugin.id === widget.pluginId)?.widgets?.find((item) => item.id === widget.widgetId);
      if (!definition) continue;
      const inputs = new Map(definition.inputs.map((input) => [input.id, input]));
      if (Object.keys(widget.values).some((id) => !inputs.has(id))) {
        setError(`“${definition.name}” contains an unknown input. Reconfigure it before saving.`);
        return;
      }
      if (definition.inputs.some((input) => input.type === 'select' && !input.options.includes(widget.values[input.id] ?? ''))) {
        setError(`Choose a valid option for every select field in “${definition.name}”.`);
        return;
      }
    }
    setBusy(true);
    setError('');
    try {
      const saved = await invoke<DeckConfig>('save_deck_config', { config: normalized });
      failedRef.current = null;
      onSaved(saved);
    } catch (cause) {
      failedRef.current = workingRef.current;
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  saveRef.current = save;

  function replacePage(nextPage: DeckPage, nextProfile = profile, persist = true) {
    const next = { ...deck, activeProfileId: nextProfile.id, profiles: deck.profiles.map((item) => item.id === nextProfile.id ? { ...nextProfile, activePageId: nextPage.id, pages: nextProfile.pages.map((candidate) => candidate.id === nextPage.id ? nextPage : candidate) } : item) };
    setProfileId(nextProfile.id);
    setPageId(nextPage.id);
    setWorkingConfig(next);
    if (persist) void save(next);
  }







  function resizeWidgetItem(itemId: string, placement: DeckPlacement, kind: 'button' | 'widget') {
    if (busy || !canPlaceWidgetItem(widgetScreen, itemId, placement)) return false;
    if (kind === 'button') replaceWidgetScreen({ ...widgetScreen, buttons: widgetScreen.buttons.map((button) => button.id === itemId ? { ...button, placement } : button) });
    else replaceWidgetScreen({ ...widgetScreen, widgets: widgetScreen.widgets.map((widget) => widget.id === itemId ? { ...widget, placement } : widget) });
    return true;
  }

  function startButtonDrag(event: React.PointerEvent<HTMLButtonElement>, id: string, surface: 'page' | 'widgets' = 'page') {
    if (event.button !== 0 || busy) return;
    buttonDrag.current = { id, surface, kind: 'button', pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startWidgetDrag(event: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 || busy) return;
    buttonDrag.current = { id, surface: 'widgets', kind: 'widget', pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveButtonDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = buttonDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    drag.active = true;
    event.preventDefault();
    setDraggingButtonId(drag.id);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-deck-cell]');
    const targetId = target?.dataset.deckItem ?? target?.dataset.deckButton ?? '';
    if (targetId !== dragOverButtonId) setDragOverButtonId(targetId);
    const cellKey = target ? `${target.dataset.row}:${target.dataset.column}` : '';
    if (cellKey !== dragOverCellKey) setDragOverCellKey(cellKey);
  }


  function cancelButtonDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (buttonDrag.current?.pointerId !== event.pointerId) return;
    buttonDrag.current = null;
    setDraggingButtonId('');
    setDragOverButtonId('');
    setDragOverCellKey('');
  }




  function cancelResize(event: React.PointerEvent<HTMLSpanElement>) {
    if (resizeDrag.current?.pointerId !== event.pointerId) return;
    resizeDrag.current = null;
    setResizePreview(null);
  }


  function replaceWidgetScreen(nextScreen: WidgetScreen, nextProfile = profile, persist = true, basePage = page) {
    const nextPage: DeckPage = folder && basePage.id === page.id
      ? { ...basePage, folders: basePage.folders.map((item) => item.id === folder.id ? { ...item, rows: nextScreen.rows, columns: nextScreen.columns, buttons: nextScreen.buttons, widgets: nextScreen.widgets } : item) }
      : { ...basePage, rows: nextScreen.rows, columns: nextScreen.columns, buttons: nextScreen.buttons, widgets: nextScreen.widgets };
    replacePage(nextPage, nextProfile, persist);
  }

  function updateButton(patch: Partial<DeckButton>) {
    if (!selected) return;
    replaceWidgetScreen({ ...widgetScreen, buttons: widgetScreen.buttons.map((button) => button.id === selected.id ? { ...button, ...patch } : button) }, profile, false);
  }

  // Where a new item goes: the cell chosen on the grid if it still fits, else the first free spot.

  function selectButton(id: string) {
    setButtonId(id);
    setWidgetId('');
    setPendingCell(null);
  }

  function selectWidgetItem(id: string) {
    setWidgetId(id);
    setButtonId('');
    setPendingCell(null);
  }

  function clearSelection() {
    setButtonId('');
    setWidgetId('');
    setPanel('add');
  }






  function screenOf(id: string | null): WidgetScreen {
    const entry = id ? page.folders.find((candidate) => candidate.id === id) : null;
    return entry ? { enabled: true, rows: entry.rows, columns: entry.columns, buttons: entry.buttons, widgets: entry.widgets } : { enabled: true, rows: page.rows, columns: page.columns, buttons: page.buttons, widgets: page.widgets };
  }

  function writeScreen(base: DeckPage, id: string | null, screen: WidgetScreen): DeckPage {
    return id
      ? { ...base, folders: base.folders.map((entry) => entry.id === id ? { ...entry, buttons: screen.buttons, widgets: screen.widgets } : entry) }
      : { ...base, buttons: screen.buttons, widgets: screen.widgets };
  }

  // Adds one item to the page or to one of its folders, and selects it when it lands on the grid being edited.
  function commitItem(targetId: string | null, item: { button?: DeckButton; widget?: DeckWidget }) {
    const screen = screenOf(targetId);
    setError('');
    replacePage(writeScreen(page, targetId, {
      ...screen,
      buttons: item.button ? [...screen.buttons, item.button] : screen.buttons,
      widgets: item.widget ? [...screen.widgets, item.widget] : screen.widgets,
    }));
    if (targetId !== (folder?.id ?? null)) return;
    if (item.button) selectButton(item.button.id);
    else if (item.widget) selectWidgetItem(item.widget.id);
  }

  // Looks the icon up on the PC and puts it on the button, unless the button moved on in the meantime:
  // deleted, retargeted, or given an icon of the user's own.
  async function attachIcon(buttonId: string, kind: 'app' | 'file', target: string, prefetched?: string | null) {
    const token = (iconRequests.current.get(buttonId) ?? 0) + 1;
    iconRequests.current.set(buttonId, token);
    let data = prefetched ?? null;
    if (!data) {
      try {
        data = await invoke<string>(kind === 'app' ? 'extract_app_icon' : 'extract_file_thumbnail', kind === 'app' ? { app: target, useShortcutIcon: true } : { path: target });
      } catch {
        return;
      }
    }
    if (iconRequests.current.get(buttonId) !== token) return;
    const current = workingRef.current;
    if (!current) return;
    let applied = false;
    const profiles = rewriteButtons(current.profiles, (button) => {
      if (!canReceiveIcon(button as IconTarget, buttonId, kind, target)) return button;
      applied = true;
      return { ...button, icon: 'app-icon', iconSvg: undefined, appIconData: data };
    });
    if (applied) setWorkingConfig({ ...current, profiles });
  }

  // Finishes adding a button once its target is known (after a picker). Always called through finishAddRef so it
  // sees the deck as it is now, not as it was when the picker opened.
  function finishAdd(spec: { label: string; action: DeckAction }, at: { row: number; column: number } | undefined, folderId: string | null, icon?: { kind: 'app' | 'file'; target: string; prefetched?: string | null }) {
    const placement = fitPlacement(screenOf(folderId), { rows: 1, columns: 1 }, at ?? null) ?? (at ? null : fitPlacement(screenOf(folderId), { rows: 1, columns: 1 }, null));
    if (!placement) return setError(at ? 'That cell is taken.' : 'There is no free cell here. Move or resize an item, or add a row or column.');
    const button: DeckButton = { id: freshId('button'), label: fitBytes(spec.label, 24) || 'New button', icon: 'auto', placement, action: spec.action };
    commitItem(folderId, { button });
    if (icon) void attachIcon(button.id, icon.kind, icon.target, icon.prefetched);
  }
  finishAddRef.current = finishAdd;

  async function pickTarget(preset: 'launch_file' | 'launch_folder' | 'run_script'): Promise<string | null> {
    try {
      const path = await openFileDialog({
        title: { launch_file: 'Choose a file', launch_folder: 'Choose a folder', run_script: 'Choose a script' }[preset],
        multiple: false,
        directory: preset === 'launch_folder',
        filters: preset === 'run_script' ? [{ name: 'Scripts', extensions: isMacos ? ['sh', 'py'] : ['ps1', 'py'] }] : undefined,
      });
      return typeof path === 'string' ? path : null;
    } catch (cause) {
      setError(`Could not open the picker: ${String(cause)}`);
      return null;
    }
  }

  // `at` is the cell an item was dropped on; `intoFolder` is a folder tile it was dropped on.
  async function addItem(choice: LibraryChoice, at?: { row: number; column: number }, intoFolder?: string) {
    if (busy) return;
    const folderId = intoFolder ?? folder?.id ?? null;
    const cell = at ?? (intoFolder ? undefined : pendingCell ?? undefined);
    setError('');
    if (choice.kind === 'button') {
      const preset = choice.preset;
      const spec = (label: string, action: DeckAction) => finishAddRef.current?.({ label, action }, cell, folderId);
      if (preset === 'hotkey') return spec('Shortcut', { type: 'hotkey', keys: ['CTRL', 'SHIFT', 'M'] });
      if (preset === 'media') return spec('Play / Pause', { type: 'media', command: 'play_pause' });
      if (preset === 'sequence') return spec('Sequence', { type: 'sequence', steps: [{ type: 'media', command: 'play_pause' }] });
      if (preset === 'select_page') {
        const other = profile.pages.find((item) => item.id !== page.id);
        if (!other) return setError('Add a second page first.');
        return spec(`Go to ${other.name}`, { type: 'select_page', pageId: other.id });
      }
      if (preset === 'select_profile') {
        const other = deck.profiles.find((item) => item.id !== profile.id);
        if (!other) return setError('Add a second profile first.');
        return spec(`Go to ${other.name}`, { type: 'select_profile', profileId: other.id });
      }
      if (preset === 'launch_app') {
        addAt.current = { at: cell, folderId };
        return setAppPicker('add');
      }
      const path = await pickTarget(preset);
      if (!path) return;
      const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/\.(ps1|py|sh)$/i, '') ?? '';
      if (preset === 'launch_file') return finishAddRef.current?.({ label: name, action: { type: 'launch_file', path } }, cell, folderId, { kind: 'file', target: path });
      return finishAddRef.current?.({ label: name, action: preset === 'launch_folder' ? { type: 'launch_folder', path } : { type: 'run_script', path, allowOnPc: false } }, cell, folderId);
    }
    const screen = screenOf(folderId);
    const want = choice.kind === 'folder' || choice.kind === 'plugin_action' ? { rows: 1, columns: 1 } : defaultSpan(choice.kind);
    const placement = fitPlacement(screen, want, cell ?? null) ?? (at ? null : fitPlacement(screen, want, null));
    if (!placement) return setError(at ? 'That cell is taken.' : 'There is no free cell here. Move or resize an item, or add a row or column.');
    if (choice.kind === 'folder') {
      if (folderId) return setError('Folders cannot hold folders.');
      return addFolder(placement);
    }
    if (choice.kind === 'plugin_action') {
      const definition = plugins.find((item) => item.id === choice.pluginId)?.actions.find((item) => item.id === choice.actionId);
      if (!definition) return;
      const inputs = Object.fromEntries(definition.inputs.map((input) => [input.id, input.default || (input.type === 'select' ? input.options[0] ?? '' : '')]));
      return commitItem(folderId, { button: { id: freshId('button'), label: fitBytes(definition.name, 24) || 'Plugin', icon: 'auto', placement, action: { type: 'plugin_action', pluginId: choice.pluginId, actionId: choice.actionId, allowOnPc: false, inputs } } });
    }
    const id = freshId('widget');
    let widget: DeckWidget;
    if (choice.kind === 'plugin') {
      const definition = plugins.find((item) => item.id === choice.pluginId)?.widgets?.find((item) => item.id === choice.widgetId);
      if (!definition) return;
      const values = Object.fromEntries(definition.inputs.map((input) => [input.id, input.default || (input.type === 'select' ? input.options[0] ?? '' : '')]));
      widget = { id, type: 'plugin', pluginId: choice.pluginId, widgetId: choice.widgetId, renderType: definition.type, values, placement };
    } else widget = { id, type: choice.kind, placement };
    commitItem(folderId, { widget });
  }

  function addFolder(placement: DeckPlacement) {
    if (folder) return setError('Folders cannot hold folders.');
    if (page.folders.length >= 12) return setError('A page can have up to 12 folders.');
    const used = new Set(page.folders.map((item) => item.name.toLowerCase()));
    let name = 'Folder';
    for (let number = 2; used.has(name.toLowerCase()); number++) name = `Folder ${number}`;
    const id = freshId('folder');
    const button: DeckButton = { id: freshId('button'), label: name, icon: 'auto', placement, action: { type: 'open_folder', folderId: id } };
    setError('');
    replacePage({ ...page, buttons: [...page.buttons, button], folders: [...page.folders, { id, name, rows: 2, columns: 3, buttons: [], widgets: [] }] });
    selectButton(button.id);
  }

  // --- Dragging from the library with the pointer (the browser's own drag and drop is switched off on Windows).
  function dropTarget(x: number, y: number): { row: number; column: number; folderId?: string; taken?: boolean } | null {
    const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-deck-cell]');
    if (!cell || cell.dataset.surface !== 'widgets') return null;
    const row = Number(cell.dataset.row);
    const column = Number(cell.dataset.column);
    if (cell.dataset.deckItem) {
      const tile = widgetScreen.buttons.find((button) => button.id === cell.dataset.deckItem);
      return !folder && tile?.action.type === 'open_folder' ? { row, column, folderId: tile.action.folderId } : { row, column, taken: true };
    }
    return { row, column };
  }

  function startLibraryDrag(event: React.PointerEvent<HTMLButtonElement>, choice: LibraryChoice, label: string) {
    if (event.button !== 0 || busy) return;
    libraryDrag.current = { choice, label, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveLibraryDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = libraryDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    drag.active = true;
    event.preventDefault();
    document.body.classList.add('deck-dragging');
    const target = dropTarget(event.clientX, event.clientY);
    const fits = target && !target.taken
      ? target.folderId ? drag.choice.kind !== 'folder' : fitPlacement(screenOf(folder?.id ?? null), { rows: 1, columns: 1 }, target) !== null
      : false;
    setDragOverCellKey(target && !target.folderId && fits ? `${target.row}:${target.column}` : '');
    setDragOverButtonId(target?.folderId && fits ? (widgetScreen.buttons.find((button) => button.action.type === 'open_folder' && button.action.folderId === target.folderId)?.id ?? '') : '');
    setDragGhost({ label: drag.label, x: event.clientX, y: event.clientY, ok: fits });
    // Keep the canvas moving when the pointer nears its top or bottom edge.
    const scroller = document.querySelector<HTMLElement>('.deck-main-scroll');
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      if (event.clientY < bounds.top + 40) scroller.scrollBy({ top: -14 });
      else if (event.clientY > bounds.bottom - 40) scroller.scrollBy({ top: 14 });
    }
  }

  function endLibraryDrag() {
    libraryDrag.current = null;
    document.body.classList.remove('deck-dragging');
    setDragGhost(null);
    setDragOverCellKey('');
    setDragOverButtonId('');
  }

  function finishLibraryDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = libraryDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const wasDrag = drag.active;
    const target = wasDrag ? dropTarget(event.clientX, event.clientY) : null;
    endLibraryDrag();
    if (!wasDrag) return void addItem(drag.choice);
    if (!target) return setError('Drop an item on a cell of the grid.');
    if (target.taken) return setError('That cell is taken. Drop on an empty cell, or on a folder to put it inside.');
    void addItem(drag.choice, { row: target.row, column: target.column }, target.folderId);
  }

  function cancelLibraryDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (libraryDrag.current?.pointerId === event.pointerId) endLibraryDrag();
  }

  function renameFolder(button: DeckButton, name: string) {
    if (button.action.type !== 'open_folder') return;
    const folderToRename = page.folders.find((item) => item.id === (button.action as { folderId: string }).folderId);
    if (!folderToRename) return;
    const trimmed = name.slice(0, 24);
    if (page.folders.some((item) => item.id !== folderToRename.id && item.name.toLowerCase() === trimmed.trim().toLowerCase())) return setError('Folder names must be unique on a page.');
    setError('');
    replacePage({ ...page, buttons: page.buttons.map((item) => item.id === button.id ? { ...item, label: trimmed } : item), folders: page.folders.map((item) => item.id === folderToRename.id ? { ...item, name: trimmed } : item) }, profile, false);
  }

  function openFolder(id: string) {
    setFolderId(id);
    clearSelection();
  }

  function closeFolder() {
    setFolderId('');
    clearSelection();
  }

  function moveItem(itemId: string, row: number, column: number, kind: 'button' | 'widget', targetId = '') {
    if (busy) return;
    const moving = kind === 'widget' ? widgetScreen.widgets.find((item) => item.id === itemId) : widgetScreen.buttons.find((item) => item.id === itemId);
    if (!moving) return;
    const target = targetId && targetId !== itemId ? widgetScreen.buttons.find((item) => item.id === targetId) : undefined;
    // Dropping something on a folder moves it inside.
    if (!folder && target?.action.type === 'open_folder' && moving.id !== target.id) return moveIntoFolder(itemId, kind, target.action.folderId);
    if (targetId && targetId !== itemId) {
      const placements = swapPlacements(widgetScreen.rows, widgetScreen.columns, [
        ...widgetScreen.buttons.map((button) => ({ id: button.id, placement: buttonPlacement(widgetScreen, button) })),
        ...widgetScreen.widgets.map((widget) => ({ id: widget.id, placement: widget.placement })),
      ], itemId, targetId);
      if (!placements) return setError('Those items cannot swap places without overlapping. Resize one and try again.');
      setError('');
      replaceWidgetScreen({ ...widgetScreen,
        buttons: widgetScreen.buttons.map((button) => ({ ...button, placement: placements.get(button.id)! })),
        widgets: widgetScreen.widgets.map((widget) => ({ ...widget, placement: placements.get(widget.id)! })),
      });
    } else {
      const current = kind === 'widget' ? (moving as DeckWidget).placement : buttonPlacement(widgetScreen, moving as DeckButton);
      const placement = { ...current, row, column };
      if (!canPlaceWidgetItem(widgetScreen, itemId, placement)) return setError('That position is occupied or outside the grid. Move another item first.');
      setError('');
      if (kind === 'widget') replaceWidgetScreen({ ...widgetScreen, widgets: widgetScreen.widgets.map((item) => item.id === itemId ? { ...item, placement } : item) });
      else replaceWidgetScreen({ ...widgetScreen, buttons: widgetScreen.buttons.map((item) => item.id === itemId ? { ...item, placement } : item) });
    }
    if (kind === 'widget') selectWidgetItem(itemId);
    else selectButton(itemId);
  }

  // Moves an item between the page and one of its folders (null is the page itself).
  function transfer(itemId: string, kind: 'button' | 'widget', toFolderId: string | null) {
    if (toFolderId && !page.folders.some((entry) => entry.id === toFolderId)) return;
    const screenOf = (id: string | null): WidgetScreen => {
      const entry = id ? page.folders.find((candidate) => candidate.id === id) : null;
      return entry ? { enabled: true, rows: entry.rows, columns: entry.columns, buttons: entry.buttons, widgets: entry.widgets } : { enabled: true, rows: page.rows, columns: page.columns, buttons: page.buttons, widgets: page.widgets };
    };
    const source = screenOf(folder?.id ?? null);
    const destination = screenOf(toFolderId);
    const item = kind === 'widget' ? source.widgets.find((entry) => entry.id === itemId) : source.buttons.find((entry) => entry.id === itemId);
    if (!item) return;
    if (toFolderId && kind === 'button' && (item as DeckButton).action.type === 'open_folder') return setError('Folders cannot hold folders.');
    const current = kind === 'widget' ? (item as DeckWidget).placement : buttonPlacement(source, item as DeckButton);
    const placement = firstWidgetPlacement(destination, current.rowSpan, current.columnSpan) ?? firstWidgetPlacement(destination);
    if (!placement) return setError(`There is no free space in ${toFolderId ? 'the folder' : 'the page'} for this item.`);
    const moved = { ...item, placement };
    const nextSource: WidgetScreen = { ...source, buttons: source.buttons.filter((entry) => entry.id !== itemId), widgets: source.widgets.filter((entry) => entry.id !== itemId) };
    const nextDestination: WidgetScreen = { ...destination, buttons: kind === 'button' ? [...destination.buttons, moved as DeckButton] : destination.buttons, widgets: kind === 'widget' ? [...destination.widgets, moved as DeckWidget] : destination.widgets };
    const write = (base: DeckPage, id: string | null, screen: WidgetScreen): DeckPage => id
      ? { ...base, folders: base.folders.map((entry) => entry.id === id ? { ...entry, buttons: screen.buttons, widgets: screen.widgets } : entry) }
      : { ...base, buttons: screen.buttons, widgets: screen.widgets };
    setError('');
    replacePage(write(write(page, folder?.id ?? null, nextSource), toFolderId, nextDestination));
    clearSelection();
  }

  function moveIntoFolder(itemId: string, kind: 'button' | 'widget', toFolderId: string) {
    transfer(itemId, kind, toFolderId);
  }

  function moveToPage(itemId: string, kind: 'button' | 'widget') {
    transfer(itemId, kind, null);
  }


  function finishButtonDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = buttonDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    buttonDrag.current = null;
    if (drag.active) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit?.closest<HTMLElement>('[data-deck-cell]');
      if (hit?.closest('[data-deck-back]') && folder) moveToPage(drag.id, drag.kind);
      else if (target?.dataset.surface === 'widgets') {
        moveItem(drag.id, Number(target.dataset.row), Number(target.dataset.column), drag.kind, target.dataset.deckItem ?? '');
      } else if (drag.kind === 'button') selectButton(drag.id);
      else selectWidgetItem(drag.id);
    }
    setDraggingButtonId('');
    setDragOverButtonId('');
    setDragOverCellKey('');
  }

  function startResize(event: React.PointerEvent<HTMLSpanElement>, item: DeckButton | DeckWidget, kind: 'button' | 'widget') {
    if (event.button !== 0 || busy) return;
    event.preventDefault();
    event.stopPropagation();
    const placement = kind === 'widget' ? (item as DeckWidget).placement : buttonPlacement(widgetScreen, item as DeckButton);
    resizeDrag.current = { id: item.id, surface: 'widgets', kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, placement };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (kind === 'button') selectButton(item.id);
    else selectWidgetItem(item.id);
  }

  function moveResize(event: React.PointerEvent<HTMLSpanElement>) {
    const drag = resizeDrag.current;
    const canvas = widgetCanvasRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    const gap = Number.parseFloat(style.columnGap) || 10;
    const rowGap = Number.parseFloat(style.rowGap) || gap;
    const horizontalPadding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const cellWidth = (bounds.width - horizontalPadding - gap * (widgetScreen.columns - 1)) / widgetScreen.columns;
    const cellHeight = 100;
    const columnSpan = Math.max(1, drag.placement.columnSpan + Math.round((event.clientX - drag.x) / (cellWidth + gap)));
    const rowSpan = Math.max(1, drag.placement.rowSpan + Math.round((event.clientY - drag.y) / (cellHeight + rowGap)));
    const placement = { ...drag.placement, rowSpan, columnSpan };
    setResizePreview({ id: drag.id, placement, valid: canPlaceWidgetItem(widgetScreen, drag.id, placement) });
  }

  function finishResize(event: React.PointerEvent<HTMLSpanElement>) {
    const drag = resizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeDrag.current = null;
    const preview = resizePreview;
    if (preview?.id === drag.id && preview.valid) resizeWidgetItem(drag.id, preview.placement, drag.kind);
    else if (preview?.id === drag.id && (preview.placement.rowSpan !== drag.placement.rowSpan || preview.placement.columnSpan !== drag.placement.columnSpan)) setError('That size overlaps another item or extends beyond the grid.');
    setResizePreview(null);
  }

  function duplicateSelected() {
    const source = selected ?? selectedWidget;
    if (!source) return;
    const sourcePlacement = selected ? buttonPlacement(widgetScreen, selected) : selectedWidget!.placement;
    const placement = firstWidgetPlacement(widgetScreen, sourcePlacement.rowSpan, sourcePlacement.columnSpan);
    if (!placement) return setError('There is no free space large enough to duplicate this item.');
    if (selectedWidget) {
      const copy = { ...selectedWidget, id: freshId('widget'), placement } as DeckWidget;
      setError('');
      updateWidgetScreen({ widgets: [...widgetScreen.widgets, copy] });
      return selectWidgetItem(copy.id);
    }
    const button = selected!;
    if (button.action.type === 'open_folder') {
      const original = page.folders.find((item) => item.id === (button.action as { folderId: string }).folderId);
      if (!original || page.folders.length >= 12) return setError('A page can have up to 12 folders.');
      const folderCopy = clonePage({ ...page, buttons: [], widgets: [], folders: [original] }, page.name).folders[0];
      folderCopy.name = copyName(original.name, page.folders.map((item) => item.name), 24);
      const copy: DeckButton = { ...button, id: freshId('button'), placement, label: folderCopy.name, action: { type: 'open_folder', folderId: folderCopy.id } };
      setError('');
      replacePage({ ...page, buttons: [...page.buttons, copy], folders: [...page.folders, folderCopy] });
      return selectButton(copy.id);
    }
    const copy = { ...button, id: freshId('button'), placement, label: copyName(button.label, [], 24) };
    setError('');
    commitItem(folder?.id ?? null, { button: copy });
  }

  function deleteSelected() {
    if (selectedWidget) {
      setUndo({ message: 'Widget deleted', config: deck });
      updateWidgetScreen({ widgets: widgetScreen.widgets.filter((widget) => widget.id !== selectedWidget.id) });
      return setWidgetId('');
    }
    if (!selected) return;
    setUndo({ message: selected.action.type === 'open_folder' ? 'Folder deleted' : 'Button deleted', config: deck });
    setButtonId('');
    if (selected.action.type === 'open_folder') {
      const id = selected.action.folderId;
      replacePage({ ...page, buttons: page.buttons.filter((item) => item.id !== selected.id), folders: page.folders.filter((item) => item.id !== id) });
    } else replaceWidgetScreen({ ...widgetScreen, buttons: widgetScreen.buttons.filter((item) => item.id !== selected.id) });
  }

  function resizeGrid(dimension: 'rows' | 'columns', value: string) {
    const nextValue = Number(value);
    if (!Number.isInteger(nextValue) || nextValue < 1 || nextValue > 6) return;
    const next = { ...widgetScreen, [dimension]: nextValue };
    const doesNotFit = [
      ...widgetScreen.buttons.map((button) => buttonPlacement(widgetScreen, button)),
      ...widgetScreen.widgets.map((widget) => widget.placement),
    ].some((placement) => placement.row + placement.rowSpan > next.rows || placement.column + placement.columnSpan > next.columns);
    if (doesNotFit) return setError(`An item extends beyond the smaller grid. Move or resize it before reducing ${dimension}.`);
    setError('');
    replaceWidgetScreen(next);
  }

  function addProfile() {
    if (deck.profiles.length >= 32) return setError('You can create up to 32 profiles.');
    const id = `profile-${Date.now()}`;
    const nextProfile: DeckProfile = { id, name: `Profile ${deck.profiles.length + 1}`, pages: [{ id: `${id}-main`, name: 'Main', rows: 2, columns: 3, buttons: [], widgets: [], folders: [] }], activePageId: `${id}-main`, defaultPageId: `${id}-main`, autoSwitchApps: [], autoSwitchEnabled: false };
    const next = { ...deck, activeProfileId: id, profiles: [...deck.profiles, nextProfile] };
    // The new profile must be in the editor's config before it is selected, or the selection falls back to the first one.
    setWorkingConfig(next);
    setProfileId(id);
    setPageId(nextProfile.activePageId);
    setButtonId('');
    setWidgetId('');
    void save(next);
  }



  function updateWidgetScreen(patch: Partial<WidgetScreen>) {
    replaceWidgetScreen({ ...widgetScreen, ...patch });
  }






  function updateSelectedClockWidget(patch: { face?: string; color?: string }) {
    if (selectedWidget?.type !== 'clock') return;
    replaceWidgetScreen({ ...widgetScreen, widgets: widgetScreen.widgets.map((widget) => widget.id === selectedWidget.id && widget.type === 'clock'
      ? { ...widget, ...patch }
      : widget) }, profile, false);
  }

  function updateSelectedPcStatsWidget(patch: { face?: string; metric?: string; color?: string; gpu?: string }) {
    if (selectedWidget?.type !== 'pc_stats') return;
    replaceWidgetScreen({ ...widgetScreen, widgets: widgetScreen.widgets.map((widget) => widget.id === selectedWidget.id && widget.type === 'pc_stats'
      ? { ...widget, ...patch }
      : widget) }, profile, false);
  }

  function updateSelectedPluginWidgetValue(inputId: string, value: string) {
    if (selectedWidget?.type !== 'plugin' || !selectedWidgetDefinition?.inputs.some((input) => input.id === inputId)) return;
    const values = Object.fromEntries(selectedWidgetDefinition.inputs.map((input) => [input.id, selectedWidget.values[input.id] ?? input.default]));
    values[inputId] = value;
    replaceWidgetScreen({ ...widgetScreen, widgets: widgetScreen.widgets.map((widget) => widget.id === selectedWidget.id && widget.type === 'plugin'
      ? { ...widget, values }
      : widget) }, profile, false);
  }


  function updateAutoSwitchApps(apps: string[]) {
    void save({ ...deck, profiles: deck.profiles.map((item) => item.id === profile.id ? { ...item, autoSwitchApps: apps } : item) });
  }

  function addAutoSwitchApp(value = autoSwitchAppDraft) {
    const app = value.trim();
    if (!app) return;
    if (profile.autoSwitchApps.some((item) => item.toLowerCase() === app.toLowerCase())) {
      setError('This application is already assigned to the selected profile.');
      return;
    }
    if (deck.profiles.some((item) => item.id !== profile.id && item.autoSwitchApps.some((target) => target.toLowerCase() === app.toLowerCase()))) {
      setError('This application is already assigned to another profile.');
      return;
    }
    setError('');
    setAutoSwitchAppDraft('');
    updateAutoSwitchApps([...profile.autoSwitchApps, app]);
  }

  function browseAutoSwitchApp() {
    setAppPicker('autoswitch');
  }

  function updateProfileAutoSwitch(enabled: boolean) {
    void save({ ...deck, profiles: deck.profiles.map((item) => item.id === profile.id ? { ...item, autoSwitchEnabled: enabled } : item) });
  }

  const savedLabel = busy ? 'Saving…' : error && failedRef.current === workingConfig ? 'Could not save' : workingConfig !== savedConfig ? 'Saving…' : 'All changes saved';
  const profileDefault = (deck.fallbackProfileId || deck.profiles[0].id);

  function commit(next: DeckConfig, message?: string) {
    if (message) setUndo({ message, config: deck });
    void save(next);
  }

  function undoLast() {
    if (!undo) return;
    const previous = undo.config;
    setUndo(null);
    setWorkingConfig(previous);
    const restored = previous.profiles.find((item) => item.id === profile.id) ?? previous.profiles[0];
    setProfileId(restored.id);
    setPageId(restored.pages.some((item) => item.id === page.id) ? page.id : restored.activePageId);
    void save(previous);
  }

  function selectProfile(id: string) {
    const next = deck.profiles.find((item) => item.id === id);
    if (!next) return;
    setProfileId(next.id);
    setPageId(next.activePageId);
    setButtonId('');
    setWidgetId('');
    setMenu(null);
    if (deck.activeProfileId !== next.id) void save({ ...deck, activeProfileId: next.id });
  }

  function selectPage(target: DeckProfile, item: DeckPage) {
    setRailOpen(false);
    setProfileId(target.id);
    setPageId(item.id);
    setButtonId('');
    setWidgetId('');
    setMenu(null);
    if (deck.activeProfileId !== target.id || target.activePageId !== item.id) {
      void save({ ...deck, activeProfileId: target.id, profiles: deck.profiles.map((entry) => entry.id === target.id ? { ...entry, activePageId: item.id } : entry) });
    }
  }

  function addPageTo(target: DeckProfile) {
    if (target.pages.length >= 8) return setError('Profiles can have up to 8 pages.');
    const id = `page-${Date.now()}`;
    const taken = new Set(target.pages.map((item) => item.name.toLowerCase()));
    let number = target.pages.length + 1;
    while (taken.has(`page ${number}`)) number++;
    const nextPage: DeckPage = { id, name: `Page ${number}`, rows: 2, columns: 3, buttons: [], widgets: [], folders: [] };
    const next = { ...deck, activeProfileId: target.id, profiles: deck.profiles.map((entry) => entry.id === target.id ? { ...entry, pages: [...entry.pages, nextPage], activePageId: id } : entry) };
    setWorkingConfig(next);
    setProfileId(target.id);
    setPageId(id);
    setButtonId('');
    setWidgetId('');
    setRenaming({ kind: 'page', id, profileId: target.id });
    setRenameDraft(nextPage.name);
    void save(next);
  }

  function startRename(kind: 'profile' | 'page', id: string, profileOwner: string, name: string) {
    setMenu(null);
    setRenaming({ kind, id, profileId: profileOwner });
    setRenameDraft(name);
  }

  function commitRename() {
    if (!renaming) return;
    const target = renaming;
    setRenaming(null);
    const name = renameDraft.trim();
    if (target.kind === 'profile') {
      const current = deck.profiles.find((item) => item.id === target.id);
      if (!current || name === current.name) return;
      if (!name || name.length > 32) return setError('Profile names must be 1–32 characters.');
      if (deck.profiles.some((item) => item.id !== target.id && item.name.toLowerCase() === name.toLowerCase())) return setError('Profile names must be unique.');
      setError('');
      void save({ ...deck, profiles: deck.profiles.map((item) => item.id === target.id ? { ...item, name } : item) });
      return;
    }
    const owner = deck.profiles.find((item) => item.id === target.profileId);
    const current = owner?.pages.find((item) => item.id === target.id);
    if (!owner || !current || name === current.name) return;
    if (!name || name.length > 24) return setError('Page names must be 1–24 characters.');
    if (owner.pages.some((item) => item.id !== target.id && item.name.toLowerCase() === name.toLowerCase())) return setError('Page names must be unique within a profile.');
    setError('');
    void save({ ...deck, profiles: deck.profiles.map((item) => item.id === owner.id ? { ...item, pages: item.pages.map((entry) => entry.id === target.id ? { ...entry, name } : entry) } : item) });
  }

  function setDefaultPage(target: DeckProfile, pageToSet: string) {
    setMenu(null);
    void save({ ...deck, profiles: deck.profiles.map((item) => item.id === target.id ? { ...item, defaultPageId: pageToSet } : item) });
  }

  function setDefaultProfile(id: string) {
    setMenu(null);
    void save({ ...deck, fallbackProfileId: id });
  }

  function openMenu(event: ReactMouseEvent<HTMLElement>, kind: 'profile' | 'page', profileOwner: string, pageOwned?: string) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ kind, profileId: profileOwner, pageId: pageOwned, x: Math.min(rect.left, window.innerWidth - 228), y: rect.bottom + 4 });
  }

  function openDeletePage(target: DeckProfile, pageToDelete: DeckPage) {
    setMenu(null);
    if (target.pages.length <= 1) return setError('Keep at least one page in each profile.');
    setDepChoice('remove');
    setDepTarget(target.pages.find((item) => item.id !== pageToDelete.id)!.id);
    setDialog({ type: 'deletePage', profileId: target.id, pageId: pageToDelete.id });
  }

  function openDeleteProfile(target: DeckProfile) {
    setMenu(null);
    if (deck.profiles.length <= 1) return setError('Keep at least one profile.');
    setDepChoice('remove');
    setDepTarget(deck.profiles.find((item) => item.id !== target.id)!.id);
    setDialog({ type: 'deleteProfile', profileId: target.id });
  }

  function confirmDelete() {
    if (!dialog || dialog.type === 'settings') return;
    const target = deck.profiles.find((item) => item.id === dialog.profileId);
    if (!target) return setDialog(null);
    if (dialog.type === 'deletePage') {
      const removed = target.pages.find((item) => item.id === dialog.pageId);
      const remaining = target.pages.filter((item) => item.id !== dialog.pageId);
      if (!removed || !remaining.length) return setDialog(null);
      const redirect = depChoice === 'move' && remaining.some((item) => item.id === depTarget) ? depTarget : '';
      const profiles = rewriteButtons(deck.profiles, (button, owner) => {
        if (owner.id !== target.id || button.action.type !== 'select_page' || button.action.pageId !== removed.id) return button;
        return redirect ? { ...button, action: { type: 'select_page', pageId: redirect } } : null;
      }).map((item) => item.id !== target.id ? item : {
        ...item,
        pages: item.pages.filter((entry) => entry.id !== removed.id),
        activePageId: item.activePageId === removed.id ? remaining[0].id : item.activePageId,
        defaultPageId: item.defaultPageId === removed.id ? remaining[0].id : item.defaultPageId,
      });
      setPageId(remaining.find((item) => item.id === page.id)?.id ?? profiles.find((item) => item.id === target.id)!.activePageId);
      setButtonId('');
      setWidgetId('');
      setDialog(null);
      commit({ ...deck, profiles }, `Deleted page “${removed.name}”`);
      return;
    }
    const remaining = deck.profiles.filter((item) => item.id !== target.id);
    const redirect = depChoice === 'move' && remaining.some((item) => item.id === depTarget) ? depTarget : '';
    const profiles = rewriteButtons(remaining, (button) => {
      if (button.action.type !== 'select_profile' || button.action.profileId !== target.id) return button;
      return redirect ? { ...button, action: { type: 'select_profile', profileId: redirect } } : null;
    });
    const nextActive = deck.activeProfileId === target.id ? remaining[0] : remaining.find((item) => item.id === deck.activeProfileId)!;
    setProfileId(profile.id === target.id ? remaining[0].id : profile.id);
    setPageId(profile.id === target.id ? remaining[0].activePageId : page.id);
    setButtonId('');
    setWidgetId('');
    setDialog(null);
    commit({ ...deck, activeProfileId: nextActive.id, fallbackProfileId: deck.fallbackProfileId === target.id ? remaining[0].id : deck.fallbackProfileId, profiles }, `Deleted profile “${target.name}”`);
  }

  function duplicatePage(target: DeckProfile, source: DeckPage) {
    setMenu(null);
    if (target.pages.length >= 8) return setError('Profiles can have up to 8 pages.');
    const copy = clonePage(source, copyName(source.name, target.pages.map((item) => item.name), 24));
    const next = { ...deck, activeProfileId: target.id, profiles: deck.profiles.map((entry) => entry.id === target.id ? { ...entry, pages: [...entry.pages, copy], activePageId: copy.id } : entry) };
    setWorkingConfig(next);
    setProfileId(target.id);
    setPageId(copy.id);
    setButtonId('');
    setWidgetId('');
    void save(next);
  }

  function duplicateProfile(source: DeckProfile) {
    setMenu(null);
    if (deck.profiles.length >= 32) return setError('You can create up to 32 profiles.');
    const pages = source.pages.map((item) => clonePage(item, item.name));
    const indexOf = (id: string) => Math.max(0, source.pages.findIndex((item) => item.id === id));
    const copy: DeckProfile = {
      id: freshId('profile'),
      name: copyName(source.name, deck.profiles.map((item) => item.name), 32),
      pages,
      activePageId: pages[indexOf(source.defaultPageId || source.activePageId)].id,
      defaultPageId: pages[indexOf(source.defaultPageId || source.pages[0].id)].id,
      autoSwitchApps: [],
      autoSwitchEnabled: false,
    };
    // Switch buttons that pointed at a page of the source now point at the matching page of the copy.
    const ids = new Map(source.pages.map((item, index) => [item.id, pages[index].id]));
    const [rewritten] = rewriteButtons([copy], (button) => button.action.type === 'select_page' && ids.has(button.action.pageId) ? { ...button, action: { type: 'select_page', pageId: ids.get(button.action.pageId)! } } : button);
    const next = { ...deck, activeProfileId: rewritten.id, profiles: [...deck.profiles, rewritten] };
    setWorkingConfig(next);
    setProfileId(rewritten.id);
    setPageId(rewritten.activePageId);
    setButtonId('');
    setWidgetId('');
    void save(next);
  }

  // --- Reordering and moving pages and profiles.
  function railDropAt(drag: NonNullable<typeof railDragRef.current>, x: number, y: number): { drop: RailDrop; hoverProfile: string } {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-rail-row]');
    const none = { drop: null, hoverProfile: '' };
    if (!row) {
      // Empty space under the last profile means "at the end" when a profile is being dragged.
      const last = deck.profiles[deck.profiles.length - 1];
      const inList = document.elementFromPoint(x, y)?.closest('.deck-rail-list');
      const lastGroup = document.querySelector<HTMLElement>('.deck-rail-group:last-child');
      return drag.kind === 'profile' && inList && lastGroup && y > lastGroup.getBoundingClientRect().bottom
        ? { drop: { kind: 'profile', index: deck.profiles.length, edge: 'after', rowKey: last.id }, hoverProfile: '' }
        : none;
    }
    const rect = row.getBoundingClientRect();
    const after = y > rect.top + rect.height / 2;
    const kind = row.dataset.railRow;
    const owner = deck.profiles.find((item) => item.id === row.dataset.profile);
    if (!owner) return none;
    if (drag.kind === 'profile') {
      const group = row.closest<HTMLElement>('[data-rail-group]') ?? row;
      const groupRect = group.getBoundingClientRect();
      const groupIndex = deck.profiles.indexOf(owner);
      const below = y > groupRect.top + groupRect.height / 2;
      return { drop: { kind: 'profile', index: groupIndex + (below ? 1 : 0), edge: below ? 'after' : 'before', rowKey: owner.id }, hoverProfile: '' };
    }
    const opened = owner.id === profile.id || owner.id === dragExpand;
    if (kind === 'page') {
      const index = owner.pages.findIndex((item) => item.id === row.dataset.page);
      return { drop: { kind: 'page', profileId: owner.id, index: index + (after ? 1 : 0), edge: after ? 'after' : 'before', rowKey: row.dataset.page ?? '' }, hoverProfile: '' };
    }
    if (kind === 'add') return { drop: { kind: 'page', profileId: owner.id, index: owner.pages.length, edge: 'before', rowKey: `add:${owner.id}` }, hoverProfile: '' };
    // A profile's own row: a closed one takes the page at its end and opens if you wait; an open one takes it first.
    return opened
      ? { drop: { kind: 'page', profileId: owner.id, index: 0, edge: 'after', rowKey: `profile:${owner.id}` }, hoverProfile: '' }
      : { drop: { kind: 'page', profileId: owner.id, index: owner.pages.length, edge: 'into', rowKey: `profile:${owner.id}` }, hoverProfile: owner.id };
  }

  function startRailDrag(event: React.PointerEvent<HTMLButtonElement>, kind: 'page' | 'profile', profileId: string, id: string, label: string) {
    if (event.button !== 0 || busy || renaming) return;
    railDragRef.current = { kind, id, profileId, label, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false, copy: event.altKey };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveRailDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    drag.active = true;
    drag.copy = event.altKey;
    event.preventDefault();
    document.body.classList.add('deck-dragging');
    const { drop, hoverProfile } = railDropAt(drag, event.clientX, event.clientY);
    // Waiting over a closed profile opens it, so a page can be dropped at an exact spot inside.
    if (expandTimer.current && expandTimer.current.profileId !== hoverProfile) { window.clearTimeout(expandTimer.current.timer); expandTimer.current = null; }
    if (hoverProfile && !expandTimer.current && hoverProfile !== dragExpand) {
      expandTimer.current = { profileId: hoverProfile, timer: window.setTimeout(() => { setDragExpand(hoverProfile); expandTimer.current = null; }, 500) };
    }
    let ok = drop !== null;
    let reason = '';
    if (drop?.kind === 'page') {
      const plan = planPageMove(deck, { fromProfileId: drag.profileId, pageId: drag.id, toProfileId: drop.profileId, index: drop.index, copy: drag.copy });
      if (!plan.ok) { ok = false; reason = plan.reason; } else if (plan.samePlace) ok = false;
    } else if (drop?.kind === 'profile') {
      const from = deck.profiles.findIndex((item) => item.id === drag.id);
      if (drop.index === from || drop.index === from + 1) ok = false;
    }
    setRailDrag({ kind: drag.kind, id: drag.id, label: drag.label, x: event.clientX, y: event.clientY, copy: drag.copy, ok, reason, drop: ok ? drop : null });
    const list = document.querySelector<HTMLElement>('.deck-rail-list');
    if (list) {
      const bounds = list.getBoundingClientRect();
      if (event.clientY < bounds.top + 28) list.scrollBy({ top: -12 });
      else if (event.clientY > bounds.bottom - 28) list.scrollBy({ top: 12 });
    }
  }

  function endRailDrag() {
    railDragRef.current = null;
    document.body.classList.remove('deck-dragging');
    if (expandTimer.current) window.clearTimeout(expandTimer.current.timer);
    expandTimer.current = null;
    setRailDrag(null);
    setDragExpand('');
  }

  function finishRailDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const wasDrag = drag.active;
    const { drop } = wasDrag ? railDropAt(drag, event.clientX, event.clientY) : { drop: null };
    const copy = event.altKey;
    endRailDrag();
    if (!wasDrag) return;
    // The click that follows a drag must not also select the row.
    suppressRailClick.current = true;
    window.setTimeout(() => { suppressRailClick.current = false; }, 80);
    if (!drop) return;
    if (drag.kind === 'profile' && drop.kind === 'profile') return moveProfileTo(drag.id, drop.index);
    if (drag.kind === 'page' && drop.kind === 'page') requestPageMove({ fromProfileId: drag.profileId, pageId: drag.id, toProfileId: drop.profileId, index: drop.index, copy });
  }

  function cancelRailDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (railDragRef.current?.pointerId === event.pointerId) endRailDrag();
  }

  function moveProfileTo(profileToMove: string, index: number) {
    const next = reorderProfile(deck, profileToMove, index);
    if (next === deck) return;
    const moved = next.profiles.findIndex((item) => item.id === profileToMove);
    setAnnounce(`Moved profile ${next.profiles[moved].name} to position ${moved + 1} of ${next.profiles.length}`);
    commit(next, `Moved profile “${next.profiles[moved].name}”`);
  }

  // Plans a move; asks only when something would stop working, otherwise just does it.
  function requestPageMove(request: MoveRequest) {
    const plan = planPageMove(deck, request);
    if (!plan.ok) return setError(plan.reason);
    if (plan.samePlace) return;
    setError('');
    if (!plan.needsDecision) return performPageMove(request, { incoming: 'remove', outgoing: 'remove' });
    const from = deck.profiles.find((item) => item.id === request.fromProfileId);
    const to = deck.profiles.find((item) => item.id === request.toProfileId);
    setMoveDialog({ request, decisions: plan.decisions, incoming: 'remove', outgoing: 'remove', pageName: from?.pages.find((item) => item.id === request.pageId)?.name ?? '', toName: to?.name ?? '' });
  }

  function performPageMove(request: MoveRequest, resolution: Resolution) {
    const result = applyPageMove(deck, request, resolution);
    if (!result || result.config === deck) return;
    // The editor follows the page, so the phone shows it too.
    const next: DeckConfig = {
      ...result.config,
      activeProfileId: result.profileId,
      profiles: result.config.profiles.map((item) => item.id === result.profileId ? { ...item, activePageId: result.pageId } : item),
    };
    setMoveDialog(null);
    setProfileId(result.profileId);
    setPageId(result.pageId);
    setButtonId('');
    setWidgetId('');
    const target = next.profiles.find((item) => item.id === result.profileId);
    setAnnounce(`${result.summary}, position ${(target?.pages.findIndex((item) => item.id === result.pageId) ?? 0) + 1} of ${target?.pages.length ?? 1}`);
    commit(next, result.summary);
  }

  // Keyboard and menu equivalents of dragging: one step up or down inside the profile or rail.
  function stepRow(kind: 'page' | 'profile', ownerId: string, id: string, direction: -1 | 1) {
    setMenu(null);
    if (kind === 'profile') {
      const at = deck.profiles.findIndex((item) => item.id === id);
      const to = at + direction;
      if (to < 0 || to >= deck.profiles.length) return setAnnounce(direction < 0 ? 'Already first' : 'Already last');
      return moveProfileTo(id, direction < 0 ? to : to + 1);
    }
    const owner = deck.profiles.find((item) => item.id === ownerId);
    const at = owner?.pages.findIndex((item) => item.id === id) ?? -1;
    if (!owner || at < 0) return;
    const to = at + direction;
    if (to < 0 || to >= owner.pages.length) return setAnnounce(direction < 0 ? 'Already first' : 'Already last');
    requestPageMove({ fromProfileId: ownerId, pageId: id, toProfileId: ownerId, index: direction < 0 ? to : to + 1, copy: false });
  }

  function railKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, kind: 'page' | 'profile', ownerId: string, id: string) {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    stepRow(kind, ownerId, id, event.key === 'ArrowUp' ? -1 : 1);
  }

  function openSettings(id: string) {
    if (id !== profile.id) selectProfile(id);
    setMenu(null);
    setDialog({ type: 'settings', profileId: id });
  }

  const dialogProfile = dialog ? deck.profiles.find((item) => item.id === dialog.profileId) : undefined;
  const dialogPage = dialog?.type === 'deletePage' ? dialogProfile?.pages.find((item) => item.id === dialog.pageId) : undefined;
  const menuProfile = menu ? deck.profiles.find((item) => item.id === menu.profileId) : undefined;
  const menuPage = menu?.pageId ? menuProfile?.pages.find((item) => item.id === menu.pageId) : undefined;
  const hasSelection = Boolean(selected || selectedWidget);
  const showSettings = hasSelection && panel === 'settings';
  const panelTitle = selectedWidget
    ? selectedWidget.type === 'clock' ? 'Clock' : selectedWidget.type === 'pc_stats' ? 'PC stats' : selectedWidget.type === 'now_playing' ? 'Now Playing' : selectedWidget.type === 'lyrics' ? 'Lyrics' : selectedWidgetDefinition?.name ?? 'Plugin widget'
    : selected?.label ?? '';
  const panelSubtitle = selectedWidget
    ? selectedWidget.type === 'clock' ? 'Shows the phone’s local time' : selectedWidget.type === 'pc_stats' ? 'Live readings from this PC' : selectedWidget.type === 'now_playing' ? 'System media from this PC' : selectedWidget.type === 'lyrics' ? 'Synced lyrics for what this PC plays' : `${plugins.find((plugin) => plugin.id === selectedWidget.pluginId)?.name ?? 'Plugin'} widget`
    : selected ? buttonSummary(selected, page) : '';
  const renameInput = (kind: 'profile' | 'page', id: string, maxLength: number) => renaming?.kind === kind && renaming.id === id
    ? <input className="deck-rail-rename" aria-label={`Rename ${kind}`} value={renameDraft} maxLength={maxLength} autoFocus disabled={busy} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setRenameDraft(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenaming(null); }} />
    : null;

  return <div className={`deck-workspace ${hasSelection ? 'has-selection' : ''} ${sidePanelOpen ? 'side-open' : ''}`} onKeyDown={(event) => { if (event.key === 'Escape') { setMenu(null); setDialog(null); setMoveDialog(null); setRailOpen(false); setSidePanelOpen(false); } }}>
    {railOpen ? <div className="deck-rail-scrim" onClick={() => setRailOpen(false)} /> : null}
    <aside className={`deck-rail ${railOpen ? 'open' : ''}`} aria-label="Profiles and pages">
      <div className="deck-rail-head"><span>Profiles</span><span>{deck.profiles.length} of 32</span></div>
      <div className="deck-rail-list">
        {deck.profiles.map((item) => {
          const open = item.id === profile.id || item.id === dragExpand;
          const profileDrop = railDrag?.drop?.kind === 'profile' && railDrag.drop.rowKey === item.id ? railDrag.drop.edge : '';
          const profileInto = railDrag?.drop?.kind === 'page' && railDrag.drop.rowKey === `profile:${item.id}` ? railDrag.drop.edge : '';
          const addDrop = railDrag?.drop?.kind === 'page' && railDrag.drop.rowKey === `add:${item.id}`;
          return <div className={`deck-rail-group ${profileDrop ? `drop-${profileDrop}` : ''} ${railDrag?.kind === 'profile' && railDrag.id === item.id ? 'dragging' : ''}`} data-rail-group data-profile={item.id} key={item.id}>
            <div className={`deck-rail-row profile ${item.id === profile.id ? 'selected' : ''} ${profileInto ? `drop-${profileInto}` : ''}`} data-rail-row="profile" data-profile={item.id}>
              {renameInput('profile', item.id, 32) ?? <button type="button" className="deck-rail-main" aria-expanded={open} disabled={busy} onClick={() => { if (!suppressRailClick.current) selectProfile(item.id); }} onDoubleClick={() => startRename('profile', item.id, item.id, item.name)} onPointerDown={(event) => startRailDrag(event, 'profile', item.id, item.id, item.name)} onPointerMove={moveRailDrag} onPointerUp={finishRailDrag} onPointerCancel={cancelRailDrag} onKeyDown={(event) => railKeyDown(event, 'profile', item.id, item.id)}>
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="deck-rail-name">{item.name}</span>
                {profileDefault === item.id ? <Star size={12} className="deck-star" aria-label="Default profile" /> : null}
                {item.autoSwitchEnabled && item.autoSwitchApps.length ? <span className="deck-badge">Auto</span> : null}
              </button>}
              <button type="button" className="deck-rail-more" aria-label={`${item.name} profile menu`} disabled={busy} onClick={(event) => openMenu(event, 'profile', item.id)}><Ellipsis size={14} /></button>
            </div>
            {open ? <>
              {item.pages.map((entry) => {
                const pageDrop = railDrag?.drop?.kind === 'page' && railDrag.drop.rowKey === entry.id && railDrag.drop.profileId === item.id ? railDrag.drop.edge : '';
                return <div key={entry.id} className={`deck-rail-row page ${entry.id === page.id && item.id === profile.id ? 'selected' : ''} ${pageDrop ? `drop-${pageDrop}` : ''} ${railDrag?.kind === 'page' && railDrag.id === entry.id && !railDrag.copy ? 'dragging' : ''}`} data-rail-row="page" data-profile={item.id} data-page={entry.id}>
                  {renameInput('page', entry.id, 24) ?? <button type="button" className="deck-rail-main" disabled={busy} onClick={() => { if (!suppressRailClick.current) selectPage(item, entry); }} onDoubleClick={() => startRename('page', entry.id, item.id, entry.name)} onPointerDown={(event) => startRailDrag(event, 'page', item.id, entry.id, entry.name)} onPointerMove={moveRailDrag} onPointerUp={finishRailDrag} onPointerCancel={cancelRailDrag} onKeyDown={(event) => railKeyDown(event, 'page', item.id, entry.id)}>
                    <span className="deck-rail-name">{entry.name}</span>
                    {(item.defaultPageId || item.pages[0].id) === entry.id ? <Star size={12} className="deck-star" aria-label="Default page" /> : null}
                  </button>}
                  <button type="button" className="deck-rail-more" aria-label={`${entry.name} page menu`} disabled={busy} onClick={(event) => openMenu(event, 'page', item.id, entry.id)}><Ellipsis size={14} /></button>
                </div>;
              })}
              <button type="button" className={`deck-rail-add ${addDrop ? 'drop-before' : ''}`} data-rail-row="add" data-profile={item.id} disabled={busy || item.pages.length >= 8} onClick={() => addPageTo(item)}><Plus size={12} /> Add page</button>
            </> : null}
          </div>;
        })}
      </div>
      <div className="deck-rail-foot"><button type="button" className="secondary-button" onClick={addProfile} disabled={busy || deck.profiles.length >= 32}><Plus size={14} /> New profile</button></div>
    </aside>
    <div className="deck-main">
      <div className="deck-main-head">
        <button type="button" className="secondary-button deck-rail-toggle" aria-expanded={railOpen} aria-haspopup="true" onClick={() => setRailOpen(!railOpen)}><Layers size={14} /><span>{profile.name} › {page.name}</span><ChevronDown size={13} /></button>
        <div className={`deck-crumb ${folder ? 'in-folder' : ''}`}><strong>{folder ? folder.name : page.name}</strong><span>{folder ? `${profile.name} › ${page.name} › folder` : profile.name}</span></div>
        {folder ? <button type="button" className="secondary-button" data-deck-back onClick={closeFolder}><ArrowLeft size={13} /> Back to {page.name}</button> : null}
        <button type="button" className="secondary-button deck-panel-toggle" aria-expanded={sidePanelOpen} onClick={() => setSidePanelOpen(!sidePanelOpen)}><PanelRight size={14} /> {hasSelection ? 'Settings' : 'Add'}</button>
        <span className={`deck-save-state ${savedLabel === 'All changes saved' ? 'saved' : savedLabel === 'Could not save' ? 'failed' : ''}`} role="status"><i />{savedLabel}</span>
      </div>
      {deck.migrationNotes?.length ? <div className="deck-notice" role="status"><div><strong>Your deck was updated.</strong> Widgets now sit on the page grid next to your buttons.<ul>{deck.migrationNotes.map((note) => <li key={note}>{note}</li>)}</ul></div><button type="button" className="secondary-button" onClick={() => void save({ ...deck, migrationNotes: [] })}>Got it</button></div> : null}
      {error ? <p className="usb-error deck-error" role="alert">{error}<button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setError('')}>✕</button></p> : null}
      <div className="deck-main-scroll">
        <div className="deck-canvas-wrap" onClick={(event) => { if (event.target === event.currentTarget) { clearSelection(); setPendingCell(null); } }}>
          <div className="deck-canvas-heading">
            <div><h2>{folder ? folder.name : page.name}</h2><p>{widgetScreen.buttons.length + widgetScreen.widgets.length} items · {widgetOccupied.size} of {widgetScreen.rows * widgetScreen.columns} cells · Drag to move or resize{folder ? ' · Drop on Back to move out' : ''}</p></div>
            <div className="heading-actions">
              <label className="grid-size-control">Rows<DeckSelect value={String(widgetScreen.rows)} disabled={busy} options={Array.from({ length: 6 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))} onChange={(value) => resizeGrid('rows', value)} /></label>
              <label className="grid-size-control">Columns<DeckSelect value={String(widgetScreen.columns)} disabled={busy} options={Array.from({ length: 6 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))} onChange={(value) => resizeGrid('columns', value)} /></label>
            </div>
          </div>
          <div ref={widgetCanvasRef} className="deck-canvas widget-canvas" style={{ gridTemplateColumns: `repeat(${widgetScreen.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${widgetScreen.rows}, minmax(100px, auto))` }} onClick={(event) => { if (event.target === event.currentTarget) { clearSelection(); setPendingCell(null); } }}>
            {Array.from({ length: widgetScreen.rows * widgetScreen.columns }, (_, index) => {
              const row = Math.floor(index / widgetScreen.columns);
              const column = index % widgetScreen.columns;
              const item = widgetOccupied.get(index);
              if (item) {
                const placement = item.type === 'button' ? buttonPlacement(widgetScreen, item.button) : item.widget.placement;
                if (placement.row !== row || placement.column !== column) return null;
                const itemId = item.type === 'button' ? item.button.id : item.widget.id;
                const preview = resizePreview?.id === itemId ? resizePreview : null;
                const shown = preview?.placement ?? placement;
                const previewRows = Math.min(shown.rowSpan, widgetScreen.rows - placement.row);
                const previewColumns = Math.min(shown.columnSpan, widgetScreen.columns - placement.column);
                const grid = { columns: widgetScreen.columns, rows: widgetScreen.rows };
                const folderOf = item.type === 'button' && item.button.action.type === 'open_folder' ? page.folders.find((entry) => entry.id === (item.button.action as { folderId: string }).folderId) : undefined;
                return <button key={itemId} type="button" data-deck-item={itemId} data-deck-cell="true" data-surface="widgets" data-row={placement.row} data-column={placement.column} className={`deck-button ${item.type === 'widget' ? 'clock-widget' : ''} ${folderOf ? 'deck-folder' : ''} ${item.type === 'widget' && (item.widget.type === 'now_playing' || item.widget.type === 'lyrics' || item.widget.type === 'clock' || item.widget.type === 'pc_stats') ? 'now-playing-widget-preview' : ''} ${item.type === 'button' && selected?.id === itemId ? 'selected' : ''} ${item.type === 'widget' && selectedWidget?.id === itemId ? 'selected' : ''} ${dragOverButtonId === itemId ? 'drop-target' : ''} ${draggingButtonId === itemId ? 'dragging' : ''} ${preview && !preview.valid ? 'resize-invalid' : ''}`} style={{ gridColumn: `${placement.column + 1} / span ${previewColumns}`, gridRow: `${placement.row + 1} / span ${previewRows}` }} onClick={() => { if (item.type === 'button') selectButton(item.button.id); else selectWidgetItem(item.widget.id); setPanel('settings'); }} onDoubleClick={() => { if (folderOf) openFolder(folderOf.id); }} onPointerDown={(event) => item.type === 'button' ? startButtonDrag(event, item.button.id, 'widgets') : startWidgetDrag(event, item.widget.id)} onPointerMove={moveButtonDrag} onPointerUp={finishButtonDrag} onPointerCancel={cancelButtonDrag} onLostPointerCapture={cancelButtonDrag}>
                  {item.type === 'button' ? <><span>{iconForButton(item.button, playbackState, theme)}</span><strong>{buttonLabel(item.button, playbackState)}</strong>{folderOf ? <small>Folder · {folderOf.buttons.length + folderOf.widgets.length} items</small> : null}</> : item.widget.type === 'clock' ? (() => { const block = widgetBlockSize(widgetSurface ?? REFERENCE_WIDGET_SURFACE, grid.columns, grid.rows, previewColumns, previewRows); return <ClockFacePreview face={item.widget.face ?? 'digital'} color={item.widget.color} width={block.width} height={block.height} />; })() : item.widget.type === 'pc_stats' ? (() => { const block = widgetBlockSize(widgetSurface ?? REFERENCE_WIDGET_SURFACE, grid.columns, grid.rows, previewColumns, previewRows); return <PcStatsPreview style={item.widget.face ?? 'ring'} metric={item.widget.metric} color={item.widget.color} gpu={item.widget.gpu} width={block.width} height={block.height} columns={previewColumns} rows={previewRows} />; })() : item.widget.type === 'now_playing' ? <NowPlayingPreview media={mediaState} surface={widgetSurface ?? REFERENCE_WIDGET_SURFACE} columns={grid.columns} rows={grid.rows} columnSpan={previewColumns} rowSpan={previewRows} /> : item.widget.type === 'lyrics' ? <LyricsPreview media={mediaState} surface={widgetSurface ?? REFERENCE_WIDGET_SURFACE} columns={grid.columns} rows={grid.rows} columnSpan={previewColumns} rowSpan={previewRows} /> : item.widget.renderType === 'text' ? <><span className="clock-widget-icon"><Package size={18} /></span><strong>{item.widget.values.title || item.widget.widgetId}</strong><small>{item.widget.values.body || 'Text widget'}</small></> : <><span className="clock-widget-icon"><Package size={18} /></span><strong>Unavailable widget</strong><small>{item.widget.renderType}</small></>}
                  <span className="deck-button-size">{preview ? `${shown.columnSpan}×${shown.rowSpan}` : placement.rowSpan > 1 || placement.columnSpan > 1 ? `${placement.columnSpan}×${placement.rowSpan}` : null}</span>
                  <span className="deck-resize-handle" aria-hidden="true" onPointerDown={(event) => item.type === 'button' ? startResize(event, item.button, 'button') : startResize(event, item.widget, 'widget')} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={cancelResize} onLostPointerCapture={cancelResize} />
                </button>;
              }
              const pending = pendingCell?.row === row && pendingCell.column === column;
              return <button key={`empty-${index}`} type="button" data-deck-cell="true" data-surface="widgets" data-row={row} data-column={column} className={`deck-button deck-slot ${pending ? 'pending' : ''} ${dragOverCellKey === `${row}:${column}` ? 'drop-target' : ''}`} onClick={() => { clearSelection(); setPendingCell({ row, column }); }} disabled={busy} aria-pressed={pending} aria-label={`Choose row ${row + 1}, column ${column + 1}`}><Plus size={17} /><span>{pending ? 'Pick an item →' : 'Add'}</span></button>;
            })}
          </div>
        </div>
      </div>
    </div>
      <div className="button-properties" role="region" aria-label="Add or edit">
        <div className="deck-panel-bar">
        <div className="deck-panel-tabs transport-tabs" role="tablist" aria-label="Side panel">
          <button type="button" role="tab" aria-selected={!showSettings} className={`transport-tab ${!showSettings ? 'selected' : ''}`} onClick={() => setPanel('add')}>Add</button>
          <button type="button" role="tab" aria-selected={showSettings} className={`transport-tab ${showSettings ? 'selected' : ''}`} disabled={!hasSelection} onClick={() => setPanel('settings')}>Settings</button>
        </div>
          <button type="button" className="icon-button deck-panel-close" aria-label="Close panel" onClick={() => setSidePanelOpen(false)}><X size={14} /></button>
        </div>
        {showSettings ? <>
          <PanelHeader title={panelTitle} subtitle={panelSubtitle} noun={selectedWidget ? 'widget' : selected?.action.type === 'open_folder' ? 'folder' : 'button'} busy={busy} onDuplicate={duplicateSelected} onDelete={deleteSelected} />
          <div className="panel-body property-fields">
            {selectedWidget?.type === 'clock' ? <ClockWidgetSettings key={selectedWidget.id} face={selectedWidget.face} color={selectedWidget.color} busy={busy} block={widgetBlockSize(widgetSurface ?? REFERENCE_WIDGET_SURFACE, widgetScreen.columns, widgetScreen.rows, selectedWidget.placement.columnSpan, selectedWidget.placement.rowSpan)} onChange={updateSelectedClockWidget} /> : selectedWidget?.type === 'pc_stats' ? <PcStatsSettings key={selectedWidget.id} style={selectedWidget.face} metric={selectedWidget.metric} color={selectedWidget.color} gpu={selectedWidget.gpu} busy={busy} columns={selectedWidget.placement.columnSpan} rows={selectedWidget.placement.rowSpan} block={widgetBlockSize(widgetSurface ?? REFERENCE_WIDGET_SURFACE, widgetScreen.columns, widgetScreen.rows, selectedWidget.placement.columnSpan, selectedWidget.placement.rowSpan)} onChange={updateSelectedPcStatsWidget} /> : selectedWidget?.type === 'now_playing' ? <PanelSection title="About"><p className="panel-note">Shows the active media session, artwork and playback progress from this PC.</p></PanelSection> : selectedWidget?.type === 'lyrics' ? <PanelSection title="About"><p className="panel-note">Shows time-synced lyrics from LRCLIB for the song playing on this PC. Videos and tracks LRCLIB doesn’t know show “No lyrics found”. Each phone fetches lyrics over its own internet connection.</p></PanelSection> : selectedWidget?.type === 'plugin' ? <PluginWidgetProperties widget={selectedWidget} definition={selectedWidgetDefinition} busy={busy} onChange={updateSelectedPluginWidgetValue} /> : selected?.action.type === 'open_folder' ? <>
              <button type="button" className="primary-button panel-wide" onClick={() => openFolder((selected.action as { folderId: string }).folderId)}><FolderOpen size={14} /> Open folder</button>
              <PanelSection title="Folder"><label>Name<input value={selected.label} maxLength={24} disabled={busy} onChange={(event) => renameFolder(selected, event.target.value)} /></label><p className="panel-note">Double-click a folder on the grid to open it. Drag items onto it to move them inside.</p></PanelSection>
            </> : selected ? <ButtonProperties key={selected.id} button={selected} busy={busy} isMacos={isMacos} profiles={deck.profiles} pages={profile.pages} plugins={plugins} onChange={updateButton} onIcon={(kind, target, prefetched) => void attachIcon(selected.id, kind, target, prefetched)} /> : null}
          </div>
        </> : <DeckLibrary
        pluginActions={plugins.flatMap((plugin) => plugin.actions.map((action) => ({ pluginId: plugin.id, actionId: action.id, label: `${plugin.name} / ${action.name}` })))}
        pluginWidgets={pluginWidgetOptions.map((option) => ({ pluginId: option.plugin.id, widgetId: option.widget.id, label: option.label }))}
        targetLabel={pendingCell ? `row ${pendingCell.row + 1}, column ${pendingCell.column + 1}` : null}
        inFolder={Boolean(folder)}
        canSwitchPage={profile.pages.length > 1}
        canSwitchProfile={deck.profiles.length > 1}
        busy={busy}
        drag={{ start: startLibraryDrag, move: moveLibraryDrag, end: finishLibraryDrag, cancel: cancelLibraryDrag }}
        onKeyPick={(choice) => void addItem(choice)}
        onClearTarget={() => setPendingCell(null)}
      />}
      </div>
    {menu && menuProfile ? <>
      <div className="deck-menu-scrim" onClick={() => setMenu(null)} />
      <div className="deck-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
        {menu.kind === 'page' && menuPage ? <>
          <button type="button" role="menuitem" onClick={() => startRename('page', menuPage.id, menuProfile.id, menuPage.name)}>Rename</button>
          <button type="button" role="menuitem" disabled={menuProfile.pages.length >= 8} onClick={() => duplicatePage(menuProfile, menuPage)}>Duplicate</button>
          <button type="button" role="menuitem" disabled={(menuProfile.defaultPageId || menuProfile.pages[0].id) === menuPage.id} onClick={() => setDefaultPage(menuProfile, menuPage.id)}>Set as default page</button>
          <hr />
          <button type="button" role="menuitem" disabled={menuProfile.pages[0].id === menuPage.id} onClick={() => stepRow('page', menuProfile.id, menuPage.id, -1)}>Move up <kbd>Alt ↑</kbd></button>
          <button type="button" role="menuitem" disabled={menuProfile.pages[menuProfile.pages.length - 1].id === menuPage.id} onClick={() => stepRow('page', menuProfile.id, menuPage.id, 1)}>Move down <kbd>Alt ↓</kbd></button>
          {deck.profiles.length > 1 ? <>
            <div className="deck-menu-label">{menuProfile.pages.length > 1 ? 'Move to profile' : 'Copy to profile (a profile keeps one page)'}</div>
            {deck.profiles.filter((item) => item.id !== menuProfile.id).map((item) => <button key={item.id} type="button" role="menuitem" disabled={item.pages.length >= 32} onClick={() => { setMenu(null); requestPageMove({ fromProfileId: menuProfile.id, pageId: menuPage.id, toProfileId: item.id, index: item.pages.length, copy: menuProfile.pages.length <= 1 }); }}>{item.name}{item.pages.length >= 32 ? ' (full)' : ''}</button>)}
          </> : null}
          <hr />
          <button type="button" role="menuitem" className="danger" disabled={menuProfile.pages.length <= 1} onClick={() => openDeletePage(menuProfile, menuPage)}>Delete page…</button>
        </> : <>
          <button type="button" role="menuitem" onClick={() => startRename('profile', menuProfile.id, menuProfile.id, menuProfile.name)}>Rename</button>
          <button type="button" role="menuitem" disabled={deck.profiles.length >= 32} onClick={() => duplicateProfile(menuProfile)}>Duplicate</button>
          <button type="button" role="menuitem" disabled={profileDefault === menuProfile.id} onClick={() => setDefaultProfile(menuProfile.id)}>Set as default profile</button>
          <button type="button" role="menuitem" onClick={() => openSettings(menuProfile.id)}>Profile settings…</button>
          <hr />
          <button type="button" role="menuitem" disabled={deck.profiles[0].id === menuProfile.id} onClick={() => stepRow('profile', menuProfile.id, menuProfile.id, -1)}>Move up <kbd>Alt ↑</kbd></button>
          <button type="button" role="menuitem" disabled={deck.profiles[deck.profiles.length - 1].id === menuProfile.id} onClick={() => stepRow('profile', menuProfile.id, menuProfile.id, 1)}>Move down <kbd>Alt ↓</kbd></button>
          <hr />
          <button type="button" role="menuitem" className="danger" disabled={deck.profiles.length <= 1} onClick={() => openDeleteProfile(menuProfile)}>Delete profile…</button>
        </>}
      </div>
    </> : null}
    {dialog && dialogProfile ? <div className="deck-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(null); }}>
      {dialog.type === 'settings' ? <div className="deck-dialog" role="dialog" aria-modal="true" aria-label={`${dialogProfile.name} settings`}>
        <h2>{dialogProfile.name} settings</h2>
        <label className="deck-dialog-field">Name<input value={renaming?.kind === 'profile' && renaming.id === dialogProfile.id ? renameDraft : dialogProfile.name} maxLength={32} disabled={busy} onFocus={() => startRename('profile', dialogProfile.id, dialogProfile.id, dialogProfile.name)} onChange={(event) => setRenameDraft(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
        <div className="deck-dialog-row"><div><strong>Default profile</strong><p>Open Dock opens on this profile, and returns to it when an automatic profile is left.</p></div><button type="button" role="switch" aria-checked={profileDefault === dialogProfile.id} aria-label="Default profile" className={`setting-switch ${profileDefault === dialogProfile.id ? 'enabled' : ''}`} disabled={busy || profileDefault === dialogProfile.id} onClick={() => setDefaultProfile(dialogProfile.id)}><span /></button></div>
        <div className="deck-dialog-row"><div><strong>Switch automatically</strong><p>Use this profile when one of its apps is in front on this PC.</p></div><button type="button" role="switch" aria-checked={dialogProfile.autoSwitchEnabled} aria-label="Switch automatically" className={`setting-switch ${dialogProfile.autoSwitchEnabled ? 'enabled' : ''}`} disabled={busy} onClick={() => updateProfileAutoSwitch(!dialogProfile.autoSwitchEnabled)}><span /></button></div>
        <div className="auto-switch-apps"><div className="auto-switch-apps-heading"><strong>Apps assigned to {dialogProfile.name}</strong><span>Entering a process name also works.</span></div><div className="auto-switch-app-add"><input value={autoSwitchAppDraft} maxLength={512} disabled={busy} placeholder={isMacos ? 'App name or .app path' : 'App name or .exe path'} onChange={(event) => setAutoSwitchAppDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addAutoSwitchApp(); } }} /><button type="button" className="secondary-button" disabled={busy || !autoSwitchAppDraft.trim()} onClick={() => addAutoSwitchApp()}>Add app</button><button type="button" className="icon-button" aria-label="Browse for an application" title="Browse for an application" disabled={busy} onClick={browseAutoSwitchApp}><FolderOpen size={15} /></button></div>{dialogProfile.autoSwitchApps.length ? <div className="auto-switch-app-list">{dialogProfile.autoSwitchApps.map((app) => <span className="auto-switch-app" key={app}>{app}<button type="button" className="icon-button" aria-label={`Remove ${app}`} disabled={busy} onClick={() => updateAutoSwitchApps(dialogProfile.autoSwitchApps.filter((entry) => entry !== app))}><Trash2 size={12} /></button></span>)}</div> : <p className="auto-switch-empty">No apps assigned to this profile yet.</p>}</div>
        {error ? <p className="usb-error" role="alert">{error}</p> : null}
        <div className="deck-dialog-foot spread"><button type="button" className="secondary-button danger" disabled={deck.profiles.length <= 1} onClick={() => openDeleteProfile(dialogProfile)}>Delete profile…</button><button type="button" className="primary-button" onClick={() => setDialog(null)}>Done</button></div>
      </div> : <div className="deck-dialog" role="dialog" aria-modal="true" aria-label={dialog.type === 'deletePage' ? 'Delete page' : 'Delete profile'}>
        {(() => {
          const isPage = dialog.type === 'deletePage';
          const name = isPage ? dialogPage?.name ?? '' : dialogProfile.name;
          const refs = isPage ? buttonsOf(dialogProfile).filter((button) => button.action.type === 'select_page' && button.action.pageId === dialog.pageId).length
            : deck.profiles.filter((item) => item.id !== dialogProfile.id).flatMap(buttonsOf).filter((button) => button.action.type === 'select_profile' && button.action.profileId === dialogProfile.id).length;
          const counted = (pages: DeckPage[]) => pages.reduce((sum, item) => ({
            buttons: sum.buttons + [...item.buttons, ...item.folders.flatMap((entry) => entry.buttons)].filter((button) => button.action.type !== 'open_folder').length,
            widgets: sum.widgets + item.widgets.length + item.folders.reduce((inner, entry) => inner + entry.widgets.length, 0),
            folders: sum.folders + item.folders.length,
          }), { buttons: 0, widgets: 0, folders: 0 });
          const totals = counted(isPage ? (dialogPage ? [dialogPage] : []) : dialogProfile.pages);
          const buttonCount = totals.buttons;
          const widgetCount = totals.widgets;
          const folderCount = totals.folders;
          const options = isPage ? dialogProfile.pages.filter((item) => item.id !== dialog.pageId) : deck.profiles.filter((item) => item.id !== dialogProfile.id);
          return <>
            <h2>Delete {isPage ? 'page' : 'profile'} “{name}”?</h2>
            <p className="deck-dialog-copy">{buttonCount + widgetCount + folderCount === 0 ? 'It is empty.' : `This also removes ${[buttonCount ? `${buttonCount} button${buttonCount === 1 ? '' : 's'}` : '', widgetCount ? `${widgetCount} widget${widgetCount === 1 ? '' : 's'}` : '', folderCount ? `${folderCount} folder${folderCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}.`} You can undo this right after.</p>
            {refs > 0 ? <div className="deck-dialog-warning" role="note"><strong>{refs} button{refs === 1 ? '' : 's'}</strong> {isPage ? 'switch to this page.' : 'in other profiles switch to this profile.'} Choose what happens to {refs === 1 ? 'it' : 'them'}:
              <label className="deck-dialog-option"><input type="radio" name="dependents" checked={depChoice === 'remove'} onChange={() => setDepChoice('remove')} /><span><b>Remove {refs === 1 ? 'that button' : 'those buttons'}</b></span></label>
              <label className="deck-dialog-option"><input type="radio" name="dependents" checked={depChoice === 'move'} onChange={() => setDepChoice('move')} /><span><b>Send {refs === 1 ? 'it' : 'them'} to another {isPage ? 'page' : 'profile'}</b></span></label>
              {depChoice === 'move' ? <DeckSelect value={depTarget} options={options.map((item) => ({ value: item.id, label: item.name }))} onChange={setDepTarget} /> : null}
            </div> : null}
            <div className="deck-dialog-foot"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>Cancel</button><button type="button" className="primary-button danger" onClick={confirmDelete}>Delete {isPage ? 'page' : 'profile'}</button></div>
          </>;
        })()}
      </div>}
    </div> : null}
    {railDrag ? <div className="deck-drag-ghost" data-ok={railDrag.ok} style={{ left: railDrag.x + 14, top: railDrag.y + 14 }}>{railDrag.copy && railDrag.kind === 'page' ? 'Copy · ' : ''}{railDrag.label}{railDrag.reason ? <small>{railDrag.reason}</small> : null}</div> : null}
    {moveDialog ? <div className="deck-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setMoveDialog(null); }}>
      <div className="deck-dialog" role="dialog" aria-modal="true" aria-label="Move page">
        <h2>{moveDialog.request.copy ? 'Copy' : 'Move'} “{moveDialog.pageName}” to {moveDialog.toName}?</h2>
        <p className="deck-dialog-copy">Buttons that switch pages only work inside one profile.</p>
        {moveDialog.decisions.incoming.count > 0 ? <div className="deck-dialog-warning" role="note"><strong>{moveDialog.decisions.incoming.count} button{moveDialog.decisions.incoming.count === 1 ? '' : 's'}</strong> on other pages switch to this page.
          <label className="deck-dialog-option"><input type="radio" name="incoming" checked={moveDialog.incoming === 'remove'} onChange={() => setMoveDialog({ ...moveDialog, incoming: 'remove' })} /><span><b>Remove {moveDialog.decisions.incoming.count === 1 ? 'that button' : 'those buttons'}</b></span></label>
          <label className="deck-dialog-option"><input type="radio" name="incoming" checked={moveDialog.incoming !== 'remove'} onChange={() => setMoveDialog({ ...moveDialog, incoming: moveDialog.decisions.incoming.targets[0]?.id ?? 'remove' })} /><span><b>Point {moveDialog.decisions.incoming.count === 1 ? 'it' : 'them'} at another page</b></span></label>
          {moveDialog.incoming !== 'remove' ? <DeckSelect value={moveDialog.incoming} options={moveDialog.decisions.incoming.targets.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setMoveDialog({ ...moveDialog, incoming: value })} /> : null}
        </div> : null}
        {moveDialog.decisions.outgoing.count > 0 ? <div className="deck-dialog-warning" role="note"><strong>{moveDialog.decisions.outgoing.count} button{moveDialog.decisions.outgoing.count === 1 ? '' : 's'}</strong> on this page switch to a page that stays behind.
          <label className="deck-dialog-option"><input type="radio" name="outgoing" checked={moveDialog.outgoing === 'remove'} onChange={() => setMoveDialog({ ...moveDialog, outgoing: 'remove' })} /><span><b>Remove {moveDialog.decisions.outgoing.count === 1 ? 'it' : 'them'}</b></span></label>
          <label className="deck-dialog-option"><input type="radio" name="outgoing" checked={moveDialog.outgoing !== 'remove'} onChange={() => setMoveDialog({ ...moveDialog, outgoing: moveDialog.decisions.outgoing.targets[0]?.id ?? 'remove' })} /><span><b>Point {moveDialog.decisions.outgoing.count === 1 ? 'it' : 'them'} at a page in {moveDialog.toName}</b></span></label>
          {moveDialog.outgoing !== 'remove' ? <DeckSelect value={moveDialog.outgoing} options={moveDialog.decisions.outgoing.targets.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setMoveDialog({ ...moveDialog, outgoing: value })} /> : null}
        </div> : null}
        <div className="deck-dialog-foot"><button type="button" className="secondary-button" onClick={() => setMoveDialog(null)}>Cancel</button><button type="button" className="primary-button" onClick={() => performPageMove(moveDialog.request, { incoming: moveDialog.incoming === 'remove' ? 'remove' : { redirectTo: moveDialog.incoming }, outgoing: moveDialog.outgoing === 'remove' ? 'remove' : { redirectTo: moveDialog.outgoing } })}>{moveDialog.request.copy ? 'Copy page' : 'Move page'}</button></div>
      </div>
    </div> : null}
    <div className="sr-only" role="status" aria-live="polite">{announce}</div>
    {dragGhost ? <div className="deck-drag-ghost" data-ok={dragGhost.ok} style={{ left: dragGhost.x + 14, top: dragGhost.y + 14 }}>{dragGhost.label}</div> : null}
    {appPicker ? <AppPicker isMacos={isMacos} onClose={() => setAppPicker(null)} onPick={(path, name, icon) => { if (appPicker === 'add') { setAppPicker(null); finishAddRef.current?.({ label: name, action: { type: 'launch_app', app: path } }, addAt.current.at, addAt.current.folderId, { kind: 'app', target: path, prefetched: icon }); } else { setAppPicker(null); addAutoSwitchApp(path); } }} /> : null}
    {undo ? <div className="deck-toast" role="status"><span>{undo.message}</span><button type="button" onClick={undoLast}>Undo</button><button type="button" aria-label="Dismiss" onClick={() => setUndo(null)}>✕</button></div> : null}
  </div>;
}

function PluginWidgetProperties({ widget, definition, busy, onChange }: {
  widget: Extract<DeckWidget, { type: 'plugin' }>;
  definition: OpenDockPluginWidget | null;
  busy: boolean;
  onChange: (inputId: string, value: string) => void;
}) {
  if (!definition) return <PanelSection title="Plugin"><p className="panel-note">The plugin or widget definition is not installed. Its saved preview can still be shown on the phone.</p></PanelSection>;
  return <PanelSection title="Options">
    {definition.description ? <p className="panel-note">{definition.description}</p> : null}
    {definition.inputs.map((input) => {
      const value = widget.values[input.id] ?? input.default;
      return <label key={input.id}>{input.label}{input.type === 'select'
        ? <DeckSelect value={value} disabled={busy} options={input.options.map((option, index) => ({ value: option, label: input.optionLabels?.[index] || option }))} onChange={(next) => onChange(input.id, next)} />
        : <input type={input.type === 'number' ? 'number' : 'text'} value={value} disabled={busy} onChange={(event) => onChange(input.id, event.target.value)} />}</label>;
    })}
  </PanelSection>;
}

function buttonSummary(button: DeckButton, page: DeckPage): string {
  const action = button.action;
  if (action.type === 'open_folder') {
    const entry = page.folders.find((item) => item.id === action.folderId);
    const count = (entry?.buttons.length ?? 0) + (entry?.widgets.length ?? 0);
    return `Folder · ${count} item${count === 1 ? '' : 's'}`;
  }
  return ({ media: 'Media control', hotkey: 'Keyboard shortcut', launch_app: 'Opens an app on this PC', launch_file: 'Opens a file on this PC', launch_folder: 'Opens a folder on this PC', run_script: 'Runs a script on this PC', plugin_action: 'Plugin action', sequence: 'Runs steps in order', select_profile: 'Switches profile', select_page: 'Switches page', system: 'System & power' } as Record<string, string>)[action.type] ?? 'Button';
}

function buttonLabel(button: DeckButton, playback: PlaybackState) {
  return button.action.type === 'media' && button.action.command === 'play_pause' && button.icon === 'auto'
    ? playback === 'playing' ? 'Pause' : 'Play'
    : button.label;
}

function iconForButton(button: DeckButton, playback: PlaybackState, theme: 'light' | 'dark') {
  if (button.appIconData) return <img className="deck-button-app-icon" src={button.appIconData} alt="" />;
  if (button.iconSvg && button.icon !== 'auto') return <img className="deck-button-svg-icon" src={`data:image/svg+xml,${encodeURIComponent(inkIcon(button.iconSvg, theme))}`} alt="" />;
  const aliases: Record<string, typeof Command> = { command: Command, monitor: Monitor, music: Music, mic: Mic, headphones: Headphones, 'app-window': AppWindow };
  const Icon = button.icon === 'auto' ? autoIcon(button.action, playback) : aliases[button.icon] ?? Command;
  return <Icon size={18} />;
}

function autoIcon(action: DeckAction, playback: PlaybackState) {
  if (action.type === 'media') return ({ play_pause: playback === 'playing' ? Pause : Play, next_track: SkipForward, previous_track: SkipBack, volume_up: Volume2, volume_down: Volume1, mute: VolumeX } as const)[action.command];
  if (action.type === 'launch_app') return AppWindow;
  if (action.type === 'launch_file') return File;
  if (action.type === 'launch_folder') return FolderOpen;
  if (action.type === 'plugin_action') return Package;
  if (action.type === 'run_script') return File;
  if (action.type === 'sequence') return ListOrdered;
  if (action.type === 'open_folder') return FolderClosed;
  if (action.type === 'select_profile') return Layers2;
  if (action.type === 'select_page') return PanelsTopLeft;
  if (action.type === 'system') return ({ lock: Lock, sleep: Moon, restart: RotateCcw, shutdown: Power, sign_out: LogOut, brightness_up: Sun, brightness_down: SunDim, screenshot: Camera } as const)[action.command];
  return Keyboard;
}

// The picked icon as standalone SVG markup at 24 px in the deck's light ink. The picker button has
// already drawn it, so copy that instead of rendering it again (which needed react-dom/server).
function iconMarkup(button: HTMLElement) {
  const svg = button.querySelector('svg')!.cloneNode(true) as SVGSVGElement;
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('stroke', '#f4f4f5');
  svg.setAttribute('stroke-width', '2');
  return svg.outerHTML;
}

function IconPicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (name: string, svg?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(72);
  const [registry, setRegistry] = useState<LucideRegistry | null>(null);
  const [loading, setLoading] = useState(false);
  const matches = useMemo(() => Object.keys(registry ?? {}).filter((name) => name.toLowerCase().includes(query.trim().toLowerCase())), [query, registry]);
  const visible = matches.slice(0, limit);
  const SelectedIcon = value === 'auto' ? Zap : registry?.[value as keyof LucideRegistry] ?? Command;
  async function togglePicker() {
    if (open) { setOpen(false); return; }
    if (!registry) {
      setLoading(true);
      try { const module = await import('lucide-react/dist/esm/icons/index.mjs'); setRegistry(module as unknown as LucideRegistry); }
      finally { setLoading(false); }
    }
    setOpen(true);
  }
  return <div className="icon-picker">
    <button type="button" className="icon-picker-trigger" disabled={disabled || loading} onClick={() => void togglePicker()}><SelectedIcon size={17} /><span>{loading ? 'Loading icons…' : value === 'auto' ? 'Automatic by action' : value}</span><ChevronDown size={15} /></button>
    {open ? <div className="icon-picker-popover">
      <input autoFocus value={query} placeholder={`Search ${Object.keys(registry ?? {}).length} Lucide icons…`} onChange={(event) => { setQuery(event.target.value); setLimit(72); }} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }} />
      <button type="button" className={`icon-picker-auto ${value === 'auto' ? 'selected' : ''}`} onClick={() => { onChange('auto'); setOpen(false); }}><Zap size={16} /> Automatic by action</button>
      <div className="icon-picker-grid">{visible.map((name) => {
        const Icon = registry![name as keyof LucideRegistry];
        return <button type="button" key={name} className={`icon-picker-option ${name === value ? 'selected' : ''}`} title={name} aria-label={name} onClick={(event) => { onChange(name, iconMarkup(event.currentTarget)); setOpen(false); }}><Icon size={17} /><span>{name}</span></button>;
      })}</div>
      {matches.length > visible.length ? <button type="button" className="icon-picker-more" onClick={() => setLimit((current) => current + 72)}>Show more ({matches.length - visible.length} remaining)</button> : null}
    </div> : null}
  </div>;
}

function ButtonProperties({ button, busy, isMacos, profiles, pages, plugins, onChange, onIcon }: { button: DeckButton; busy: boolean; isMacos: boolean; profiles: DeckProfile[]; pages: DeckPage[]; plugins: OpenDockPlugin[]; onChange: (patch: Partial<DeckButton>) => void; onIcon: (kind: 'app' | 'file', target: string, prefetched?: string | null) => void }) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const action = button.action;
  const kind = action.type === 'plugin_action' ? `plugin:${action.pluginId}:${action.actionId}` : action.type === 'sequence' ? 'sequence' : action.type;
  const keys = action.type === 'hotkey' ? action.keys.join('+') : '';
  const app = action.type === 'launch_app' ? action.app : '';
  const filePath = action.type === 'launch_file' ? action.path : '';
  const folderPath = action.type === 'launch_folder' ? action.path : '';
  const scriptPath = action.type === 'run_script' ? action.path : '';
  const media = action.type === 'media' ? action.command : 'play_pause';
  const pluginAction = action.type === 'plugin_action' ? plugins.find((plugin) => plugin.id === action.pluginId)?.actions.find((item) => item.id === action.actionId) : undefined;
  const [iconError, setIconError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [extractingIcon, setExtractingIcon] = useState(false);
  const [extractingThumbnail, setExtractingThumbnail] = useState(false);
  const thumbnailRequestRef = useRef(0);
  const iconTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(iconTimer.current), []);
  // A new target gets its own icon, unless the button has an icon the user chose.
  function setAppTarget(app: string, prefetched?: string | null) {
    if (action.type !== 'launch_app') return;
    const ownsIcon = button.icon === 'auto' || button.icon === 'app-icon';
    onChange({ action: { ...action, app }, ...(button.icon === 'app-icon' ? { icon: 'auto', iconSvg: undefined } : {}), appIconData: ownsIcon ? undefined : button.appIconData });
    setIconError('');
    window.clearTimeout(iconTimer.current);
    if (ownsIcon && app.trim()) iconTimer.current = window.setTimeout(() => onIcon('app', app, prefetched), prefetched ? 0 : 600);
  }
  async function extractIcon(useShortcutIcon: boolean) {
    setExtractingIcon(true);
    setIconError('');
    try {
      const data = await invoke<string>('extract_app_icon', { app, useShortcutIcon });
      onChange({ icon: 'app-icon', iconSvg: undefined, appIconData: data });
    } catch (error) {
      setIconError(String(error));
    } finally {
      setExtractingIcon(false);
    }
  }
  function browseApp() {
    setPickerOpen(true);
  }
  async function browseScript() {
    try {
      const path = await openFileDialog({
        title: 'Choose a local script', multiple: false, directory: false,
        filters: [isMacos ? { name: 'Scripts', extensions: ['sh', 'py'] } : { name: 'Scripts', extensions: ['ps1', 'py'] }],
      });
      if (typeof path === 'string') onChange({ action: { type: 'run_script', path, allowOnPc: action.type === 'run_script' && action.allowOnPc } });
    } catch (error) { setIconError(`Could not open the script picker: ${String(error)}`); }
  }
  function setFileTarget(path: string) {
    if (action.type !== 'launch_file') return;
    thumbnailRequestRef.current += 1;
    setExtractingThumbnail(false);
    onChange({ action: { ...action, path }, ...(button.icon === 'app-icon' ? { icon: 'auto', iconSvg: undefined } : {}), appIconData: undefined });
    setIconError('');
  }
  function setFolderTarget(path: string) {
    if (action.type !== 'launch_folder') return;
    thumbnailRequestRef.current += 1;
    setExtractingThumbnail(false);
    onChange({ action: { ...action, path }, ...(button.icon === 'app-icon' ? { icon: 'auto', iconSvg: undefined } : {}), appIconData: undefined });
    setIconError('');
  }
  async function extractFileThumbnail(path: string) {
    if (!path.trim()) return;
    const request = ++thumbnailRequestRef.current;
    setExtractingThumbnail(true);
    setIconError('');
    try {
      const data = await invoke<string>('extract_file_thumbnail', { path });
      if (request === thumbnailRequestRef.current) onChangeRef.current({ icon: 'app-icon', iconSvg: undefined, appIconData: data });
    } catch (error) {
      if (request === thumbnailRequestRef.current) setIconError(String(error));
    } finally {
      if (request === thumbnailRequestRef.current) setExtractingThumbnail(false);
    }
  }
  async function browseFileOrFolder(directory: boolean) {
    try {
      const path = await openFileDialog({ title: directory ? 'Choose a folder' : 'Choose a file', multiple: false, directory });
      if (typeof path === 'string') {
        if (directory) setFolderTarget(path);
        else setFileTarget(path);
        void extractFileThumbnail(path);
      }
    } catch (error) {
      setIconError(`Could not open the picker: ${String(error)}`);
    }
  }
  const isWindowsShortcut = !isMacos && app.toLowerCase().endsWith('.lnk');
  const actionOptions = [['media', 'Media'], ['hotkey', 'Keyboard shortcut'], ['launch_app', 'Launch app'], ['launch_file', 'Launch file'], ['launch_folder', 'Launch folder'], ['run_script', 'Run local script'], ['sequence', 'Sequence'], ['select_profile', 'Select profile'], ['select_page', 'Select page'], ['system', 'System & power']].map(([value, label]) => ({ value, label }));
  actionOptions.push(...plugins.flatMap((plugin) => plugin.actions.map((pluginAction) => ({ value: `plugin:${plugin.id}:${pluginAction.id}`, label: `${plugin.name} / ${pluginAction.name}` }))));
  const setKind = (value: string) => {
    thumbnailRequestRef.current += 1;
    setExtractingThumbnail(false);
    const pluginTarget = value.startsWith('plugin:') ? value.slice(7).split(':') : [];
    const selectedPluginAction = pluginTarget.length === 2 ? plugins.find((plugin) => plugin.id === pluginTarget[0])?.actions.find((item) => item.id === pluginTarget[1]) : undefined;
    const next: DeckAction = pluginTarget.length === 2 ? { type: 'plugin_action', pluginId: pluginTarget[0], actionId: pluginTarget[1], allowOnPc: false, inputs: Object.fromEntries((selectedPluginAction?.inputs ?? []).map((input) => [input.id, input.default || (input.type === 'select' ? input.options[0] ?? '' : '')])) } : value === 'media' ? { type: 'media', command: 'play_pause' } : value === 'launch_app' ? { type: 'launch_app', app: '' } : value === 'launch_file' ? { type: 'launch_file', path: '' } : value === 'launch_folder' ? { type: 'launch_folder', path: '' } : value === 'run_script' ? { type: 'run_script', path: '', allowOnPc: false } : value === 'sequence' ? { type: 'sequence', steps: [{ type: 'hotkey', keys: ['CTRL', 'SHIFT', 'M'] }, { type: 'hotkey', keys: ['CTRL', 'S'] }] } : value === 'select_profile' ? { type: 'select_profile', profileId: profiles[0]?.id ?? '' } : value === 'select_page' ? { type: 'select_page', pageId: pages[0]?.id ?? '' } : value === 'system' ? { type: 'system', command: 'screenshot' } : { type: 'hotkey', keys: ['CTRL', 'SHIFT', 'M'] };
    onChange({ action: next, ...(value === 'launch_app' ? {} : { icon: 'auto', iconSvg: undefined, appIconData: undefined }) });
  };
  return <>
    {pickerOpen ? <AppPicker isMacos={isMacos} onClose={() => setPickerOpen(false)} onPick={(path, _name, icon) => { setPickerOpen(false); setAppTarget(path, icon); }} /> : null}
    <PanelSection title="Action">
      <label>Action<DeckSelect value={kind} onChange={setKind} disabled={busy} options={actionOptions} /></label>
      {action.type === 'plugin_action' ? <><label className="plugin-action-info">Plugin action<span>{pluginAction?.description || 'Runs the local script defined by this Open Dock plugin.'}</span></label>{pluginAction?.inputs.map((input) => <label key={input.id}>{input.label}{input.type === 'select' ? <DeckSelect value={action.inputs?.[input.id] ?? input.default ?? input.options[0] ?? ''} disabled={busy} options={input.options.map((option, index) => ({ value: option, label: input.optionLabels?.[index] || option }))} onChange={(value) => onChange({ action: { ...action, inputs: { ...action.inputs, [input.id]: value } } })} /> : <input type={input.type} value={action.inputs?.[input.id] ?? input.default} onChange={(event) => onChange({ action: { ...action, inputs: { ...action.inputs, [input.id]: event.target.value } } })} disabled={busy} maxLength={512} />}</label>)}<label className="script-permission"><input type="checkbox" checked={action.allowOnPc} disabled={busy} onChange={(event) => onChange({ action: { ...action, allowOnPc: event.target.checked } })} /><span>Allow this plugin action to run on this PC from a paired phone</span></label></> : null}
      {kind === 'run_script' && action.type === 'run_script' ? <><label>Local script<div className="app-path-picker"><input value={scriptPath} onChange={(event) => onChange({ action: { ...action, path: event.target.value } })} placeholder={isMacos ? 'Choose a .sh or .py script' : 'Choose a .ps1 or .py script'} disabled={busy} /><button type="button" className="app-browse-button" aria-label="Browse for a local script" title="Browse for a local script" disabled={busy} onClick={() => void browseScript()}><File size={15} /></button></div></label><label className="script-permission"><input type="checkbox" checked={action.allowOnPc} disabled={busy || !scriptPath.trim()} onChange={(event) => onChange({ action: { ...action, allowOnPc: event.target.checked } })} /><span>Allow this script to run on this PC when activated from a paired phone</span></label><small>Scripts run as your Windows or macOS user. Open Dock follows the operating system’s script policy.</small>{iconError ? <small className="form-error">{iconError}</small> : null}</> : null}
      {kind === 'media' ? <label>Media command<DeckSelect value={media} onChange={(value) => onChange({ action: { type: 'media', command: value as MediaCommand } })} disabled={busy} options={[['play_pause', 'Play / Pause'], ['next_track', 'Next track'], ['previous_track', 'Previous track'], ['volume_up', 'Volume up'], ['volume_down', 'Volume down'], ['mute', 'Mute']].map(([value, label]) => ({ value, label }))} /></label> : null}
      {kind === 'system' && action.type === 'system' ? <><label>Command<DeckSelect value={action.command} onChange={(value) => onChange({ action: { type: 'system', command: value as SystemCommand } })} disabled={busy} options={SYSTEM_COMMANDS.map(([value, label]) => ({ value, label }))} /></label>{action.command === 'screenshot' ? <small>Saves the main monitor as a PNG in Pictures/Open Dock.</small> : action.command.startsWith('brightness') ? <small>Works on built-in laptop screens.</small> : ['restart', 'shutdown', 'sign_out'].includes(action.command) ? <small>Runs at once, without asking. Open apps may lose unsaved work.</small> : null}</> : null}
      {kind === 'hotkey' ? <label>Keys<input value={keys} onChange={(event) => onChange({ action: { type: 'hotkey', keys: event.target.value.toUpperCase().split('+').map((key) => key.trim()).filter(Boolean) } })} placeholder="CTRL+SHIFT+M" disabled={busy} /></label> : null}
      {kind === 'launch_app' && action.type === 'launch_app' ? <><label>App path or name<div className="app-path-picker"><input value={app} onChange={(event) => setAppTarget(event.target.value)} placeholder="Application, shortcut, or app name" disabled={busy} /><button type="button" className="app-browse-button" aria-label="Browse for an application" title="Browse for an application" disabled={busy} onClick={() => void browseApp()}><FolderOpen size={15} /></button></div></label></> : null}
      {kind === 'launch_file' && action.type === 'launch_file' ? <><label>File path<div className="app-path-picker"><input value={filePath} onChange={(event) => setFileTarget(event.target.value)} placeholder="Choose a file" disabled={busy} /><button type="button" className="app-browse-button" aria-label="Browse for a file" title="Browse for a file" disabled={busy} onClick={() => void browseFileOrFolder(false)}><File size={15} /></button></div></label></> : null}
      {kind === 'launch_folder' && action.type === 'launch_folder' ? <><label>Folder path<div className="app-path-picker"><input value={folderPath} onChange={(event) => setFolderTarget(event.target.value)} placeholder="Choose a folder" disabled={busy} /><button type="button" className="app-browse-button" aria-label="Browse for a folder" title="Browse for a folder" disabled={busy} onClick={() => void browseFileOrFolder(true)}><FolderOpen size={15} /></button></div></label></> : null}
      {kind === 'sequence' && action.type === 'sequence' ? <SequenceEditor steps={action.steps} disabled={busy} isMacos={isMacos} onChange={(steps) => onChange({ action: { type: 'sequence', steps } })} /> : null}
      {kind === 'select_profile' && action.type === 'select_profile' ? <label>Profile<DeckSelect value={action.profileId} options={profiles.map((item) => ({ value: item.id, label: item.name }))} onChange={(profileId) => onChange({ action: { type: 'select_profile', profileId } })} disabled={busy} /></label> : null}
      {kind === 'select_page' && action.type === 'select_page' ? <label>Page<DeckSelect value={action.pageId} options={pages.map((item) => ({ value: item.id, label: item.name }))} onChange={(pageId) => onChange({ action: { type: 'select_page', pageId } })} disabled={busy} /></label> : null}
    </PanelSection>
    <PanelSection title="Appearance">
      <label>Button label<input value={button.label} onChange={(event) => onChange({ label: event.target.value })} maxLength={24} disabled={busy} /></label>
      <label>Icon<IconPicker value={button.icon} disabled={busy} onChange={(name, svg) => { thumbnailRequestRef.current += 1; setExtractingThumbnail(false); onChange({ icon: name, iconSvg: svg, appIconData: undefined }); }} /></label>
      {kind === 'launch_app' && action.type === 'launch_app' ? <><button type="button" className="secondary-button app-icon-button" disabled={busy || extractingIcon || !app.trim()} onClick={() => void extractIcon(true)}>{extractingIcon ? 'Reading icon…' : button.appIconData && button.icon === 'app-icon' ? isWindowsShortcut ? 'Refresh shortcut icon' : 'Refresh app icon' : isWindowsShortcut ? 'Use shortcut icon' : 'Use app icon'}</button>{isWindowsShortcut && button.appIconData ? <button type="button" className="secondary-button app-icon-button" disabled={busy || extractingIcon} onClick={() => void extractIcon(false)}>Reset to app icon</button> : null}{iconError ? <small className="form-error">{iconError}</small> : null}</> : null}
      {kind === 'launch_file' && action.type === 'launch_file' ? <><button type="button" className="secondary-button app-icon-button" disabled={busy || extractingThumbnail || !filePath.trim()} onClick={() => void extractFileThumbnail(filePath)}>{extractingThumbnail ? 'Reading thumbnail…' : button.appIconData ? 'Refresh thumbnail' : 'Use file thumbnail'}</button>{iconError ? <small className="form-error">{iconError}</small> : null}</> : null}
      {kind === 'launch_folder' && action.type === 'launch_folder' ? <><button type="button" className="secondary-button app-icon-button" disabled={busy || extractingThumbnail || !folderPath.trim()} onClick={() => void extractFileThumbnail(folderPath)}>{extractingThumbnail ? 'Reading icon…' : button.appIconData ? 'Refresh folder icon' : 'Use folder icon'}</button>{iconError ? <small className="form-error">{iconError}</small> : null}</> : null}
    </PanelSection>
  </>;
}

function SequenceEditor({ steps, disabled, isMacos, onChange }: { steps: DeckStep[]; disabled: boolean; isMacos: boolean; onChange: (steps: DeckStep[]) => void }) {
  const [draft, setDraft] = useState(steps);
  const [error, setError] = useState('');
  useEffect(() => { setDraft(steps); setError(''); }, [steps]);

  function commit(next: DeckStep[]) {
    if (next.length < 1 || next.length > 10) return;
    setDraft(next);
    setError('');
    onChange(next);
  }

  function changeStep(index: number, step: DeckStep) {
    const next = [...draft];
    next[index] = step;
    commit(next);
  }

  function moveStep(index: number, offset: number) {
    const destination = index + offset;
    if (destination < 0 || destination >= draft.length) return;
    const next = [...draft];
    [next[index], next[destination]] = [next[destination], next[index]];
    commit(next);
  }

  async function browseApp(index: number) {
    try {
      const path = await openFileDialog({
        title: 'Choose an application for this step',
        multiple: false,
        directory: false,
        filters: [isMacos ? { name: 'Applications', extensions: ['app'] } : { name: 'Applications and shortcuts', extensions: ['exe', 'lnk'] }],
      });
      if (typeof path === 'string') changeStep(index, { type: 'launch_app', app: path });
    } catch (cause) {
      setError(`Could not open the application picker: ${String(cause)}`);
    }
  }

  async function browseFileOrFolder(index: number, directory: boolean) {
    try {
      const path = await openFileDialog({ title: directory ? 'Choose a folder for this step' : 'Choose a file for this step', multiple: false, directory });
      if (typeof path === 'string') changeStep(index, directory ? { type: 'launch_folder', path } : { type: 'launch_file', path });
    } catch (cause) {
      setError(`Could not open the picker: ${String(cause)}`);
    }
  }

  return <div className="sequence-editor">
    <div className="sequence-heading"><strong>Sequence steps</strong><span>Runs in order on this PC · {draft.length}/10</span></div>
    {draft.map((step, index) => <section className="sequence-step" key={index} aria-label={`Sequence step ${index + 1}`}>
      <div className="sequence-step-heading">
        <span className="sequence-step-number">{index + 1}</span>
        <div className="sequence-step-type"><DeckSelect value={step.type} disabled={disabled} options={[['hotkey', 'Keyboard shortcut'], ['media', 'Media command'], ['launch_app', 'Launch app'], ['launch_file', 'Launch file'], ['launch_folder', 'Launch folder']].map(([value, label]) => ({ value, label }))} onChange={(value) => changeStep(index, value === 'media' ? { type: 'media', command: 'play_pause' } : value === 'launch_app' ? { type: 'launch_app', app: '' } : value === 'launch_file' ? { type: 'launch_file', path: '' } : value === 'launch_folder' ? { type: 'launch_folder', path: '' } : { type: 'hotkey', keys: ['CTRL', 'SHIFT', 'M'] })} /></div>
        <button type="button" className="sequence-order-button" aria-label={`Move step ${index + 1} up`} title="Move up" disabled={disabled || index === 0} onClick={() => moveStep(index, -1)}><ChevronUp size={14} /></button>
        <button type="button" className="sequence-order-button" aria-label={`Move step ${index + 1} down`} title="Move down" disabled={disabled || index === draft.length - 1} onClick={() => moveStep(index, 1)}><ChevronDown size={14} /></button>
        <button type="button" className="sequence-order-button sequence-remove-button" aria-label={`Remove step ${index + 1}`} title="Remove step" disabled={disabled || draft.length === 1} onClick={() => commit(draft.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={14} /></button>
      </div>
      {step.type === 'hotkey' ? <label>Shortcut<input value={step.keys.join('+')} disabled={disabled} placeholder="CTRL+SHIFT+M" onChange={(event) => {
        const next = [...draft];
        next[index] = { type: 'hotkey', keys: event.target.value.toUpperCase().split('+').map((key) => key.trim()) };
        setDraft(next);
      }} onBlur={() => {
        const keys = parseShortcut(step.keys.join('+'));
        if (!keys) setError(`Step ${index + 1}: enter a valid shortcut such as CTRL+SHIFT+M.`);
        else changeStep(index, { type: 'hotkey', keys });
      }} /></label> : null}
      {step.type === 'media' ? <label>Command<DeckSelect value={step.command} disabled={disabled} options={[
        ['play_pause', 'Play / Pause'], ['next_track', 'Next track'], ['previous_track', 'Previous track'], ['volume_up', 'Volume up'], ['volume_down', 'Volume down'], ['mute', 'Mute'],
      ].map(([value, label]) => ({ value, label }))} onChange={(value) => changeStep(index, { type: 'media', command: value as MediaCommand })} /></label> : null}
      {step.type === 'launch_app' ? <label>Application<div className="app-path-picker"><input value={step.app} disabled={disabled} placeholder="Application path or name" onChange={(event) => {
        const next = [...draft];
        next[index] = { type: 'launch_app', app: event.target.value };
        setDraft(next);
      }} onBlur={() => changeStep(index, step)} /><button type="button" className="app-browse-button" aria-label={`Browse for application in step ${index + 1}`} title="Browse for an application" disabled={disabled} onClick={() => void browseApp(index)}><FolderOpen size={15} /></button></div></label> : null}
      {step.type === 'launch_file' || step.type === 'launch_folder' ? <label>{step.type === 'launch_file' ? 'File' : 'Folder'}<div className="app-path-picker"><input value={step.path} disabled={disabled} placeholder={`${step.type === 'launch_file' ? 'File' : 'Folder'} path`} onChange={(event) => {
        const next = [...draft];
        next[index] = { type: step.type, path: event.target.value };
        setDraft(next);
      }} onBlur={() => changeStep(index, step)} /><button type="button" className="app-browse-button" aria-label={`Browse for ${step.type === 'launch_file' ? 'file' : 'folder'} in step ${index + 1}`} title={`Browse for a ${step.type === 'launch_file' ? 'file' : 'folder'}`} disabled={disabled} onClick={() => void browseFileOrFolder(index, step.type === 'launch_folder')}>{step.type === 'launch_file' ? <File size={15} /> : <FolderOpen size={15} />}</button></div></label> : null}
    </section>)}
    {draft.length < 10 ? <button type="button" className="secondary-button sequence-add-button" disabled={disabled} onClick={() => commit([...draft, { type: 'hotkey', keys: ['CTRL', 'SHIFT', 'M'] }])}><Plus size={14} /> Add step</button> : null}
    {error ? <small className="form-error">{error}</small> : null}
  </div>;
}

function parseShortcut(value: string): string[] | null {
  if (!value.trim()) return null;
  const modifiers = new Set(['CTRL', 'ALT', 'SHIFT', 'META']);
  const special = new Set(['SPACE', 'ENTER', 'TAB', 'ESCAPE', 'BACKSPACE', 'DELETE', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN', 'UP', 'DOWN', 'LEFT', 'RIGHT']);
  const keys = value.toUpperCase().replace(/ /g, '').split('+');
  if (keys.length < 2 || keys.length > 5 || keys.some((key) => !key) || keys.slice(0, -1).some((key) => !modifiers.has(key)) || new Set(keys.slice(0, -1)).size !== keys.length - 1) return null;
  const last = keys[keys.length - 1];
  if (!/^[A-Z0-9]$/.test(last) && !special.has(last) && !/^F([1-9]|1[0-2])$/.test(last)) return null;
  return keys;
}

export default App;

/** Starts Open Dock when you sign in to Windows, waiting in the tray so the phone connects without opening anything. */
function StartWithWindowsSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void invoke<boolean>('get_autostart').then(setEnabled).catch(() => setEnabled(false)); }, []);
  const toggle = async () => {
    const next = !enabled;
    setError('');
    try {
      await invoke('set_autostart', { enabled: next });
      setEnabled(next);
    } catch (failure) {
      setError(String(failure));
    }
  };
  return (
    <section className="device-navigation-setting">
      <div className="device-navigation-copy"><h2>Start with Windows</h2><p>Open Dock starts in the tray when you sign in, so your phone connects as soon as the PC is on.</p></div>
      <button className={`setting-switch ${enabled ? 'enabled' : ''}`} type="button" role="switch" aria-checked={Boolean(enabled)} aria-label="Start with Windows" disabled={enabled === null} onClick={() => void toggle()}><span /></button>
      {error ? <p className="setting-error" role="alert">{error}</p> : null}
    </section>
  );
}
