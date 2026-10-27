use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc, RwLock,
};
use std::thread;
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tokio::net::TcpListener;
use tokio::sync::broadcast;

mod adb;
mod camera;
mod delta;
mod icon_png;
mod island;
mod media_players;
mod pc_stats;
#[cfg(windows)]
mod pc_voice;
mod remote;
mod system_media;
mod usb_pair;
mod voice;
#[cfg(windows)]
mod win_apps;
#[cfg(windows)]
mod win_icon;

const PORT: u16 = 39421;
const MAX_DECK_CONFIG_BYTES: usize = 1_048_576;
const MAX_PLUGIN_MANIFEST_BYTES: usize = 65_536;
const MAX_PLUGIN_SCRIPT_BYTES: u64 = 1_048_576;

struct AppState {
    host: String,
    device_name: RwLock<String>,
    token: RwLock<String>,
    config_dir: RwLock<Option<PathBuf>>,
    deck_config: RwLock<DeckConfig>,
    /// A saved deck, tagged with the device it belongs to ("" is the deck shared by every phone without its own).
    deck_updates: broadcast::Sender<(String, DeckConfig)>,
    /// Decks customised for one phone, by phone id.
    device_decks: RwLock<HashMap<String, DeckConfig>>,
    /// Phones that have connected: id to the name they gave themselves.
    known_devices: RwLock<HashMap<String, String>>,
    /// What this PC keeps about a phone besides its own name, by phone id.
    device_meta: RwLock<HashMap<String, DeviceMeta>>,
    /// Open connections per phone id.
    online_devices: std::sync::Mutex<HashMap<String, usize>>,
    media_state: tokio::sync::watch::Sender<system_media::SystemMediaState>,
    /// Wakes the media monitor right after a control (play/pause, seek, volume) so the new state
    /// reaches the phone in a few hundred ms instead of on the next 1 s poll.
    media_refresh: Arc<tokio::sync::Notify>,
    pc_stats: tokio::sync::watch::Sender<pc_stats::PcStatsHistory>,
    /// Which readings each phone connection and the desktop editor want sampled.
    pc_stats_demand: Arc<pc_stats::Demand>,
    /// Ids for phone connections in `pc_stats_demand`.
    next_connection: AtomicU64,
    independent_navigation: AtomicBool,
    navigation_updates: broadcast::Sender<bool>,
    auto_profile_updates: broadcast::Sender<String>,
    pending_legacy: RwLock<HashMap<String, LegacyPhonePageSet>>,
    legacy_offers: RwLock<HashMap<String, LegacyImportSummary>>,
    legacy_requests: broadcast::Sender<String>,
    active_devices: AtomicUsize,
    server_online: AtomicBool,
    android_usb_enabled: AtomicBool,
    /// Phones connected through the USB cable (they reach this PC from its own loopback address).
    usb_clients: AtomicUsize,
    usb_panel: RwLock<UsbPanel>,
    usb_retry: AtomicBool,
    session_epoch: AtomicUsize,
    widget_surface: RwLock<Option<WidgetSurface>>,
    pin_pairing: std::sync::Mutex<remote::PinPairing>,
}

/// The phone's widget area in px, reported so the desktop Now Playing preview sizes blocks like the phone.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetSurface {
    width: f64,
    height: f64,
    gap: f64,
    inset: f64,
    fixed_row_height: Option<f64>,
    /// The phone is held upright, so the desktop draws its deck preview tall.
    #[serde(default)]
    portrait: bool,
}

impl WidgetSurface {
    fn is_valid(&self) -> bool {
        let in_range = |value: f64, max: f64| value.is_finite() && (0.0..=max).contains(&value);
        in_range(self.width, 10_000.0)
            && self.width > 0.0
            && in_range(self.height, 10_000.0)
            && in_range(self.gap, 200.0)
            && in_range(self.inset, 200.0)
            && self
                .fixed_row_height
                .is_none_or(|height| in_range(height, 2_000.0) && height > 0.0)
    }
}

/// Keeps a process Open Dock starts from opening a console window on Windows. Every helper process goes through
/// this (scripts/check-quiet-processes.ts fails the build when one does not); elsewhere it does nothing.
fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PlaybackState {
    Playing,
    Paused,
    Stopped,
    Unavailable,
}

/// What the USB tab shows: `status` is one of off, no_adb, no_phone, unauthorized, error, pairing, connected, idle, failed.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsbPanel {
    status: String,
    phone: String,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    host: String,
    device_name: String,
    port: u16,
    token: String,
    active_devices: usize,
    server_online: bool,
    is_macos: bool,
    android_usb_enabled: bool,
    android_usb: UsbPanel,
    widget_surface: Option<WidgetSurface>,
    pin: String,
}

#[cfg(target_os = "macos")]
const IS_MACOS: bool = true;
#[cfg(not(target_os = "macos"))]
const IS_MACOS: bool = false;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckConfig {
    schema_version: u32,
    revision: u64,
    profiles: Vec<DeckProfile>,
    active_profile_id: String,
    #[serde(default, rename = "autoSwitchEnabled", skip_serializing)]
    legacy_auto_switch_enabled: bool,
    #[serde(default)]
    fallback_profile_id: String,
    /// What the last automatic conversion changed (e.g. widget areas becoming pages). The Deck page shows
    /// it once; saving a config with it cleared dismisses it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    migration_notes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckProfile {
    id: String,
    name: String,
    pages: Vec<DeckPage>,
    active_page_id: String,
    #[serde(default)]
    auto_switch_apps: Vec<String>,
    #[serde(default)]
    auto_switch_enabled: bool,
    /// The page this profile opens on when Open Dock starts. Empty means the first page.
    #[serde(default)]
    default_page_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    widget_screen: Option<DeckWidgetScreen>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckWidgetScreen {
    enabled: bool,
    rows: u8,
    columns: u8,
    buttons: Vec<DeckButton>,
    widgets: Vec<DeckWidget>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckWidgetArea {
    enabled: bool,
    rows: u8,
    columns: u8,
    #[serde(default)]
    pages: Vec<DeckWidgetPage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckWidgetPage {
    id: String,
    name: String,
    #[serde(default)]
    buttons: Vec<DeckButton>,
    #[serde(default)]
    widgets: Vec<DeckWidget>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckWidget {
    id: String,
    #[serde(rename = "type")]
    kind: DeckWidgetType,
    placement: DeckPlacement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    widget_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    render_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    values: Option<HashMap<String, String>>,
    /// Clock face id (one of CLOCK_FACES; missing means Digital) or PC stats style id (one of PC_STATS_STYLES).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    face: Option<String>,
    /// Clock face or PC stats colour as #rrggbb.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    /// PC stats reading; one of PC_STATS_METRICS. Missing means CPU load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metric: Option<String>,
    /// GPU a PC stats widget follows: an id from pc_stats (e.g. "10de-1f15-14421025-0"). Missing means automatic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gpu: Option<String>,
}

/// Face ids defined in pc-companion/src/clock-faces/clock-faces.js (scripts/check-clock-faces.ts keeps them in sync).
const CLOCK_FACES: &[&str] = &[
    "digital", "analog", "flip", "glow", "word", "poster", "nixie", "led", "crt", "pong", "slots", "tape", "tide", "sky",
    "aurora", "lava", "sand", "pendulum", "orbit", "clockclock", "ferro", "swarm", "rings", "radar", "fibonacci", "strips",
];

/// Style and reading ids defined in pc-companion/src/pc-stats/pc-stats.js (scripts/check-pc-stats.ts keeps them in sync).
const PC_STATS_STYLES: &[&str] = &[
    "ring", "number", "fill", "dial", "spark", "segments", "area", "pair", "graph", "gauge", "columns", "heat", "strip",
    "overview", "monitor", "cores",
];
const PC_STATS_METRICS: &[&str] = &["cpu", "cputemp", "gpu", "gputemp", "ram", "vram", "disk", "diskio", "net", "power"];

fn valid_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DeckWidgetType {
    Clock,
    NowPlaying,
    Lyrics,
    PcStats,
    Plugin,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckPage {
    id: String,
    name: String,
    #[serde(default)]
    rows: u8,
    #[serde(default)]
    columns: u8,
    buttons: Vec<DeckButton>,
    /// Widgets share the page grid with the buttons.
    #[serde(default)]
    widgets: Vec<DeckWidget>,
    #[serde(default)]
    folders: Vec<DeckFolder>,
    /// Legacy: converted into pages by `normalize_deck_layout` and never written back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    widget_area: Option<DeckWidgetArea>,
}

/// A grid opened by an `open_folder` button on its page. One level deep: folders hold no folder buttons.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckFolder {
    id: String,
    name: String,
    rows: u8,
    columns: u8,
    #[serde(default)]
    buttons: Vec<DeckButton>,
    #[serde(default)]
    widgets: Vec<DeckWidget>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckButton {
    id: String,
    label: String,
    icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    placement: Option<DeckPlacement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_svg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    app_icon_data: Option<String>,
    action: DeckAction,
    /// What a long press on the phone does instead of `action`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    long_press: Option<DeckAction>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenDockPluginManifest {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    widgets: Vec<OpenDockPluginWidget>,
    actions: Vec<OpenDockPluginAction>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenDockPluginWidget {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    inputs: Vec<OpenDockPluginInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenDockPluginAction {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    script: String,
    #[serde(default)]
    inputs: Vec<OpenDockPluginInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenDockPluginInput {
    id: String,
    label: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    default: String,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    option_labels: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledOpenDockPlugin {
    id: String,
    name: String,
    version: String,
    description: String,
    actions: Vec<OpenDockPluginAction>,
    widgets: Vec<OpenDockPluginWidget>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenDockPluginListing {
    plugins: Vec<InstalledOpenDockPlugin>,
    warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckPlacement {
    row: u8,
    column: u8,
    row_span: u8,
    column_span: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
// The clients (desktop UI and phone) write camelCase fields; the snake_case spellings are still read.
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum DeckAction {
    Media {
        command: MediaCommand,
    },
    Hotkey {
        keys: Vec<String>,
    },
    LaunchApp {
        app: String,
    },
    LaunchFile {
        path: String,
    },
    LaunchFolder {
        path: String,
    },
    RunScript {
        path: String,
        #[serde(alias = "allow_on_pc")]
        allow_on_pc: bool,
    },
    PluginAction {
        #[serde(alias = "plugin_id")]
        plugin_id: String,
        #[serde(alias = "action_id")]
        action_id: String,
        #[serde(alias = "allow_on_pc")]
        allow_on_pc: bool,
        #[serde(default)]
        inputs: HashMap<String, String>,
    },
    Sequence {
        steps: Vec<DeckStep>,
    },
    SelectProfile {
        #[serde(alias = "profile_id")]
        profile_id: String,
    },
    SelectPage {
        #[serde(alias = "page_id")]
        page_id: String,
    },
    OpenFolder {
        #[serde(alias = "folder_id")]
        folder_id: String,
    },
    /// Power, brightness and screenshots.
    System {
        command: remote::SystemCommand,
    },
    /// Types a text snippet into whatever has focus on the PC.
    TypeText {
        text: String,
    },
    /// Opens a web page in the default browser.
    OpenUrl {
        url: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DeckStep {
    Media { command: MediaCommand },
    Hotkey { keys: Vec<String> },
    LaunchApp { app: String },
    LaunchFile { path: String },
    LaunchFolder { path: String },
    TypeText { text: String },
    OpenUrl { url: String },
    Delay { ms: u32 },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPhonePageSet {
    source_id: String,
    pages: Vec<LegacyPhonePage>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPhonePage {
    name: String,
    #[serde(default)]
    shortcuts: Vec<LegacyPhoneShortcut>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPhoneShortcut {
    label: String,
    #[serde(default)]
    icon: Option<String>,
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    keys: Option<Vec<String>>,
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    steps: Option<Vec<Vec<String>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyImportSummary {
    source_id: String,
    pages: usize,
    buttons: usize,
    requested: bool,
    ready: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum MediaCommand {
    PlayPause,
    NextTrack,
    PreviousTrack,
    VolumeUp,
    VolumeDown,
    Mute,
}

fn default_deck_config() -> DeckConfig {
    let buttons = [
        (
            "play-pause",
            "Play / Pause",
            "auto",
            MediaCommand::PlayPause,
        ),
        ("next-track", "Next track", "auto", MediaCommand::NextTrack),
        (
            "previous-track",
            "Previous track",
            "auto",
            MediaCommand::PreviousTrack,
        ),
        ("volume-up", "Volume up", "auto", MediaCommand::VolumeUp),
        (
            "volume-down",
            "Volume down",
            "auto",
            MediaCommand::VolumeDown,
        ),
        ("mute", "Mute", "auto", MediaCommand::Mute),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (id, label, icon, command))| DeckButton {
        id: id.to_owned(),
        label: label.to_owned(),
        icon: icon.to_owned(),
        placement: Some(DeckPlacement {
            row: (index / 3) as u8,
            column: (index % 3) as u8,
            row_span: 1,
            column_span: 1,
        }),
        icon_svg: None,
        app_icon_data: None,
        action: DeckAction::Media { command },
        long_press: None,
    })
    .collect();
    DeckConfig {
        schema_version: 1,
        revision: 1,
        profiles: vec![DeckProfile {
            id: "default".to_owned(),
            name: "Default".to_owned(),
            pages: vec![DeckPage {
                id: "main".to_owned(),
                name: "Main".to_owned(),
                rows: 2,
                columns: 3,
                buttons,
                widgets: Vec::new(),
                folders: Vec::new(),
                widget_area: None,
            }],
            active_page_id: "main".to_owned(),
            auto_switch_apps: Vec::new(),
            auto_switch_enabled: false,
            default_page_id: "main".to_owned(),
            widget_screen: None,
        }],
        active_profile_id: "default".to_owned(),
        legacy_auto_switch_enabled: false,
        fallback_profile_id: "default".to_owned(),
        migration_notes: Vec::new(),
    }
}

fn validate_deck_config(config: &DeckConfig) -> Result<(), String> {
    if config.schema_version != 1 || config.profiles.is_empty() || config.profiles.len() > 32 {
        return Err("Deck config must contain 1–32 profiles and use schema version 1".into());
    }
    let mut profile_ids = std::collections::HashSet::new();
    let mut profile_names = std::collections::HashSet::new();
    for profile in &config.profiles {
        if !valid_id(&profile.id)
            || !profile_ids.insert(profile.id.clone())
            || !valid_label(&profile.name, 32)
            || !profile_names.insert(profile.name.to_lowercase())
        {
            return Err("Profile IDs and names must be valid and unique".into());
        }
        if profile.pages.is_empty() || profile.pages.len() > MAX_PAGES {
            return Err("Each profile must contain 1–32 pages".into());
        }
        let mut page_ids = std::collections::HashSet::new();
        let mut page_names = std::collections::HashSet::new();
        let mut button_ids = std::collections::HashSet::<String>::new();
        for page in &profile.pages {
            if !valid_id(&page.id)
                || !page_ids.insert(&page.id)
                || !valid_label(&page.name, 24)
                || !page_names.insert(page.name.to_lowercase())
            {
                return Err("Page IDs and names must be valid and unique".into());
            }
            if !(1..=MAX_GRID).contains(&page.rows) || !(1..=MAX_GRID).contains(&page.columns) {
                return Err("Page rows and columns must be between 1 and 6".into());
            }
            if page.widget_area.is_some() {
                return Err("Widget areas must be converted to pages before saving".into());
            }
            validate_grid(page.rows, page.columns, &page.buttons, &page.widgets, &mut button_ids)?;
            if page.folders.len() > MAX_FOLDERS_PER_PAGE {
                return Err("A page can have up to 12 folders".into());
            }
            let mut folder_names = std::collections::HashSet::new();
            for folder in &page.folders {
                if !valid_id(&folder.id)
                    || !button_ids.insert(folder.id.clone())
                    || !valid_label(&folder.name, 24)
                    || !folder_names.insert(folder.name.to_lowercase())
                {
                    return Err("Folder IDs and names must be valid and unique".into());
                }
                if !(1..=MAX_GRID).contains(&folder.rows) || !(1..=MAX_GRID).contains(&folder.columns) {
                    return Err("Folder rows and columns must be between 1 and 6".into());
                }
                if folder
                    .buttons
                    .iter()
                    .any(|button| matches!(button.action, DeckAction::OpenFolder { .. }))
                {
                    return Err("Folders cannot contain folders".into());
                }
                validate_grid(folder.rows, folder.columns, &folder.buttons, &folder.widgets, &mut button_ids)?;
            }
        }
    }
    for profile in &config.profiles {
        if !profile.default_page_id.is_empty()
            && !profile.pages.iter().any(|page| page.id == profile.default_page_id)
        {
            return Err("The default page must exist in its profile".into());
        }
    }
    if !profile_ids.contains(&config.active_profile_id) {
        return Err("The active profile must exist".into());
    }
    if !config.fallback_profile_id.is_empty() && !profile_ids.contains(&config.fallback_profile_id)
    {
        return Err("The fallback profile must exist".into());
    }
    let mut matched_apps = std::collections::HashSet::new();
    for profile in &config.profiles {
        if profile.auto_switch_apps.len() > 32 {
            return Err("A profile can match up to 32 applications".into());
        }
        for app in &profile.auto_switch_apps {
            let normalized = app.trim().to_lowercase();
            if normalized.is_empty()
                || normalized.len() > 512
                || normalized.chars().any(char::is_control)
                || !matched_apps.insert(normalized)
            {
                return Err("Application matches must be valid and unique across profiles".into());
            }
        }
    }
    for profile in &config.profiles {
        let page_ids: std::collections::HashSet<_> =
            profile.pages.iter().map(|page| page.id.as_str()).collect();
        for page in &profile.pages {
            let mut opened = std::collections::HashSet::new();
            for button in page
                .buttons
                .iter()
                .chain(page.folders.iter().flat_map(|folder| &folder.buttons))
            {
                match &button.action {
                    DeckAction::SelectProfile { profile_id } if !profile_ids.contains(profile_id) => {
                        return Err("A button references an unknown profile".into())
                    }
                    DeckAction::SelectPage { page_id } if !page_ids.contains(page_id.as_str()) => {
                        return Err("A button references an unknown page".into())
                    }
                    DeckAction::OpenFolder { folder_id } => {
                        if !page.folders.iter().any(|folder| folder.id == *folder_id)
                            || !opened.insert(folder_id.as_str())
                        {
                            return Err("A folder button must open one folder on its own page".into());
                        }
                    }
                    _ => (),
                }
            }
            if page.folders.iter().any(|folder| !opened.contains(folder.id.as_str())) {
                return Err("Every folder needs a button that opens it".into());
            }
        }
    }
    Ok(())
}

const MAX_GRID: u8 = 6;
const MAX_PAGES: usize = 32;
const MAX_FOLDERS_PER_PAGE: usize = 12;

/// Buttons and widgets on one grid: they must fit, not overlap, and share the profile's unique id set.
fn validate_grid(
    rows: u8,
    columns: u8,
    buttons: &[DeckButton],
    widgets: &[DeckWidget],
    ids: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    if buttons.len() + widgets.len() > usize::from(rows) * usize::from(columns) {
        return Err("A grid cannot contain more items than its slots".into());
    }
    let mut placements = Vec::with_capacity(buttons.len() + widgets.len());
    for button in buttons {
        validate_deck_button(button, ids)?;
        placements.push(
            button
                .placement
                .ok_or_else(|| "Every button must have a grid position".to_owned())?,
        );
    }
    for widget in widgets {
        if !valid_id(&widget.id) || !ids.insert(widget.id.clone()) {
            return Err("Widget IDs must be valid and unique within a profile".into());
        }
        validate_deck_widget(widget)?;
        placements.push(widget.placement);
    }
    validate_layout(rows, columns, &placements)
}

fn validate_deck_widget(widget: &DeckWidget) -> Result<(), String> {
    let faces = match widget.kind {
        DeckWidgetType::Clock => CLOCK_FACES,
        DeckWidgetType::PcStats => PC_STATS_STYLES,
        _ if widget.face.is_some() || widget.color.is_some() => {
            return Err("Only clock and PC stats widgets have a style or colour".into());
        }
        _ => &[],
    };
    if widget.face.as_deref().is_some_and(|face| !faces.contains(&face)) {
        return Err("Unknown widget style".into());
    }
    if widget.color.as_deref().is_some_and(|color| !valid_hex_color(color)) {
        return Err("Widget colours must be #rrggbb".into());
    }
    if widget.metric.as_deref().is_some_and(|metric| {
        widget.kind != DeckWidgetType::PcStats || !PC_STATS_METRICS.contains(&metric)
    }) {
        return Err("Unknown PC stats reading".into());
    }
    if widget.gpu.as_deref().is_some_and(|gpu| {
        widget.kind != DeckWidgetType::PcStats
            || gpu.is_empty()
            || gpu.len() > 48
            || !gpu.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }) {
        return Err("Unknown PC stats GPU".into());
    }
    match widget.kind {
        DeckWidgetType::Clock
        | DeckWidgetType::NowPlaying
        | DeckWidgetType::Lyrics
        | DeckWidgetType::PcStats
            if widget.plugin_id.is_none()
                && widget.widget_id.is_none()
                && widget.render_type.is_none()
                && widget.values.is_none() =>
        {
            Ok(())
        }
        DeckWidgetType::Plugin => {
            if !widget.plugin_id.as_deref().is_some_and(valid_plugin_id)
                || !widget.widget_id.as_deref().is_some_and(valid_plugin_id)
                || !widget.render_type.as_deref().is_some_and(valid_plugin_id)
            {
                return Err("Plugin widgets need valid widget and renderer ids".into());
            }
            let values = widget
                .values
                .as_ref()
                .ok_or_else(|| "Plugin widgets need a values map".to_owned())?;
            if values.len() > 16 {
                return Err("Plugin widgets can contain at most 16 values".into());
            }
            let mut total = 0usize;
            for (id, value) in values {
                if !valid_plugin_id(id) || value.len() > 1024 || value.chars().any(char::is_control)
                {
                    return Err("Plugin widget values must be valid text under 1 KiB".into());
                }
                total += value.len();
            }
            if total > 8192 {
                return Err("Plugin widget values exceed the 8 KiB limit".into());
            }
            Ok(())
        }
        DeckWidgetType::Clock
        | DeckWidgetType::NowPlaying
        | DeckWidgetType::Lyrics
        | DeckWidgetType::PcStats => Err("Built-in widgets cannot contain plugin metadata".into()),
    }
}

fn validate_layout(rows: u8, columns: u8, placements: &[DeckPlacement]) -> Result<(), String> {
    for (index, placement) in placements.iter().enumerate() {
        if placement.row_span == 0
            || placement.column_span == 0
            || usize::from(placement.row) + usize::from(placement.row_span) > usize::from(rows)
            || usize::from(placement.column) + usize::from(placement.column_span)
                > usize::from(columns)
        {
            return Err("An item must fit inside its grid".into());
        }
        for other in placements.iter().skip(index + 1) {
            let rows_overlap = placement.row < other.row.saturating_add(other.row_span)
                && other.row < placement.row.saturating_add(placement.row_span);
            let columns_overlap = placement.column < other.column.saturating_add(other.column_span)
                && other.column < placement.column.saturating_add(placement.column_span);
            if rows_overlap && columns_overlap {
                return Err("Items cannot overlap on the grid".into());
            }
        }
    }
    Ok(())
}

fn validate_deck_button(
    button: &DeckButton,
    button_ids: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    if !valid_id(&button.id)
        || !button_ids.insert(button.id.clone())
        || !valid_label(&button.label, 24)
    {
        return Err("Button IDs and labels must be valid and unique within a profile".into());
    }
    if !valid_icon_name(&button.icon) {
        return Err("A button uses an unsupported icon".into());
    }
    if let Some(svg) = &button.icon_svg {
        let lower = svg.to_ascii_lowercase();
        if button.icon == "auto"
            || button.icon == "app-icon"
            || button.icon == "image"
            || svg.len() > 8_192
            || !svg.starts_with("<svg")
            || !svg.ends_with("</svg>")
            || [
                "<script",
                "<foreignobject",
                "<!",
                "<?",
                "onload=",
                "onclick=",
                "href=",
                "url(",
            ]
            .iter()
            .any(|blocked| lower.contains(blocked))
        {
            return Err("A button contains an invalid Lucide icon".into());
        }
    }
    if button
        .icon
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_uppercase)
        && ![
            "Command",
            "Monitor",
            "Music",
            "Mic",
            "Headphones",
            "AppWindow",
        ]
        .contains(&button.icon.as_str())
        && button.icon_svg.is_none()
    {
        return Err("A custom Lucide icon needs its vector data".into());
    }
    let supports_extracted_icon = matches!(
        &button.action,
        DeckAction::LaunchApp { .. }
            | DeckAction::LaunchFile { .. }
            | DeckAction::LaunchFolder { .. }
    );
    if let Some(data) = &button.app_icon_data {
        if data.len() > 65_536
            || !data.starts_with("data:image/png;base64,")
            || !(button.icon == "image" || (button.icon == "app-icon" && supports_extracted_icon))
        {
            return Err("A button contains an invalid extracted icon".into());
        }
    }
    if button.icon == "app-icon" && (button.app_icon_data.is_none() || !supports_extracted_icon) {
        return Err("An extracted icon requires a launch action".into());
    }
    // An image the user chose for the key, on any action.
    if button.icon == "image" && button.app_icon_data.is_none() {
        return Err("A button's image icon is missing".into());
    }
    if let Some(long_press) = &button.long_press {
        // A folder opens on the phone and a long press is not a place to start one.
        if matches!(long_press, DeckAction::OpenFolder { .. }) {
            return Err("A long press cannot open a folder".into());
        }
        validate_action(long_press)?;
    }
    validate_action(&button.action)
}

fn normalize_deck_layout(config: &mut DeckConfig) {
    let mut notes: Vec<String> = Vec::new();
    for profile in &mut config.profiles {
        if let Some(legacy) = profile.widget_screen.take() {
            let target_page_index = profile
                .pages
                .iter()
                .position(|page| page.id == profile.active_page_id)
                .unwrap_or(0);

            let mut item_ids = profile
                .pages
                .iter()
                .flat_map(|page| {
                    page.buttons.iter().map(|button| button.id.as_str()).chain(
                        page.widget_area.iter().flat_map(|area| {
                            area.pages.iter().flat_map(|widget_page| {
                                widget_page
                                    .buttons
                                    .iter()
                                    .map(|button| button.id.as_str())
                                    .chain(
                                        widget_page.widgets.iter().map(|widget| widget.id.as_str()),
                                    )
                            })
                        }),
                    )
                })
                .map(str::to_owned)
                .collect::<std::collections::HashSet<_>>();

            if let Some(page) = profile.pages.get_mut(target_page_index) {
                let area = page.widget_area.get_or_insert_with(|| DeckWidgetArea {
                    enabled: legacy.enabled,
                    rows: legacy.rows,
                    columns: legacy.columns,
                    pages: Vec::new(),
                });
                area.enabled |= legacy.enabled;
                area.rows = area.rows.max(legacy.rows);
                area.columns = area.columns.max(legacy.columns);

                let mut page_number = 1;
                let widget_page_id = loop {
                    let candidate = format!("widgets-migrated-{page_number}");
                    if area
                        .pages
                        .iter()
                        .all(|widget_page| widget_page.id != candidate)
                    {
                        break candidate;
                    }
                    page_number += 1;
                };
                let mut name_number = 1;
                let widget_page_name = loop {
                    let candidate = format!("Migrated {name_number}");
                    if area
                        .pages
                        .iter()
                        .all(|widget_page| !widget_page.name.eq_ignore_ascii_case(&candidate))
                    {
                        break candidate;
                    }
                    name_number += 1;
                };

                let mut buttons = legacy.buttons;
                for (index, button) in buttons.iter_mut().enumerate() {
                    if !item_ids.insert(button.id.clone()) {
                        let mut suffix = index + 1;
                        loop {
                            let candidate = format!("legacy-button-{suffix}");
                            if item_ids.insert(candidate.clone()) {
                                button.id = candidate;
                                break;
                            }
                            suffix += 1;
                        }
                    }
                }
                let mut widgets = legacy.widgets;
                for (index, widget) in widgets.iter_mut().enumerate() {
                    if !item_ids.insert(widget.id.clone()) {
                        let mut suffix = index + 1;
                        loop {
                            let candidate = format!("legacy-widget-{suffix}");
                            if item_ids.insert(candidate.clone()) {
                                widget.id = candidate;
                                break;
                            }
                            suffix += 1;
                        }
                    }
                }

                area.pages.push(DeckWidgetPage {
                    id: widget_page_id,
                    name: widget_page_name,
                    buttons,
                    widgets,
                });
            }
        }

        convert_widget_areas(profile, &mut notes);
        for page in &mut profile.pages {
            if !(1..=MAX_GRID).contains(&page.rows) || !(1..=MAX_GRID).contains(&page.columns) {
                // An older page with its button grid turned off: give it the default 2×3 grid.
                page.rows = if page.rows == 0 { 2 } else { page.rows.min(MAX_GRID) };
                page.columns = if page.columns == 0 { 3 } else { page.columns.min(MAX_GRID) };
            }
            normalize_button_placements(&mut page.buttons, page.rows, page.columns);
            clean_folders(page);
            for folder in &mut page.folders {
                folder.rows = folder.rows.clamp(1, MAX_GRID);
                folder.columns = folder.columns.clamp(1, MAX_GRID);
                normalize_button_placements(&mut folder.buttons, folder.rows, folder.columns);
            }
        }
    }
    config.migration_notes.extend(notes);
}

/// Widget areas are gone: the first widget page of a page with no buttons becomes the page's own grid,
/// and every other non-empty widget page becomes a page of its own, right after the page it came from.
fn convert_widget_areas(profile: &mut DeckProfile, notes: &mut Vec<String>) {
    if profile.pages.iter().all(|page| page.widget_area.is_none()) {
        return;
    }
    let originals = std::mem::take(&mut profile.pages);
    let total = originals.len();
    let mut names: std::collections::HashSet<String> = originals.iter().map(|page| page.name.to_lowercase()).collect();
    let mut ids: std::collections::HashSet<String> = originals.iter().map(|page| page.id.clone()).collect();
    let mut result: Vec<DeckPage> = Vec::with_capacity(total);
    for (index, mut page) in originals.into_iter().enumerate() {
        let mut extra = Vec::new();
        if let Some(area) = page.widget_area.take() {
            let (rows, columns) = (area.rows.clamp(1, MAX_GRID), area.columns.clamp(1, MAX_GRID));
            let mut pending: Vec<DeckWidgetPage> = area
                .pages
                .into_iter()
                .filter(|widget_page| !widget_page.buttons.is_empty() || !widget_page.widgets.is_empty())
                .collect();
            if page.buttons.is_empty() && page.widgets.is_empty() && !pending.is_empty() {
                let first = pending.remove(0);
                page.rows = rows;
                page.columns = columns;
                page.buttons = first.buttons;
                page.widgets = first.widgets;
            }
            let mut moved = 0;
            let mut dropped = 0;
            for widget_page in pending {
                if result.len() + 1 + extra.len() + (total - index - 1) >= MAX_PAGES {
                    dropped += 1;
                    continue;
                }
                let name = unique_page_name(&page.name, &mut names);
                let id = unique_page_id(&page.id, &mut ids);
                extra.push(DeckPage {
                    id,
                    name,
                    rows,
                    columns,
                    buttons: widget_page.buttons,
                    widgets: widget_page.widgets,
                    folders: Vec::new(),
                    widget_area: None,
                });
                moved += 1;
            }
            if moved > 0 || dropped > 0 {
                let mut note = format!("“{}”: {} widget page{} became {}.", page.name, moved, if moved == 1 { "" } else { "s" }, if moved == 1 { "its own page" } else { "their own pages" });
                if !area.enabled {
                    note.push_str(" They were hidden on the phone and are now visible.");
                }
                if dropped > 0 {
                    note.push_str(&format!(" {dropped} more could not be kept because a profile holds up to {MAX_PAGES} pages."));
                }
                notes.push(note);
            }
        }
        result.push(page);
        result.extend(extra);
    }
    profile.pages = result;
}

/// "Page widgets", then "Page widgets 2"…; the page name is shortened so the label stays within 24 bytes.
fn unique_page_name(base: &str, names: &mut std::collections::HashSet<String>) -> String {
    for number in 1usize.. {
        let suffix = if number == 1 { " widgets".to_owned() } else { format!(" widgets {number}") };
        let mut stem = base.to_owned();
        while stem.len() + suffix.len() > 24 {
            stem.pop();
        }
        let candidate = format!("{}{}", stem.trim_end(), suffix);
        if names.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    unreachable!()
}

fn unique_page_id(base: &str, ids: &mut std::collections::HashSet<String>) -> String {
    for number in 1usize.. {
        let suffix = format!("-w{number}");
        let stem: String = base.chars().take(64 - suffix.len()).collect();
        let candidate = format!("{stem}{suffix}");
        if ids.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}

/// Keeps folders and their buttons in step: no folder inside a folder, no button for a missing folder,
/// no folder without a button, and one button per folder.
fn clean_folders(page: &mut DeckPage) {
    for folder in &mut page.folders {
        folder.buttons.retain(|button| !matches!(button.action, DeckAction::OpenFolder { .. }));
    }
    page.folders.truncate(MAX_FOLDERS_PER_PAGE);
    let known: std::collections::HashSet<String> = page.folders.iter().map(|folder| folder.id.clone()).collect();
    let mut opened = std::collections::HashSet::new();
    page.buttons.retain(|button| match &button.action {
        DeckAction::OpenFolder { folder_id } => known.contains(folder_id) && opened.insert(folder_id.clone()),
        _ => true,
    });
    page.folders.retain(|folder| opened.contains(&folder.id));
}

fn normalize_button_placements(buttons: &mut [DeckButton], rows: u8, columns: u8) {
    let mut occupied = vec![false; usize::from(rows) * usize::from(columns)];
    for placement in buttons.iter().filter_map(|button| button.placement) {
        for row in placement.row..placement.row.saturating_add(placement.row_span) {
            for column in placement.column..placement.column.saturating_add(placement.column_span) {
                if let Some(slot) =
                    occupied.get_mut(usize::from(row) * usize::from(columns) + usize::from(column))
                {
                    *slot = true;
                }
            }
        }
    }
    for button in buttons
        .iter_mut()
        .filter(|button| button.placement.is_none())
    {
        if let Some(index) = occupied.iter().position(|slot| !slot) {
            occupied[index] = true;
            button.placement = Some(DeckPlacement {
                row: (index / usize::from(columns)) as u8,
                column: (index % usize::from(columns)) as u8,
                row_span: 1,
                column_span: 1,
            });
        }
    }
}

fn valid_icon_name(value: &str) -> bool {
    matches!(value, "auto" | "app-icon" | "image")
        || [
            "command",
            "monitor",
            "music",
            "mic",
            "headphones",
            "app-window",
        ]
        .contains(&value)
        || (value.len() <= 64
            && value.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
            && value.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

fn valid_label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn validate_action(action: &DeckAction) -> Result<(), String> {
    match action {
        DeckAction::Media { .. }
        | DeckAction::SelectProfile { .. }
        | DeckAction::SelectPage { .. }
        | DeckAction::OpenFolder { .. }
        | DeckAction::System { .. } => Ok(()),
        DeckAction::Hotkey { keys } => validate_hotkey(keys),
        DeckAction::LaunchApp { app } => validate_app_target(app),
        DeckAction::LaunchFile { path } => validate_file_target(path),
        DeckAction::LaunchFolder { path } => validate_file_target(path),
        DeckAction::RunScript { path, .. } => validate_script_target(path),
        DeckAction::TypeText { text } => validate_snippet(text),
        DeckAction::OpenUrl { url } => validate_url(url),
        DeckAction::PluginAction {
            plugin_id,
            action_id,
            ..
        } => {
            if valid_plugin_id(plugin_id) && valid_plugin_id(action_id) {
                Ok(())
            } else {
                Err("This plugin action has an invalid identifier".into())
            }
        }
        DeckAction::Sequence { steps } => {
            if steps.is_empty() || steps.len() > 10 {
                return Err("A sequence must contain 1–10 steps".into());
            }
            let mut waited = 0;
            for step in steps {
                match step {
                    DeckStep::Media { .. } => (),
                    DeckStep::TypeText { text } => validate_snippet(text)?,
                    DeckStep::OpenUrl { url } => validate_url(url)?,
                    DeckStep::Delay { ms } => {
                        // ponytail: a sequence runs on its phone's connection task, so waits are capped to keep
                        // that phone responsive; run sequences on their own thread if longer waits are needed.
                        waited += ms;
                        if !(50..=5_000).contains(ms) || waited > 10_000 {
                            return Err("A delay must be 50–5000 ms, and 10 seconds at most per sequence".into());
                        }
                    }
                    DeckStep::Hotkey { keys } => validate_hotkey(keys)?,
                    DeckStep::LaunchApp { app, .. } => validate_app_target(app)?,
                    DeckStep::LaunchFile { path } => validate_file_target(path)?,
                    DeckStep::LaunchFolder { path } => validate_file_target(path)?,
                }
            }
            Ok(())
        }
    }
}

fn validate_hotkey(keys: &[String]) -> Result<(), String> {
    if keys.len() < 2
        || keys.len() > 5
        || keys[..keys.len() - 1]
            .iter()
            .any(|key| !["CTRL", "ALT", "SHIFT", "META"].contains(&key.as_str()))
    {
        return Err("A shortcut must contain supported modifiers and one key".into());
    }
    let modifiers: std::collections::HashSet<_> = keys[..keys.len() - 1].iter().collect();
    if modifiers.len() != keys.len() - 1 {
        return Err("Shortcut modifiers must be unique".into());
    }
    parse_key(&keys[keys.len() - 1]).map(|_| ())
}

fn validate_app_target(app: &str) -> Result<(), String> {
    if app.trim().is_empty() || app.len() > 512 || app.chars().any(char::is_control) {
        Err("Enter a valid app name or path".into())
    } else {
        Ok(())
    }
}

fn validate_snippet(text: &str) -> Result<(), String> {
    // Line breaks and tabs are typed as Enter and Tab; other control characters are refused.
    if text.trim().is_empty()
        || text.len() > 2_000
        || text.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        Err("Enter the text to type (up to 2000 characters)".into())
    } else {
        Ok(())
    }
}

fn validate_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
    if rest.is_some_and(|rest| !rest.is_empty())
        && url.len() <= 2_048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"')
    {
        Ok(())
    } else {
        Err("Enter a web address starting with https://".into())
    }
}

fn validate_file_target(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
        Err("Choose a valid file or folder path".into())
    } else {
        Ok(())
    }
}

fn validate_script_target(path: &str) -> Result<(), String> {
    validate_file_target(path)?;
    let supported = Path::new(path.trim())
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            #[cfg(windows)]
            {
                ["ps1", "py"]
                    .iter()
                    .any(|allowed| extension.eq_ignore_ascii_case(allowed))
            }
            #[cfg(not(windows))]
            {
                ["sh", "py"]
                    .iter()
                    .any(|allowed| extension.eq_ignore_ascii_case(allowed))
            }
        });
    if supported {
        Ok(())
    } else {
        #[cfg(windows)]
        {
            Err("Choose a PowerShell (.ps1) or Python (.py) script".into())
        }
        #[cfg(not(windows))]
        {
            Err("Choose a shell (.sh) or Python (.py) script".into())
        }
    }
}

fn valid_plugin_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn validate_plugin_manifest(manifest: &OpenDockPluginManifest) -> Result<(), String> {
    if manifest.schema_version != 1
        || !valid_plugin_id(&manifest.id)
        || !valid_label(&manifest.name, 80)
        || manifest.version.trim().is_empty()
        || manifest.version.len() > 32
        || manifest.version.chars().any(char::is_control)
        || manifest.description.len() > 256
        || manifest.description.chars().any(char::is_control)
        || manifest.actions.len() > 32
        || manifest.widgets.len() > 32
        || (manifest.actions.is_empty() && manifest.widgets.is_empty())
    {
        return Err("The Open Dock plugin manifest has invalid metadata".into());
    }
    let mut ids = std::collections::HashSet::new();
    for action in &manifest.actions {
        if !valid_plugin_id(&action.id)
            || !ids.insert(&action.id)
            || !valid_label(&action.name, 80)
            || action.description.len() > 256
            || action.description.chars().any(char::is_control)
            || !action.script.starts_with("scripts/")
            || action.script[8..].is_empty()
            || action.script[8..].contains(['/', '\\', ':'])
            || action.script[8..].starts_with('.')
        {
            return Err("The Open Dock plugin contains an invalid action".into());
        }
        validate_plugin_inputs(&action.inputs)?;
        validate_script_target(&action.script[8..])?;
    }
    let mut widget_ids = std::collections::HashSet::new();
    for widget in &manifest.widgets {
        if !valid_plugin_id(&widget.id)
            || !widget_ids.insert(&widget.id)
            || !valid_label(&widget.name, 80)
            || widget.description.len() > 256
            || widget.description.chars().any(char::is_control)
            || widget.kind != "text"
        {
            return Err("The Open Dock plugin contains an invalid widget".into());
        }
        validate_plugin_inputs(&widget.inputs)?;
    }
    Ok(())
}

fn validate_plugin_inputs(inputs: &[OpenDockPluginInput]) -> Result<(), String> {
    if inputs.len() > 16 {
        return Err("A plugin action or widget can define at most 16 inputs".into());
    }
    let mut input_ids = std::collections::HashSet::new();
    for input in inputs {
        if !valid_plugin_id(&input.id)
            || !input_ids.insert(&input.id)
            || !valid_label(&input.label, 64)
            || input.default.len() > 512
            || input.default.chars().any(char::is_control)
        {
            return Err("The Open Dock plugin contains an invalid input".into());
        }
        match input.kind.as_str() {
            "text" if input.options.is_empty() && input.option_labels.is_empty() => (),
            "number"
                if input.options.is_empty()
                    && input.option_labels.is_empty()
                    && (input.default.is_empty()
                        || input.default.parse::<f64>().is_ok_and(f64::is_finite)) =>
            {
                ()
            }
            "select" => {
                let mut options = std::collections::HashSet::new();
                if input.options.is_empty()
                    || input.options.len() > 32
                    || (!input.option_labels.is_empty()
                        && input.option_labels.len() != input.options.len())
                    || input
                        .option_labels
                        .iter()
                        .any(|label| !valid_label(label, 80))
                    || input.options.iter().any(|option| {
                        option.is_empty()
                            || option.len() > 128
                            || option.chars().any(char::is_control)
                            || !options.insert(option)
                    })
                    || (!input.default.is_empty() && !options.contains(&input.default))
                {
                    return Err("The Open Dock plugin contains an invalid select input".into());
                }
            }
            "text" => return Err("Text inputs cannot define options".into()),
            "number" => return Err("The Open Dock plugin contains an invalid number input".into()),
            _ => return Err("Open Dock plugin inputs must be text, number, or select".into()),
        }
    }
    Ok(())
}

fn read_open_dock_plugin_manifest(
    directory: &Path,
) -> Result<(OpenDockPluginManifest, Vec<u8>), String> {
    let directory_metadata = fs::symlink_metadata(directory)
        .map_err(|_| "Could not access the plugin folder".to_owned())?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err("Plugin folders must be regular directories".into());
    }
    let manifest_path = directory.join("manifest.json");
    let metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|_| "Plugin folder must contain a manifest.json file".to_owned())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PLUGIN_MANIFEST_BYTES as u64
    {
        return Err("The plugin manifest must be a regular JSON file under 64 KiB".into());
    }
    let bytes =
        fs::read(&manifest_path).map_err(|_| "Could not read the plugin manifest".to_owned())?;
    let manifest: OpenDockPluginManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "The plugin manifest is not valid Open Dock plugin JSON".to_owned())?;
    validate_plugin_manifest(&manifest)?;
    Ok((manifest, bytes))
}

fn plugin_scripts(
    directory: &Path,
    manifest: &OpenDockPluginManifest,
) -> Result<Vec<(PathBuf, String)>, String> {
    let root = directory
        .canonicalize()
        .map_err(|_| "Could not access the plugin folder".to_owned())?;
    let mut scripts = Vec::with_capacity(manifest.actions.len());
    let mut copied = std::collections::HashSet::new();
    for action in &manifest.actions {
        if !copied.insert(&action.script) {
            continue;
        }
        let source = directory.join(&action.script);
        let metadata = fs::symlink_metadata(&source)
            .map_err(|_| format!("Plugin script is missing: {}", action.script))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_PLUGIN_SCRIPT_BYTES
        {
            return Err(format!(
                "Plugin script must be a regular file under 1 MiB: {}",
                action.script
            ));
        }
        let canonical = source
            .canonicalize()
            .map_err(|_| "Could not resolve a plugin script".to_owned())?;
        if !canonical.starts_with(&root) {
            return Err("Plugin scripts must remain inside their package folder".into());
        }
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid plugin script filename")?
            .to_owned();
        scripts.push((source, file_name));
    }
    Ok(scripts)
}

fn open_dock_plugins_path(config_dir: &Path) -> PathBuf {
    config_dir.join("plugins")
}

fn plugin_is_used(config: &DeckConfig, plugin_id: &str) -> bool {
    config.profiles.iter().any(|profile| {
        let button_uses_plugin = |button: &DeckButton| {
            matches!(&button.action, DeckAction::PluginAction { plugin_id: id, .. } if id == plugin_id)
        };
        let widget_uses_plugin = |widget: &DeckWidget| {
            widget.kind == DeckWidgetType::Plugin
                && widget.plugin_id.as_deref() == Some(plugin_id)
        };
        profile.pages.iter().any(|page| {
            page.buttons.iter().any(button_uses_plugin)
                || page.widgets.iter().any(widget_uses_plugin)
                || page.folders.iter().any(|folder| {
                    folder.buttons.iter().any(button_uses_plugin)
                        || folder.widgets.iter().any(widget_uses_plugin)
                })
        })
    })
}

fn save_deck_config_file(path: &Path, config: &DeckConfig) -> Result<(), String> {
    validate_deck_config(config)?;
    let temp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let bytes =
        serde_json::to_vec_pretty(config).map_err(|_| "Could not encode deck config".to_owned())?;
    if bytes.len() > MAX_DECK_CONFIG_BYTES {
        return Err("Deck config exceeds the 1 MiB size limit".into());
    }
    fs::write(&temp, bytes).map_err(|_| "Could not write deck config".to_owned())?;
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|_| "Could not prepare deck config update".to_owned())?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not save deck config: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn get_deck_config(state: &AppState) -> Option<DeckConfig> {
    state.deck_config.read().ok().map(|config| config.clone())
}

/// "" for the shared deck, or the phone's id when it has a deck of its own.
fn deck_key(state: &AppState, device_id: &str) -> String {
    let own = !device_id.is_empty()
        && state.device_decks.read().is_ok_and(|decks| decks.contains_key(device_id));
    if own { device_id.to_owned() } else { String::new() }
}

fn read_deck(state: &AppState, key: &str) -> Option<DeckConfig> {
    if key.is_empty() {
        get_deck_config(state)
    } else {
        state.device_decks.read().ok()?.get(key).cloned()
    }
}

/// The deck this phone sees: its own if it has one, else the shared deck.
fn device_config(state: &AppState, device_id: &str) -> Option<DeckConfig> {
    read_deck(state, &deck_key(state, device_id))
}

/// Gives a phone a deck of its own, copied from the shared deck, if it has none yet. The shared deck
/// is then only the template new phones start from: editing one phone never changes another's.
fn ensure_device_deck(state: &AppState, config_dir: &Path, device_id: &str) {
    if !valid_id(device_id) {
        return;
    }
    let Some(shared) = get_deck_config(state) else {
        return;
    };
    let Ok(mut decks) = state.device_decks.write() else {
        return;
    };
    if !decks.contains_key(device_id) && save_device_deck_file(config_dir, device_id, &shared).is_ok() {
        decks.insert(device_id.to_owned(), shared);
    }
}

fn pc_name(state: &AppState) -> String {
    state.device_name.read().map(|name| name.clone()).unwrap_or_default()
}

fn save_device_deck_file(config_dir: &Path, device_id: &str, config: &DeckConfig) -> Result<(), String> {
    let dir = config_dir.join("device-decks");
    fs::create_dir_all(&dir).map_err(|_| "Could not create the device deck folder".to_owned())?;
    save_deck_config_file(&dir.join(format!("{device_id}.json")), config)
}

fn persist_known_devices(state: &AppState) {
    let Some(config_dir) = state.config_dir.read().ok().and_then(|dir| dir.clone()) else {
        return;
    };
    if let Ok(devices) = state.known_devices.read() {
        if let Ok(bytes) = serde_json::to_vec(&*devices) {
            let _ = fs::write(config_dir.join("devices.json"), bytes);
        }
    }
    if let Ok(meta) = state.device_meta.read() {
        if let Ok(bytes) = serde_json::to_vec(&*meta) {
            let _ = fs::write(config_dir.join("device-meta.json"), bytes);
        }
    }
}

/// What the PC keeps about a phone besides the name it gave itself.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct DeviceMeta {
    /// The name the PC shows instead of the phone's own; empty means none.
    alias: String,
}

fn load_devices(state: &AppState, config_dir: &Path) {
    if let Ok(name) = fs::read_to_string(config_dir.join("pc-name")) {
        let name = name.trim();
        if valid_label(name, 40) {
            if let Ok(mut current) = state.device_name.write() {
                *current = name.to_owned();
            }
        }
    }
    if let Some(known) = fs::read(config_dir.join("devices.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, String>>(&bytes).ok())
    {
        if let Ok(mut devices) = state.known_devices.write() {
            *devices = known.into_iter().filter(|(id, _)| valid_id(id)).collect();
        }
    }
    if let Some(meta) = fs::read(config_dir.join("device-meta.json"))
        .ok()
        .filter(|bytes| bytes.len() <= MAX_DECK_CONFIG_BYTES)
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, DeviceMeta>>(&bytes).ok())
    {
        if let Ok(mut current) = state.device_meta.write() {
            *current = meta
                .into_iter()
                .filter(|(id, _)| valid_id(id))
                .map(|(id, mut meta)| {
                    if !meta.alias.is_empty() && !valid_label(&meta.alias, 40) {
                        meta.alias.clear();
                    }
                    (id, meta)
                })
                .collect();
        }
    }
    if let Ok(entries) = fs::read_dir(config_dir.join("device-decks")) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_owned) else {
                continue;
            };
            if path.extension().is_none_or(|ext| ext != "json") || !valid_id(&id) {
                continue;
            }
            let config = fs::read(&path)
                .ok()
                .filter(|bytes| bytes.len() <= MAX_DECK_CONFIG_BYTES)
                .and_then(|bytes| serde_json::from_slice::<DeckConfig>(&bytes).ok())
                .filter(|config| validate_deck_config(config).is_ok());
            if let (Some(config), Ok(mut decks)) = (config, state.device_decks.write()) {
                decks.insert(id, config);
            }
        }
    }
    // Phones paired before every phone got its own deck keep what they see now, as a copy.
    let known: Vec<String> = state.known_devices.read().map(|devices| devices.keys().cloned().collect()).unwrap_or_default();
    for id in known {
        ensure_device_deck(state, config_dir, &id);
    }
}

/// Re-reads every saved app icon once, at the sharper sizes the shell offers. Icons saved before 1.5.2 are 32 px
/// and blur on a phone. A deck whose upgraded copy would not save (too big) keeps its old icons.
#[cfg(target_os = "windows")]
fn upgrade_app_icons(state: &AppState, config_dir: &Path) {
    let marker = config_dir.join("icon-quality-v2");
    if marker.exists() {
        return;
    }
    fn upgraded(config: &DeckConfig) -> Option<DeckConfig> {
        let mut next = config.clone();
        let mut changed = false;
        for profile in &mut next.profiles {
            for page in &mut profile.pages {
                let folders = page.folders.iter_mut().flat_map(|folder| folder.buttons.iter_mut());
                for button in page.buttons.iter_mut().chain(folders) {
                    let DeckAction::LaunchApp { app } = &button.action else {
                        continue;
                    };
                    if button.icon != "app-icon" {
                        continue;
                    }
                    if let Ok(data) = read_app_icon(app.clone(), true) {
                        if button.app_icon_data.as_deref() != Some(data.as_str()) {
                            button.app_icon_data = Some(data);
                            changed = true;
                        }
                    }
                }
            }
        }
        // A phone holding the old deck sees the change through the revision.
        next.revision = next.revision.saturating_add(1);
        changed.then_some(next)
    }
    if let Ok(mut shared) = state.deck_config.write() {
        if let Some(next) = upgraded(&shared) {
            if save_deck_config_file(&config_dir.join("deck-config.json"), &next).is_ok() {
                *shared = next;
            }
        }
    }
    if let Ok(mut decks) = state.device_decks.write() {
        for (id, deck) in decks.iter_mut() {
            if let Some(next) = upgraded(deck) {
                if save_device_deck_file(config_dir, id, &next).is_ok() {
                    *deck = next;
                }
            }
        }
    }
    let _ = fs::write(marker, "done");
}

fn register_device(state: &AppState, id: &str, name: Option<&str>) {
    if let Ok(mut online) = state.online_devices.lock() {
        *online.entry(id.to_owned()).or_insert(0) += 1;
    }
    let name = name.map(str::trim).filter(|name| valid_label(name, 40));
    let changed = state.known_devices.write().is_ok_and(|mut devices| {
        let current = devices.get(id).cloned();
        let next = name.map(str::to_owned).or_else(|| current.clone()).unwrap_or_else(|| "Phone".to_owned());
        let changed = current.as_deref() != Some(next.as_str());
        if changed {
            devices.insert(id.to_owned(), next);
        }
        changed
    });
    if changed {
        persist_known_devices(state);
    }
    if let Some(config_dir) = state.config_dir.read().ok().and_then(|dir| dir.clone()) {
        ensure_device_deck(state, &config_dir, id);
    }
}

fn unregister_device(state: &AppState, id: &str) {
    if let Ok(mut online) = state.online_devices.lock() {
        if let Some(count) = online.get_mut(id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                online.remove(id);
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo {
    id: String,
    /// What the PC calls the phone: the name given here, else the phone's own.
    name: String,
    phone_name: String,
    online: bool,
    /// Has its own deck instead of the shared one.
    own_deck: bool,
}

#[tauri::command]
fn list_devices(state: tauri::State<'_, Arc<AppState>>) -> Vec<DeviceInfo> {
    let online = state.online_devices.lock().map(|online| online.clone()).unwrap_or_default();
    let decks = state.device_decks.read().map(|decks| decks.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
    let meta = state.device_meta.read().map(|meta| meta.clone()).unwrap_or_default();
    let mut devices: Vec<DeviceInfo> = state
        .known_devices
        .read()
        .map(|known| {
            known
                .iter()
                .map(|(id, name)| DeviceInfo {
                    id: id.clone(),
                    name: meta.get(id).map(|meta| meta.alias.clone()).filter(|alias| !alias.is_empty()).unwrap_or_else(|| name.clone()),
                    phone_name: name.clone(),
                    online: online.contains_key(id),
                    own_deck: decks.contains(id),
                })
                .collect()
        })
        .unwrap_or_default();
    devices.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.name.cmp(&b.name)));
    devices
}

/// Names a phone on this PC; an empty name goes back to the phone's own.
#[tauri::command]
fn rename_device(device_id: String, name: String, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let name = name.trim();
    if !valid_id(&device_id) || !state.known_devices.read().is_ok_and(|known| known.contains_key(&device_id)) {
        return Err("Unknown device".into());
    }
    if !name.is_empty() && !valid_label(name, 40) {
        return Err("Use 1 to 40 characters".into());
    }
    state
        .device_meta
        .write()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .entry(device_id)
        .or_default()
        .alias = name.to_owned();
    persist_known_devices(&state);
    Ok(())
}

/// Replaces a phone's deck with a fresh copy of the shared template deck.
#[tauri::command]
fn reset_device_deck(device_id: String, state: tauri::State<'_, Arc<AppState>>) -> Result<DeckConfig, String> {
    if !valid_id(&device_id) {
        return Err("Unknown device".into());
    }
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are unavailable".to_owned())?;
    let shared = get_deck_config(&state).ok_or_else(|| "Open Dock deck config is unavailable".to_owned())?;
    let mut decks = state
        .device_decks
        .write()
        .map_err(|_| "Open Dock deck config is unavailable".to_owned())?;
    // Keep the revision moving forward so a phone holding the old deck sees the change.
    let mut next = shared;
    next.revision = decks.get(&device_id).map_or(next.revision, |own| own.revision).saturating_add(1);
    save_device_deck_file(&config_dir, &device_id, &next)?;
    decks.insert(device_id.clone(), next.clone());
    let _ = state.deck_updates.send((device_id, next.clone()));
    Ok(next)
}

/// Makes the PC forget a phone and delete its deck. A phone that is connected right now stays.
#[tauri::command]
fn forget_device(device_id: String, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    if !valid_id(&device_id) {
        return Err("Unknown device".into());
    }
    if state.online_devices.lock().is_ok_and(|online| online.contains_key(&device_id)) {
        return Err("Disconnect this phone first".into());
    }
    if let Ok(mut known) = state.known_devices.write() {
        known.remove(&device_id);
    }
    if let Ok(mut meta) = state.device_meta.write() {
        meta.remove(&device_id);
    }
    if let Ok(mut decks) = state.device_decks.write() {
        decks.remove(&device_id);
    }
    if let Some(config_dir) = state.config_dir.read().ok().and_then(|dir| dir.clone()) {
        let _ = fs::remove_file(config_dir.join("device-decks").join(format!("{device_id}.json")));
    }
    persist_known_devices(&state);
    Ok(())
}

#[tauri::command]
fn set_pc_name(name: String, state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let name = name.trim().to_owned();
    if !valid_label(&name, 40) {
        return Err("Use 1 to 40 characters".into());
    }
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are unavailable".to_owned())?;
    fs::write(config_dir.join("pc-name"), &name).map_err(|_| "Could not save the name".to_owned())?;
    *state.device_name.write().map_err(|_| "Open Dock settings are unavailable".to_owned())? = name.clone();
    Ok(name)
}

/// The deck config as a phone speaking `protocol` understands it. Protocol 2 gets the config as stored,
/// minus what only the PC needs. Protocol 1 phones know nothing of widgets on the page grid or of folders:
/// widgets move into a one-page widget area of the same size, and folder buttons are left out.
fn config_for_protocol(config: &DeckConfig, protocol: u32) -> serde_json::Value {
    use serde_json::{json, Value};
    let mut value = serde_json::to_value(config).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.remove("migrationNotes");
    }
    if protocol >= 2 {
        return value;
    }
    let Some(profiles) = value.get_mut("profiles").and_then(Value::as_array_mut) else {
        return value;
    };
    for profile in profiles {
        let Some(pages) = profile.get_mut("pages").and_then(Value::as_array_mut) else {
            continue;
        };
        // Older phones accept up to 8 pages.
        pages.truncate(8);
        for page in pages {
            let Some(page) = page.as_object_mut() else { continue };
            let widgets = page.remove("widgets").unwrap_or_else(|| json!([]));
            page.remove("folders");
            if let Some(buttons) = page.get_mut("buttons").and_then(Value::as_array_mut) {
                buttons.retain(|button| button.pointer("/action/type").and_then(Value::as_str) != Some("open_folder"));
            }
            let has_widgets = widgets.as_array().is_some_and(|items| !items.is_empty());
            let has_buttons = page.get("buttons").and_then(Value::as_array).is_some_and(|items| !items.is_empty());
            if has_widgets {
                let (rows, columns) = (page.get("rows").cloned().unwrap_or(json!(2)), page.get("columns").cloned().unwrap_or(json!(3)));
                page.insert(
                    "widgetArea".into(),
                    json!({ "enabled": true, "rows": rows, "columns": columns, "pages": [{ "id": "widgets-1", "name": "Page 1", "buttons": [], "widgets": widgets }] }),
                );
                if !has_buttons {
                    // The old way to say "widgets only".
                    page.insert("rows".into(), json!(0));
                    page.insert("columns".into(), json!(0));
                }
            }
        }
        // Selections and defaults must name a page this phone still sees.
        let first = profile.pointer("/pages/0/id").cloned();
        for key in ["activePageId", "defaultPageId"] {
            let known = profile.get(key).is_some_and(|id| profile.get("pages").and_then(Value::as_array).is_some_and(|pages| pages.iter().any(|page| page.get("id") == Some(id))));
            if !known {
                if let (Some(first), Some(object)) = (first.clone(), profile.as_object_mut()) {
                    object.insert(key.into(), first);
                }
            }
        }
    }
    value
}

fn device_deck_snapshot(
    protocol: u32,
    config: &DeckConfig,
    independent: bool,
    profile_id: &mut String,
    page_id: &mut String,
) -> serde_json::Value {
    if !independent {
        let active_page_id = config
            .profiles
            .iter()
            .find(|profile| profile.id == config.active_profile_id)
            .map(|profile| profile.active_page_id.as_str())
            .unwrap_or_default();
        return serde_json::json!({
            "type": "deck_snapshot",
            "protocolVersion": protocol,
            "config": config_for_protocol(config, protocol),
            "independentNavigation": false,
            "selection": { "profileId": config.active_profile_id, "pageId": active_page_id }
        });
    }

    if !config
        .profiles
        .iter()
        .any(|profile| profile.id == *profile_id)
    {
        *profile_id = config.active_profile_id.clone();
    }
    let Some(profile) = config
        .profiles
        .iter()
        .find(|profile| profile.id == *profile_id)
    else {
        *profile_id = config.profiles[0].id.clone();
        return device_deck_snapshot(protocol, config, independent, profile_id, page_id);
    };
    if !profile.pages.iter().any(|page| page.id == *page_id) {
        *page_id = profile.active_page_id.clone();
    }
    if !profile.pages.iter().any(|page| page.id == *page_id) {
        *page_id = profile.pages[0].id.clone();
    }
    serde_json::json!({
        "type": "deck_snapshot",
        "protocolVersion": protocol,
        "config": config_for_protocol(config, protocol),
        "independentNavigation": true,
        "selection": { "profileId": profile_id, "pageId": page_id }
    })
}

fn update_device_selection(
    state: &AppState,
    key: &str,
    expected_revision: u64,
    profile_id: Option<&str>,
    page_id: Option<&str>,
    selected_profile_id: &mut String,
    selected_page_id: &mut String,
) -> Result<(), String> {
    let config = read_deck(state, key).ok_or_else(|| "Deck config is unavailable".to_owned())?;
    if config.revision != expected_revision {
        return Err("stale_revision".into());
    }
    let target_profile_id = profile_id.unwrap_or(selected_profile_id);
    let profile = config
        .profiles
        .iter()
        .find(|profile| profile.id == target_profile_id)
        .ok_or_else(|| "unknown_profile".to_owned())?;
    let target_page_id = page_id.unwrap_or_else(|| {
        if profile_id.is_some() {
            profile.active_page_id.as_str()
        } else {
            selected_page_id.as_str()
        }
    });
    if !profile.pages.iter().any(|page| page.id == target_page_id) {
        return Err("unknown_page".into());
    }
    *selected_profile_id = profile.id.clone();
    *selected_page_id = target_page_id.to_owned();
    Ok(())
}

#[tauri::command]
fn get_independent_navigation(state: tauri::State<'_, Arc<AppState>>) -> bool {
    state.independent_navigation.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_independent_navigation(
    enabled: bool,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are unavailable".to_owned())?;
    fs::write(
        config_dir.join("independent-navigation"),
        if enabled { "true" } else { "false" },
    )
    .map_err(|_| "Could not save navigation setting".to_owned())?;
    state
        .independent_navigation
        .store(enabled, Ordering::Relaxed);
    let _ = state.navigation_updates.send(enabled);
    Ok(enabled)
}

fn load_deck_config(path: &Path) -> DeckConfig {
    for candidate in [path.to_path_buf(), path.with_extension("json.bak")] {
        if candidate
            .metadata()
            .is_ok_and(|metadata| metadata.len() as usize <= MAX_DECK_CONFIG_BYTES)
        {
            if let Ok(bytes) = fs::read(candidate) {
                if let Ok(mut config) = serde_json::from_slice::<DeckConfig>(&bytes) {
                    if config.legacy_auto_switch_enabled {
                        for profile in &mut config.profiles {
                            profile.auto_switch_enabled = !profile.auto_switch_apps.is_empty();
                        }
                    }
                    config.legacy_auto_switch_enabled = false;
                    for page in config
                        .profiles
                        .iter_mut()
                        .flat_map(|profile| &mut profile.pages)
                    {
                        if page.rows == 0 || page.columns == 0 {
                            if page.rows == 0 && page.columns == 0 && page.buttons.is_empty() {
                                continue;
                            }
                            page.columns = if page.buttons.len() > 18 { 6 } else { 3 };
                            page.rows = page
                                .buttons
                                .len()
                                .max(1)
                                .div_ceil(usize::from(page.columns))
                                as u8;
                        }
                    }
                    normalize_deck_layout(&mut config);
                    // Open Dock opens on the default profile and each profile's default page.
                    for profile in &mut config.profiles {
                        if profile.pages.iter().any(|page| page.id == profile.default_page_id) {
                            profile.active_page_id = profile.default_page_id.clone();
                        }
                    }
                    if config.profiles.iter().any(|profile| profile.id == config.fallback_profile_id) {
                        config.active_profile_id = config.fallback_profile_id.clone();
                    }
                    for button in config
                        .profiles
                        .iter_mut()
                        .flat_map(|profile| &mut profile.pages)
                        .flat_map(|page| &mut page.buttons)
                    {
                        let legacy = button.icon.as_str();
                        button.icon = match legacy {
                            "command" => "Command",
                            "monitor" => "Monitor",
                            "music" if matches!(&button.action, DeckAction::Media { .. }) => "auto",
                            "headphones" | "mic"
                                if matches!(&button.action, DeckAction::Media { .. }) =>
                            {
                                "auto"
                            }
                            "music" => "Music",
                            "headphones" => "Headphones",
                            "mic" => "Mic",
                            "app-window" => "AppWindow",
                            _ => continue,
                        }
                        .to_owned();
                        if button.icon == "auto" {
                            button.icon_svg = None;
                        }
                    }
                    if validate_deck_config(&config).is_ok() {
                        return config;
                    }
                }
            }
        }
    }
    default_deck_config()
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Authenticate {
        token: String,
        #[serde(default, rename = "protocolVersion")]
        protocol_version: Option<u32>,
        #[serde(default, rename = "legacySourceId")]
        legacy_source_id: Option<String>,
        #[serde(default, rename = "legacyDeckAvailable")]
        legacy_deck_available: bool,
        #[serde(default, rename = "supportsIndependentNavigation")]
        supports_independent_navigation: bool,
        #[serde(default, rename = "selectedProfileId")]
        selected_profile_id: Option<String>,
        #[serde(default, rename = "selectedPageId")]
        selected_page_id: Option<String>,
        #[serde(default, rename = "deviceId")]
        device_id: Option<String>,
        #[serde(default, rename = "deviceName")]
        device_name: Option<String>,
    },
    InvokeButton {
        #[serde(rename = "requestId")]
        request_id: String,
        revision: u64,
        #[serde(rename = "buttonId")]
        button_id: String,
        #[serde(default, rename = "longPress")]
        long_press: bool,
    },
    InvokeMediaCommand {
        #[serde(rename = "requestId")]
        request_id: String,
        command: MediaCommand,
    },
    SetSystemVolume {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "volumePercent")]
        volume_percent: u8,
    },
    SelectProfile {
        #[serde(rename = "requestId")]
        request_id: String,
        revision: u64,
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    SelectPage {
        #[serde(rename = "requestId")]
        request_id: String,
        revision: u64,
        #[serde(rename = "pageId")]
        page_id: String,
    },
    LegacyDeck {
        #[serde(rename = "legacyDeck")]
        deck: LegacyPhonePageSet,
    },
    WidgetSurface {
        surface: WidgetSurface,
    },
    /// The readings the PC stats widgets on the phone's current page show; empty stops them.
    PcStatsSubscribe {
        needs: Vec<String>,
    },
    /// The phone app went to the background (false) or came back (true).
    SetStreaming {
        active: bool,
    },
    SeekMedia {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "positionMs")]
        position_ms: u64,
    },
    /// The phone chose which media player to control; none means Auto.
    SelectMediaPlayer {
        #[serde(default, rename = "playerId")]
        player_id: Option<String>,
    },
    /// Touchpad and keyboard input from the phone's Touch screen.
    Pointer {
        event: remote::PointerEvent,
    },
    /// The phone's mic started or stopped listening for a command; `text` is what it has heard so far.
    VoiceState {
        listening: bool,
        #[serde(default)]
        text: String,
    },
    /// A sentence said into the phone's mic, such as "open spotify" or "volume up".
    VoiceCommand {
        #[serde(rename = "requestId")]
        request_id: String,
        text: String,
    },
    /// A signature drawn on the phone, to paste into the app that has focus on the PC.
    Signature {
        strokes: remote::Strokes,
    },
    /// Adds or replaces `button` (matched by id) and/or removes `removeId` on a page or one of its folders.
    EditButton {
        #[serde(rename = "requestId")]
        request_id: String,
        revision: u64,
        #[serde(rename = "pageId")]
        page_id: String,
        #[serde(default, rename = "folderId")]
        folder_id: Option<String>,
        #[serde(default)]
        button: Option<DeckButton>,
        #[serde(default, rename = "removeId")]
        remove_id: Option<String>,
    },
}

enum ClientAction {
    Hotkey { keys: Vec<String> },
    Media { command: MediaCommand },
    LaunchApp { app: String },
    LaunchFile { path: String },
    LaunchFolder { path: String },
    TypeText { text: String },
    OpenUrl { url: String },
    Sequence { actions: Vec<SequenceAction> },
}

enum SequenceAction {
    Hotkey { keys: Vec<String> },
    Media { command: MediaCommand },
    LaunchApp { app: String },
    LaunchFile { path: String },
    LaunchFolder { path: String },
    TypeText { text: String },
    OpenUrl { url: String },
    Delay { ms: u32 },
}

/// PC stats samples for the desktop previews, oldest first: the last minute, or only those after
/// `since` (a sample's `seq`). `needs` lists the readings the previews on screen show; the request
/// keeps them sampled for 3 seconds, so previews poll while visible and sampling stops when they go.
#[tauri::command]
fn pc_stats_history(
    state: tauri::State<'_, Arc<AppState>>,
    needs: Vec<String>,
    since: Option<u64>,
) -> Vec<pc_stats::PcStats> {
    state.pc_stats_demand.set(
        pc_stats::DESKTOP,
        pc_stats::Needs::from_names(&needs[..needs.len().min(16)]),
        Some(Duration::from_secs(3)),
    );
    let history = state.pc_stats.borrow();
    // A gap (sampling stopped and restarted) means `since` no longer lines up: send it all.
    let newest = history.back().map_or(0, |sample| sample.seq);
    match since {
        Some(since) if since <= newest => history.iter().filter(|sample| sample.seq > since).cloned().collect(),
        _ => history.iter().cloned().collect(),
    }
}

#[tauri::command]
fn connection_info(state: tauri::State<'_, Arc<AppState>>) -> ConnectionInfo {
    ConnectionInfo {
        host: state.host.clone(),
        device_name: pc_name(&state),
        port: PORT,
        token: state
            .token
            .read()
            .map(|token| token.clone())
            .unwrap_or_default(),
        active_devices: state.active_devices.load(Ordering::Relaxed),
        server_online: state.server_online.load(Ordering::Relaxed),
        is_macos: IS_MACOS,
        android_usb_enabled: state.android_usb_enabled.load(Ordering::Relaxed),
        android_usb: state.usb_panel.read().map(|panel| panel.clone()).unwrap_or_default(),
        widget_surface: state.widget_surface.read().ok().and_then(|surface| *surface),
        pin: state.pin_pairing.lock().map(|pairing| pairing.pin().to_owned()).unwrap_or_default(),
    }
}

#[tauri::command]
fn deck_config(
    device_id: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DeckConfig, String> {
    device_config(&state, &device_id.unwrap_or_default())
        .ok_or_else(|| "Open Dock deck config is unavailable".to_owned())
}

#[tauri::command]
fn list_open_dock_plugins(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<OpenDockPluginListing, String> {
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are still starting".to_owned())?;
    let root = open_dock_plugins_path(&config_dir);
    if !root.exists() {
        return Ok(OpenDockPluginListing {
            plugins: Vec::new(),
            warnings: Vec::new(),
        });
    }
    let mut plugins = Vec::new();
    let mut warnings = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| "Could not list Open Dock plugins".to_owned())? {
        let Ok(entry) = entry else {
            warnings.push("Could not read one entry in Open Dock's plugin folder.".to_owned());
            continue;
        };
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            warnings.push(format!(
                "Could not inspect plugin folder '{}'.",
                entry.file_name().to_string_lossy()
            ));
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let (manifest, _) = match read_open_dock_plugin_manifest(&entry.path()) {
            Ok(manifest) => manifest,
            Err(error) => {
                warnings.push(format!(
                    "Plugin '{}': {error}",
                    entry.file_name().to_string_lossy()
                ));
                continue;
            }
        };
        if entry.file_name().to_string_lossy() != manifest.id {
            warnings.push(format!(
                "Plugin '{}': folder name does not match its manifest id.",
                manifest.name
            ));
            continue;
        }
        if let Err(error) = plugin_scripts(&entry.path(), &manifest) {
            warnings.push(format!("Plugin '{}': {error}", manifest.name));
            continue;
        }
        plugins.push(InstalledOpenDockPlugin {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            actions: manifest.actions,
            widgets: manifest.widgets,
        });
    }
    plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(OpenDockPluginListing { plugins, warnings })
}

#[tauri::command]
fn install_open_dock_plugin(
    source_path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<InstalledOpenDockPlugin, String> {
    let source = PathBuf::from(source_path)
        .canonicalize()
        .map_err(|_| "Choose an existing Open Dock plugin folder".to_owned())?;
    if !source.is_dir() {
        return Err("Choose a folder containing manifest.json and scripts/".into());
    }
    let (manifest, manifest_bytes) = read_open_dock_plugin_manifest(&source)?;
    let scripts = plugin_scripts(&source, &manifest)?;
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are still starting".to_owned())?;
    let plugins_dir = open_dock_plugins_path(&config_dir);
    fs::create_dir_all(&plugins_dir)
        .map_err(|_| "Could not prepare Open Dock's plugin folder".to_owned())?;
    let target = plugins_dir.join(&manifest.id);
    if target.exists() {
        return Err(
            "A Open Dock plugin with this id is already installed. Remove it before reinstalling."
                .into(),
        );
    }
    fs::create_dir_all(target.join("scripts"))
        .map_err(|_| "Could not create the installed plugin folder".to_owned())?;
    let install_result = (|| {
        for (source, file_name) in scripts {
            fs::copy(source, target.join("scripts").join(file_name))
                .map_err(|_| "Could not install a plugin script".to_owned())?;
        }
        fs::write(target.join("manifest.json"), manifest_bytes)
            .map_err(|_| "Could not install the plugin manifest".to_owned())
    })();
    if let Err(error) = install_result {
        let _ = fs::remove_dir_all(&target);
        return Err(error);
    }
    Ok(InstalledOpenDockPlugin {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        actions: manifest.actions,
        widgets: manifest.widgets,
    })
}

#[tauri::command]
fn uninstall_open_dock_plugin(
    plugin_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if !valid_plugin_id(&plugin_id) {
        return Err("Invalid Open Dock plugin id".into());
    }
    let config = state
        .deck_config
        .read()
        .map_err(|_| "Open Dock deck config is unavailable".to_owned())?;
    if plugin_is_used(&config, &plugin_id) {
        return Err(
            "Change or remove this plugin's deck buttons or widgets before uninstalling it".into(),
        );
    }
    drop(config);
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are still starting".to_owned())?;
    let target = open_dock_plugins_path(&config_dir).join(plugin_id);
    if target.exists() {
        fs::remove_dir_all(target).map_err(|_| "Could not remove the Open Dock plugin".to_owned())?;
    }
    Ok(())
}

#[tauri::command]
fn pending_legacy_imports(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<LegacyImportSummary>, String> {
    state
        .legacy_offers
        .read()
        .map(|offers| offers.values().cloned().collect())
        .map_err(|_| "Pending phone imports are unavailable".to_owned())
}

#[tauri::command]
fn request_legacy_deck_import(
    source_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut offers = state
        .legacy_offers
        .write()
        .map_err(|_| "Pending phone imports are unavailable".to_owned())?;
    let offer = offers
        .get_mut(&source_id)
        .ok_or_else(|| "This phone is no longer connected".to_owned())?;
    if offer.ready {
        return Ok(());
    }
    offer.requested = true;
    let _ = state.legacy_requests.send(source_id);
    Ok(())
}

#[tauri::command]
fn import_legacy_deck(
    source_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DeckConfig, String> {
    let pending = state
        .pending_legacy
        .read()
        .map_err(|_| "Pending phone imports are unavailable".to_owned())?
        .get(&source_id)
        .cloned()
        .ok_or_else(|| "This phone deck import is no longer available".to_owned())?;
    if !state
        .legacy_offers
        .read()
        .map_err(|_| "Pending phone imports are unavailable".to_owned())?
        .get(&source_id)
        .is_some_and(|offer| offer.ready)
    {
        return Err("Request the phone deck transfer before importing it".into());
    }
    validate_legacy_deck(&pending)?;
    let mut config = state
        .deck_config
        .write()
        .map_err(|_| "Open Dock deck config is unavailable".to_owned())?;
    let mut profile_name = "Imported phone deck".to_owned();
    let mut suffix = 2;
    while config
        .profiles
        .iter()
        .any(|profile| profile.name.eq_ignore_ascii_case(&profile_name))
    {
        profile_name = format!("Imported phone deck {suffix}");
        suffix += 1;
    }
    let profile_id = format!("import-{}", pending.source_id);
    if config
        .profiles
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err("This phone deck was already imported".into());
    }
    let pages: Vec<DeckPage> = pending
        .pages
        .iter()
        .enumerate()
        .map(|(page_index, page)| {
            let name: String = page.name.trim().chars().take(24).collect();
            let buttons: Result<Vec<DeckButton>, String> = page
                .shortcuts
                .iter()
                .enumerate()
                .map(|(button_index, shortcut)| {
                    let action = match shortcut.kind.as_deref().unwrap_or("hotkey") {
                        "hotkey" => DeckAction::Hotkey {
                            keys: shortcut.keys.clone().unwrap_or_default(),
                        },
                        "launch_app" => DeckAction::LaunchApp {
                            app: shortcut.app.clone().unwrap_or_default(),
                        },
                        "sequence" => DeckAction::Sequence {
                            steps: shortcut
                                .steps
                                .clone()
                                .unwrap_or_default()
                                .into_iter()
                                .map(|keys| DeckStep::Hotkey { keys })
                                .collect(),
                        },
                        _ => return Err("A phone deck contains an unsupported action".into()),
                    };
                    Ok(DeckButton {
                        id: format!("imp{}b{}", page_index, button_index),
                        label: shortcut.label.trim().chars().take(24).collect(),
                        icon: shortcut
                            .icon
                            .as_deref()
                            .filter(|icon| {
                                [
                                    "command",
                                    "monitor",
                                    "music",
                                    "mic",
                                    "headphones",
                                    "app-window",
                                ]
                                .contains(icon)
                            })
                            .unwrap_or("command")
                            .to_owned(),
                        placement: Some(DeckPlacement {
                            row: (button_index / 3) as u8,
                            column: (button_index % 3) as u8,
                            row_span: 1,
                            column_span: 1,
                        }),
                        icon_svg: None,
                        app_icon_data: None,
                        action,
                        long_press: None,
                    })
                })
                .collect();
            Ok(DeckPage {
                id: format!("impp{page_index}"),
                name: if name.is_empty() {
                    format!("Page {}", page_index + 1)
                } else {
                    name
                },
                rows: 4,
                columns: 3,
                buttons: buttons?,
                widgets: Vec::new(),
                folders: Vec::new(),
                widget_area: None,
            })
        })
        .collect::<Result<_, String>>()?;
    let active_page_id = pages
        .first()
        .map(|page| page.id.clone())
        .ok_or_else(|| "Phone deck has no pages".to_owned())?;
    config.profiles.push(DeckProfile {
        id: profile_id,
        name: profile_name,
        pages,
        default_page_id: active_page_id.clone(),
        active_page_id,
        auto_switch_apps: Vec::new(),
        auto_switch_enabled: false,
        widget_screen: None,
    });
    config.active_profile_id = format!("import-{}", pending.source_id);
    config.revision = config.revision.saturating_add(1);
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are unavailable".to_owned())?;
    save_deck_config_file(&config_dir.join("deck-config.json"), &config)?;
    let result = config.clone();
    drop(config);
    state
        .pending_legacy
        .write()
        .map_err(|_| "Pending phone imports are unavailable".to_owned())?
        .remove(&source_id);
    state
        .legacy_offers
        .write()
        .map_err(|_| "Pending phone imports are unavailable".to_owned())?
        .remove(&source_id);
    let _ = state.deck_updates.send((String::new(), result.clone()));
    Ok(result)
}

fn validate_legacy_deck(deck: &LegacyPhonePageSet) -> Result<(), String> {
    if !valid_id(&deck.source_id)
        || deck.source_id.len() > 56
        || deck.pages.is_empty()
        || deck.pages.len() > 8
    {
        return Err("Phone deck import is invalid".into());
    }
    for page in &deck.pages {
        if !valid_label(&page.name, 128) || page.shortcuts.len() > 12 {
            return Err("Phone deck import has invalid pages or too many buttons".into());
        }
        for shortcut in &page.shortcuts {
            if !valid_label(&shortcut.label, 128) {
                return Err("Phone deck import contains an invalid button label".into());
            }
            let action = match shortcut.kind.as_deref().unwrap_or("hotkey") {
                "hotkey" => DeckAction::Hotkey {
                    keys: shortcut.keys.clone().unwrap_or_default(),
                },
                "launch_app" => DeckAction::LaunchApp {
                    app: shortcut.app.clone().unwrap_or_default(),
                },
                "sequence" => DeckAction::Sequence {
                    steps: shortcut
                        .steps
                        .clone()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|keys| DeckStep::Hotkey { keys })
                        .collect(),
                },
                _ => return Err("Phone deck import contains an unsupported action".into()),
            };
            validate_action(&action)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn save_deck_config(
    mut config: DeckConfig,
    device_id: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DeckConfig, String> {
    normalize_deck_layout(&mut config);
    validate_deck_config(&config)?;
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are unavailable".to_owned())?;
    let device_id = device_id.unwrap_or_default();
    if !device_id.is_empty() {
        if !valid_id(&device_id) {
            return Err("Unknown device".into());
        }
        let base = get_deck_config(&state).map_or(0, |shared| shared.revision);
        let mut decks = state
            .device_decks
            .write()
            .map_err(|_| "Open Dock deck config is unavailable".to_owned())?;
        config.revision = decks.get(&device_id).map_or(base, |own| own.revision).saturating_add(1);
        save_device_deck_file(&config_dir, &device_id, &config)?;
        decks.insert(device_id.clone(), config.clone());
        let _ = state.deck_updates.send((device_id, config.clone()));
        return Ok(config);
    }
    let mut current = state
        .deck_config
        .write()
        .map_err(|_| "Open Dock deck config is unavailable".to_owned())?;
    config.revision = current.revision.saturating_add(1);
    save_deck_config_file(&config_dir.join("deck-config.json"), &config)?;
    *current = config.clone();
    let _ = state.deck_updates.send((String::new(), config.clone()));
    Ok(config)
}

#[derive(Clone, Debug)]
struct ForegroundApp {
    identity: String,
    path: String,
}

#[cfg(target_os = "windows")]
fn foreground_app() -> Option<ForegroundApp> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    unsafe {
        let window = GetForegroundWindow();
        if window.is_invalid() {
            return None;
        }
        let mut process_id = 0;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        if process_id == 0 || process_id == std::process::id() {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut buffer = [0u16; 32_768];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        let path = String::from_utf16(&buffer[..length as usize]).ok()?;
        Some(ForegroundApp {
            identity: path.clone(),
            path,
        })
    }
}

#[cfg(target_os = "macos")]
fn foreground_app() -> Option<ForegroundApp> {
    use objc2_app_kit::NSWorkspace;

    let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let identity = app.bundleIdentifier()?.to_string();
    if identity == "app.opendock.pc" {
        return None;
    }
    let path = app.bundleURL()?.path()?.to_string();
    Some(ForegroundApp { identity, path })
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn foreground_app() -> Option<ForegroundApp> {
    None
}

fn app_target_matches(target: &str, foreground: &ForegroundApp) -> bool {
    let target = target.trim();
    if target.eq_ignore_ascii_case(&foreground.identity)
        || target.eq_ignore_ascii_case(&foreground.path)
    {
        return true;
    }
    let target_name = Path::new(target).file_stem().and_then(|name| name.to_str());
    let foreground_name = Path::new(&foreground.path)
        .file_stem()
        .and_then(|name| name.to_str());
    target_name
        .is_some_and(|target| foreground_name.is_some_and(|name| target.eq_ignore_ascii_case(name)))
}

fn switch_profile_for_foreground(state: &AppState, foreground: &ForegroundApp) {
    let Ok(mut config) = state.deck_config.write() else {
        return;
    };
    if !config
        .profiles
        .iter()
        .any(|profile| profile.auto_switch_enabled)
    {
        return;
    }
    let matched_profile_id = config
        .profiles
        .iter()
        .filter(|profile| profile.auto_switch_enabled)
        .find_map(|profile| {
            profile
                .auto_switch_apps
                .iter()
                .any(|target| app_target_matches(target, foreground))
                .then(|| profile.id.clone())
        });
    let target_id =
        if let Some(profile_id) = matched_profile_id {
            profile_id
        } else {
            if !config.profiles.iter().any(|profile| {
                profile.id == config.active_profile_id && profile.auto_switch_enabled
            }) {
                return;
            }
            if config
                .profiles
                .iter()
                .any(|profile| profile.id == config.fallback_profile_id)
            {
                config.fallback_profile_id.clone()
            } else {
                config.profiles[0].id.clone()
            }
        };
    if config.active_profile_id == target_id {
        return;
    }
    config.active_profile_id = target_id.clone();
    config.revision = config.revision.saturating_add(1);
    let config_dir = state
        .config_dir
        .read()
        .ok()
        .and_then(|directory| directory.clone());
    let Some(config_dir) = config_dir else { return };
    if let Err(error) = save_deck_config_file(&config_dir.join("deck-config.json"), &config) {
        eprintln!("Could not save automatic profile switch: {error}");
        return;
    }
    let _ = state.deck_updates.send((String::new(), config.clone()));
    let _ = state.auto_profile_updates.send(target_id);
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct InstalledApp {
    name: String,
    path: String,
}

/// Apps found under `roots`: `.app` bundles on macOS, Start Menu `.lnk` shortcuts on Windows. Folders are
/// searched `depth` levels down; bundles are not entered. Helper shortcuts (uninstallers, readmes, help)
/// are left out, and when two entries share a name the first one found wins.
fn scan_apps(roots: &[PathBuf], extension: &str, depth: usize, skip_helpers: bool) -> Vec<InstalledApp> {
    const HELPER_WORDS: &[&str] = &["uninstall", "readme", "release notes", "documentation", "help", "website", "manual", "license", "changelog"];
    fn visit(dir: &Path, extension: &str, depth: usize, skip_helpers: bool, found: &mut Vec<InstalledApp>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let matches = path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case(extension));
            if matches {
                let name = path.file_stem().and_then(|value| value.to_str()).unwrap_or_default().trim().to_owned();
                let lower = name.to_lowercase();
                if name.is_empty() || (skip_helpers && HELPER_WORDS.iter().any(|word| lower.contains(word))) {
                    continue;
                }
                if let Some(text) = path.to_str().filter(|text| text.len() <= 512 && !text.chars().any(char::is_control)) {
                    found.push(InstalledApp { name, path: text.to_owned() });
                }
            } else if depth > 0 && path.is_dir() && !path.is_symlink() {
                visit(&path, extension, depth - 1, skip_helpers, found);
            }
        }
    }
    let mut found = Vec::new();
    for root in roots {
        visit(root, extension, depth, skip_helpers, &mut found);
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|app| seen.insert(app.name.to_lowercase()));
    found.sort_by_key(|app| app.name.to_lowercase());
    found.truncate(2000);
    found
}

#[tauri::command]
async fn list_installed_apps() -> Result<Vec<InstalledApp>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            let mut roots = vec![PathBuf::from("/Applications"), PathBuf::from("/System/Applications")];
            if let Some(home) = std::env::var_os("HOME") {
                roots.push(PathBuf::from(home).join("Applications"));
            }
            scan_apps(&roots, "app", 2, false)
        }
        #[cfg(windows)]
        {
            // The Start menu's own list, which includes Store apps. The shortcut scan is the fallback.
            if let Ok(found) = win_apps::list() {
                let apps: Vec<InstalledApp> = win_apps::tidy(found)
                    .into_iter()
                    .map(|(name, id)| InstalledApp { name, path: win_apps::target(&id) })
                    .filter(|app| app.path.len() <= 512 && !app.path.chars().any(char::is_control))
                    .take(2000)
                    .collect();
                if !apps.is_empty() {
                    return apps;
                }
            }
            let roots: Vec<PathBuf> = ["ProgramData", "APPDATA"]
                .iter()
                .filter_map(|name| std::env::var_os(name))
                .map(|base| PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs"))
                .collect();
            scan_apps(&roots, "lnk", 4, true)
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            Vec::new()
        }
    })
    .await
    .map_err(|_| "Could not read the installed apps".to_owned())
}

static ICON_CACHE: std::sync::Mutex<Option<icon_png::IconCache>> = std::sync::Mutex::new(None);

/// Reads an icon once per file and version of that file. Runs on a worker thread, never the window's.
fn cached_icon(path: &str, variant: bool, read: impl FnOnce() -> Result<String, String>) -> Result<String, String> {
    let modified = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_nanos());
    let key = icon_png::IconCache::key(path, variant, modified);
    let hit = ICON_CACHE.lock().ok().and_then(|cache| cache.as_ref().and_then(|entries| entries.get(&key)));
    if let Some(icon) = hit {
        return Ok(icon);
    }
    let icon = read()?;
    if let Ok(mut cache) = ICON_CACHE.lock() {
        cache.get_or_insert_with(Default::default).insert(key, icon.clone());
    }
    Ok(icon)
}

// The flag is Windows-only; renaming it would change the argument name the front end sends.
#[tauri::command]
async fn extract_app_icon(app: String, use_shortcut_icon: bool) -> Result<String, String> {
    // A PowerShell or shell call can take a second, so it runs off the window's thread.
    tauri::async_runtime::spawn_blocking(move || {
        let path = app.clone();
        cached_icon(&path, use_shortcut_icon, || read_app_icon(app, use_shortcut_icon))
    })
    .await
    .map_err(|_| "Could not read the application icon".to_owned())?
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn read_app_icon(app: String, use_shortcut_icon: bool) -> Result<String, String> {
    if app.trim().is_empty() || app.len() > 512 || app.chars().any(char::is_control) {
        return Err("Enter a valid app path".into());
    }
    #[cfg(target_os = "windows")]
    {
        let in_shell = app.starts_with(win_apps::SHELL_PREFIX);
        if !in_shell && !Path::new(&app).is_file() {
            return Err("Choose an existing application file".into());
        }
        // The shell reads the icon in this process: no console window, no wait for PowerShell to start. Only a
        // shortcut's *target* icon (the "reset to app icon" case) still needs the script below, as does any
        // file the shell cannot read.
        let is_shortcut = Path::new(&app).extension().is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"));
        if use_shortcut_icon || !is_shortcut || in_shell {
            // 65_500 base64 characters is the most an icon may take; that is 3 bytes of PNG for every 4.
            if let Ok(png) = win_icon::app_icon_png(&app, 65_500 / 4 * 3) {
                use base64::Engine;
                let encoded = base64::engine::general_purpose::STANDARD.encode(png);
                if encoded.len() <= 65_500 {
                    return Ok(format!("data:image/png;base64,{encoded}"));
                }
            }
        }
        if in_shell {
            return Err("Windows has no icon for that app".into());
        }
        let script = r#"
Add-Type -AssemblyName System.Drawing
$path = $env:OPEN_DOCK_APP_PATH
$icon = $null
$iconHandle = [IntPtr]::Zero
$smallHandle = [IntPtr]::Zero
if ([IO.Path]::GetExtension($path) -ieq '.lnk') {
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  if ($env:OPEN_DOCK_USE_SHORTCUT_ICON -eq '1') {
    $location = [Environment]::ExpandEnvironmentVariables($link.IconLocation)
    if ($location -match '^(.*),\s*(-?\d+)$') {
      $iconPath = $Matches[1].Trim().Trim('"')
      $iconIndex = [int]$Matches[2]
    } else {
      $iconPath = $location.Trim().Trim('"')
      $iconIndex = 0
    }
    if ($iconPath -and (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenDockIconExtractor {
  [DllImport("shell32.dll", EntryPoint = "ExtractIconExW", CharSet = CharSet.Unicode)]
  public static extern uint ExtractIconEx(string file, int index, out IntPtr large, out IntPtr small, uint count);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr icon);
}
'@
      $count = [OpenDockIconExtractor]::ExtractIconEx($iconPath, $iconIndex, [ref]$iconHandle, [ref]$smallHandle, 1)
      if ($count -gt 0 -and $iconHandle -ne [IntPtr]::Zero) { $icon = [System.Drawing.Icon]::FromHandle($iconHandle) }
    }
  }
  if ($null -eq $icon -and $link.TargetPath -and (Test-Path -LiteralPath $link.TargetPath -PathType Leaf)) {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($link.TargetPath)
  }
} else {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
}
if ($null -eq $icon) { exit 2 }
$bitmap = $icon.ToBitmap()
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
$bitmap.Dispose()
$stream.Dispose()
if ($iconHandle -ne [IntPtr]::Zero) { $null = [OpenDockIconExtractor]::DestroyIcon($iconHandle) }
if ($smallHandle -ne [IntPtr]::Zero) { $null = [OpenDockIconExtractor]::DestroyIcon($smallHandle) }
"#;
        let output = quiet(&mut Command::new("powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("OPEN_DOCK_APP_PATH", &app)
            .env(
                "OPEN_DOCK_USE_SHORTCUT_ICON",
                if use_shortcut_icon { "1" } else { "0" },
            )
            .output()
            .map_err(|_| "Could not read the application icon".to_owned())?;
        if !output.status.success() {
            return Err("Windows could not read an icon from that application".into());
        }
        let encoded = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if encoded.is_empty() || encoded.len() > 65_500 {
            return Err("The application icon is too large to use".into());
        }
        return Ok(format!("data:image/png;base64,{encoded}"));
    }
    #[cfg(target_os = "macos")]
    {
        let bundle = Path::new(&app);
        if !bundle.is_dir() {
            return Err("Choose a macOS .app bundle to extract its icon".into());
        }
        let resources = bundle.join("Contents/Resources");
        let info = bundle.join("Contents/Info.plist");
        let declared = Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleIconFile", "raw", "-o", "-"])
            .arg(&info)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
        let declared_path = declared
            .filter(|name| !name.is_empty() && Path::new(name).file_name().is_some())
            .map(|name| {
                resources.join(if name.ends_with(".icns") {
                    name
                } else {
                    format!("{name}.icns")
                })
            })
            .filter(|path| path.is_file());
        let icon = declared_path
            .or_else(|| {
                fs::read_dir(&resources)
                    .ok()?
                    .flatten()
                    .map(|entry| entry.path())
                    .find(|path| {
                        path.extension()
                            .is_some_and(|extension| extension.eq_ignore_ascii_case("icns"))
                    })
            })
            .ok_or_else(|| "No .icns file was found in this app bundle".to_owned())?;
        let temp = std::env::temp_dir().join(format!("open-dock-icon-{}.png", rand::random::<u64>()));
        let converted = Command::new("/usr/bin/sips")
            .args(["-s", "format", "png", "--resampleWidth", "128"])
            .arg(&icon)
            .arg("--out")
            .arg(&temp)
            .output()
            .map_err(|_| "Could not convert the macOS app icon".to_owned())?;
        if !converted.status.success() {
            return Err("Could not convert the macOS app icon".into());
        }
        let encoded = Command::new("/usr/bin/base64")
            .arg("-i")
            .arg(&temp)
            .output()
            .map_err(|_| "Could not encode the macOS app icon".to_owned());
        let _ = fs::remove_file(&temp);
        let encoded = encoded?;
        if !encoded.status.success() || encoded.stdout.len() > 65_500 {
            return Err("The application icon is too large to use".into());
        }
        let data = String::from_utf8_lossy(&encoded.stdout)
            .replace('\n', "")
            .replace('\r', "");
        return Ok(format!("data:image/png;base64,{data}"));
    }
    #[allow(unreachable_code)]
    Err("Original app icons are not supported on this platform".into())
}

#[tauri::command]
fn get_autostart() -> bool {
    remote::autostart_enabled()
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    remote::set_autostart(enabled)
}

#[tauri::command]
fn enable_android_usb(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    ensure_android_usb_reverse()?;
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are unavailable".to_owned())?;
    fs::write(config_dir.join("android-usb-enabled"), "true")
        .map_err(|_| "Could not save the Android USB setting".to_owned())?;
    state.android_usb_enabled.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn rotate_pairing_key(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are unavailable".to_owned())?;
    let token = create_pairing_key();
    save_pairing_key(&config_dir.join("pairing-key"), &token)?;
    *state
        .token
        .write()
        .map_err(|_| "Open Dock pairing key is unavailable".to_owned())? = token;
    state.session_epoch.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

fn ensure_android_usb_reverse() -> Result<usb_pair::Phone, String> {
    let adb = adb::find().ok_or_else(|| adb::MISSING.to_owned())?;
    let timeout = Duration::from_secs(15);
    let devices = adb::run(&adb, &["devices", "-l"], timeout).map_err(|error| {
        // A vanished or stuck adb is looked up again next time.
        adb::forget();
        error
    })?;
    if !devices.status.success() {
        return Err("Android Debug Bridge could not list connected devices".into());
    }
    let phone = usb_pair::parse_devices(&String::from_utf8_lossy(&devices.stdout))?;
    let forwards = adb::run(&adb, &["reverse", "--list"], timeout)
        .map_err(|_| "Android Debug Bridge could not check USB forwarding".to_owned())?;
    if forwards.status.success()
        && String::from_utf8_lossy(&forwards.stdout).contains("tcp:39421 tcp:39421")
    {
        return Ok(phone);
    }
    let reverse = adb::run(&adb, &["reverse", "tcp:39421", "tcp:39421"], timeout)
        .map_err(|_| "Android Debug Bridge could not configure USB forwarding".to_owned())?;
    if !reverse.status.success() {
        let detail = String::from_utf8_lossy(&reverse.stderr);
        return Err(if detail.trim().is_empty() {
            "Android USB port forwarding failed".into()
        } else {
            detail.trim().to_owned()
        });
    }
    Ok(phone)
}

/// Keeps the USB cable working: forwards the port, and hands the pairing to a trusted phone that is not connected.
fn run_usb_monitor(state: Arc<AppState>) {
    let mut pairing = usb_pair::Pairing::default();
    let mut last_error = String::new();
    let show = |status: &str, phone: &str, detail: &str| {
        if let Ok(mut panel) = state.usb_panel.write() {
            *panel = UsbPanel { status: status.to_owned(), phone: phone.to_owned(), detail: detail.to_owned() };
        }
    };
    loop {
        thread::sleep(Duration::from_secs(3));
        if !state.android_usb_enabled.load(Ordering::Relaxed) {
            show("off", "", "");
            continue;
        }
        let phone = match ensure_android_usb_reverse() {
            Ok(phone) => phone,
            Err(error) => {
                pairing.lost();
                last_error.clear();
                let status = if error == adb::MISSING {
                    "no_adb"
                } else if error.contains("allow USB debugging") {
                    "unauthorized"
                } else if error.starts_with("Connect one") {
                    "no_phone"
                } else {
                    "error"
                };
                show(status, "", if status == "error" { &error } else { "" });
                if error == adb::MISSING {
                    // No adb on this PC: searching for it spawns processes, so look again in 30 s, not 3.
                    thread::sleep(Duration::from_secs(27));
                }
                continue;
            }
        };
        let now = Instant::now();
        if state.usb_retry.swap(false, Ordering::Relaxed) {
            pairing.retry(now);
            last_error.clear();
        }
        let connected = state.usb_clients.load(Ordering::Relaxed) > 0;
        if pairing.should_send(&phone.serial, connected, now) {
            let token = state.token.read().map(|token| token.clone()).unwrap_or_default();
            let link = usb_pair::pair_link(&state.host, PORT, &token, &pc_name(&state));
            last_error = match adb::find().ok_or_else(|| adb::MISSING.to_owned()).and_then(|adb| usb_pair::send_link(&adb, &phone.serial, &link)) {
                Ok(()) => String::new(),
                Err(error) => error,
            };
        }
        if connected {
            last_error.clear();
        }
        show(pairing.status(connected, now), &phone.model, &last_error);
    }
}

#[tauri::command]
fn retry_android_usb(state: tauri::State<'_, Arc<AppState>>) {
    state.usb_retry.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn adb_status() -> adb::Status {
    adb::status()
}

#[tauri::command]
async fn install_adb(app: tauri::AppHandle) -> Result<(), String> {
    adb::install(app).await.map(|_| ())
}

fn create_pairing_key() -> String {
    let mut secret = [0_u8; 32];
    rand::rng().fill_bytes(&mut secret);
    secret.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn machine_name() -> String {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| {
            quiet(&mut Command::new("hostname"))
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        })
        .unwrap_or_else(|| "Open Dock PC".to_owned());
    let cleaned: String = name
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "Open Dock PC".to_owned()
    } else {
        cleaned
    }
}

fn save_pairing_key(path: &Path, token: &str) -> Result<(), String> {
    fs::write(path, token).map_err(|_| "Could not save the Open Dock pairing key".to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Could not secure the Open Dock pairing key".to_owned())?;
    }
    Ok(())
}

fn load_or_create_pairing_key(path: &Path) -> Result<String, String> {
    if let Ok(saved) = fs::read_to_string(path) {
        let token = saved.trim();
        if token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(token.to_owned());
        }
    }
    let token = create_pairing_key();
    save_pairing_key(path, &token)?;
    Ok(token)
}

async fn upgrade_socket(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // A phone on the USB cable arrives through adb's port forward, so it looks like it is on this PC.
    let over_usb = peer.ip().is_loopback();
    ws.max_message_size(MAX_DECK_CONFIG_BYTES + 65_536)
        .max_frame_size(MAX_DECK_CONFIG_BYTES + 65_536)
        .on_upgrade(move |socket| handle_socket(socket, state, over_usb, peer.ip()))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, over_usb: bool, peer_ip: std::net::IpAddr) {
    let mut authenticated = false;
    // 1: phones that know buttons and widget areas only. 2: phones that draw widgets on the page grid and open folders.
    let mut protocol: u32 = 1;
    let mut supports_independent_navigation = false;
    let mut device_id = String::new();
    let mut selected_profile_id = String::new();
    let mut selected_page_id = String::new();
    let mut session_epoch = 0;
    let mut last_media_content: Option<system_media::SystemMediaState> = None;
    let mut deck_updates = state.deck_updates.subscribe();
    let mut media_updates = state.media_state.subscribe();
    let mut navigation_updates = state.navigation_updates.subscribe();
    let mut auto_profile_updates = state.auto_profile_updates.subscribe();
    let mut legacy_requests = state.legacy_requests.subscribe();
    let mut legacy_source_id: Option<String> = None;
    // Playback state is checked every 500 ms, and every 100 ms for 2 s after this phone sends a
    // control, so the play/pause button settles quickly.
    let mut next_playback_check = tokio::time::Instant::now();
    let mut fast_checks_until = tokio::time::Instant::now();
    let mut last_playback_state = None;
    // The phone is told the state again every few seconds even when it has not changed, so a wrong guess it
    // made when a control was pressed cannot last.
    let mut last_playback_sent_at: Option<std::time::Instant> = None;
    let mut last_players_sent: Option<media_players::PlayersSnapshot> = None;
    // The last playback position this phone was sent; positions in between it counts forward itself.
    let mut progress_sent: Option<system_media::ProgressSent> = None;
    // False while the phone app is in the background (it sends set_streaming): nothing is sent and
    // playback isn't checked, so the phone's radio and the PC both rest.
    let mut streaming = true;
    let mut pc_stats_updates = state.pc_stats.subscribe();
    // The readings this phone's visible stats widgets show (it sends pc_stats_subscribe), and whether
    // it has had the whole minute since asking.
    let connection_id = state.next_connection.fetch_add(1, Ordering::Relaxed);
    let mut pc_stats_needs = pc_stats::Needs::default();
    let mut pc_stats_history_sent = false;
    loop {
        let incoming = tokio::select! {
            message = socket.recv() => message,
            update = deck_updates.recv(), if authenticated => {
                match update {
                    Ok((target, config)) => {
                        if target != deck_key(&state, &device_id) {
                            continue;
                        }
                        if !state.independent_navigation.load(Ordering::Relaxed) {
                            selected_profile_id = config.active_profile_id.clone();
                            selected_page_id = config.profiles.iter().find(|profile| profile.id == selected_profile_id).map(|profile| profile.active_page_id.clone()).unwrap_or_default();
                        }
                        let message = device_deck_snapshot(protocol, &config, state.independent_navigation.load(Ordering::Relaxed), &mut selected_profile_id, &mut selected_page_id);
                        if socket.send(Message::Text(message.to_string().into())).await.is_err() { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(config) = device_config(&state, &device_id) {
                            if !state.independent_navigation.load(Ordering::Relaxed) {
                                selected_profile_id = config.active_profile_id.clone();
                                selected_page_id = config.profiles.iter().find(|profile| profile.id == selected_profile_id).map(|profile| profile.active_page_id.clone()).unwrap_or_default();
                            }
                            let message = device_deck_snapshot(protocol, &config, state.independent_navigation.load(Ordering::Relaxed), &mut selected_profile_id, &mut selected_page_id);
                            if socket.send(Message::Text(message.to_string().into())).await.is_err() { break; }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
                continue;
            }
            mode = navigation_updates.recv(), if authenticated => {
                match mode {
                    Ok(true) if !supports_independent_navigation => {
                        let _ = socket.send(Message::Text(r#"{"type":"error","message":"update_required","protocolVersion":2}"#.into())).await;
                        break;
                    }
                    Ok(enabled) => {
                        if let Some(config) = device_config(&state, &device_id) {
                            if !enabled || selected_profile_id.is_empty() {
                                selected_profile_id = config.active_profile_id.clone();
                                selected_page_id = config.profiles.iter().find(|profile| profile.id == selected_profile_id).map(|profile| profile.active_page_id.clone()).unwrap_or_default();
                            }
                            let message = device_deck_snapshot(protocol, &config, enabled, &mut selected_profile_id, &mut selected_page_id);
                            if socket.send(Message::Text(message.to_string().into())).await.is_err() { break; }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(config) = device_config(&state, &device_id) {
                            let enabled = state.independent_navigation.load(Ordering::Relaxed);
                            let message = device_deck_snapshot(protocol, &config, enabled, &mut selected_profile_id, &mut selected_page_id);
                            if socket.send(Message::Text(message.to_string().into())).await.is_err() { break; }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
                continue;
            }
            profile_id = auto_profile_updates.recv(), if authenticated && state.independent_navigation.load(Ordering::Relaxed) => {
                match profile_id {
                    Ok(profile_id) => {
                        selected_profile_id = profile_id;
                        if let Some(config) = device_config(&state, &device_id) {
                            let message = device_deck_snapshot(protocol, &config, true, &mut selected_profile_id, &mut selected_page_id);
                            if socket.send(Message::Text(message.to_string().into())).await.is_err() { break; }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(config) = device_config(&state, &device_id) {
                            selected_profile_id = config.active_profile_id.clone();
                            selected_page_id = config.profiles.iter().find(|profile| profile.id == selected_profile_id).map(|profile| profile.active_page_id.clone()).unwrap_or_default();
                            let message = device_deck_snapshot(protocol, &config, true, &mut selected_profile_id, &mut selected_page_id);
                            if socket.send(Message::Text(message.to_string().into())).await.is_err() { break; }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
                continue;
            }
            request = legacy_requests.recv(), if authenticated => {
                match request {
                    Ok(source_id) if legacy_source_id.as_deref() == Some(source_id.as_str()) => {
                        let message = serde_json::json!({ "type": "legacy_deck_request", "sourceId": source_id });
                        if socket.send(Message::Text(message.to_string().into())).await.is_err() { break; }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
                continue;
            }
            _ = tokio::time::sleep_until(next_playback_check), if authenticated => {
                let now = tokio::time::Instant::now();
                next_playback_check = now + if !streaming { Duration::from_secs(5) } else if now < fast_checks_until { Duration::from_millis(100) } else { Duration::from_millis(500) };
                if state.session_epoch.load(Ordering::Relaxed) != session_epoch {
                    break;
                }
                if !streaming {
                    continue;
                }
                let playback_state = current_playback_state().await;
                let resend_due = last_playback_sent_at.is_none_or(|at| at.elapsed() >= Duration::from_secs(3));
                if last_playback_state != Some(playback_state) || resend_due {
                    let message = serde_json::json!({ "type": "playback_state", "state": playback_state });
                    if socket.send(Message::Text(message.to_string().into())).await.is_err() {
                        break;
                    }
                    last_playback_state = Some(playback_state);
                    last_playback_sent_at = Some(std::time::Instant::now());
                }
                // Which media players there are and which one the controls go to, whenever that changes.
                if let Some(players) = media_players::snapshot() {
                    if last_players_sent.as_ref() != Some(&players) {
                        let mut message = serde_json::to_value(&players).unwrap_or_default();
                        message["type"] = serde_json::json!("media_players");
                        if socket.send(Message::Text(message.to_string().into())).await.is_err() {
                            break;
                        }
                        last_players_sent = Some(players);
                    }
                }
                continue;
            }
            changed = pc_stats_updates.changed(), if authenticated => {
                if changed.is_err() { break; }
                let history = pc_stats_updates.borrow_and_update().clone();
                if pc_stats_needs == pc_stats::Needs::default() || history.is_empty() {
                    continue;
                }
                let message = if pc_stats_history_sent {
                    serde_json::json!({ "type": "pc_stats", "stats": history.back().map(pc_stats::PcStats::for_phone) })
                } else {
                    serde_json::json!({ "type": "pc_stats", "history": history.iter().map(pc_stats::PcStats::for_phone).collect::<Vec<_>>() })
                };
                pc_stats_history_sent = true;
                if socket.send(Message::Text(message.to_string().into())).await.is_err() {
                    break;
                }
                continue;
            }
            changed = media_updates.changed(), if authenticated => {
                if changed.is_err() { break; }
                if !streaming {
                    continue;
                }
                let media = media_updates.borrow().clone();
                let content_changed = last_media_content
                    .as_ref()
                    .is_none_or(|previous| !previous.same_content(&media));
                let now = std::time::Instant::now();
                let message = if content_changed {
                    last_media_content = Some(media.clone());
                    serde_json::json!({ "type": "media_state", "state": media })
                } else if system_media::progress_worth_sending(progress_sent.as_ref(), &media, now) {
                    serde_json::json!({ "type": "media_progress", "playbackState": media.playback_state, "positionMs": media.position_ms, "durationMs": media.duration_ms, "volumePercent": media.volume_percent, "playbackRate": media.playback_rate })
                } else {
                    continue;
                };
                progress_sent = Some(system_media::ProgressSent::new(&media, now));
                if socket.send(Message::Text(message.to_string().into())).await.is_err() {
                    break;
                }
                continue;
            }
        };
        let Some(Ok(message)) = incoming else {
            break;
        };
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else {
            let _ = socket
                .send(Message::Text(
                    r#"{"type":"error","message":"invalid_message"}"#.into(),
                ))
                .await;
            continue;
        };

        match message {
            ClientMessage::Authenticate {
                token,
                protocol_version,
                legacy_source_id: requested_source_id,
                legacy_deck_available,
                supports_independent_navigation: supports_navigation,
                selected_profile_id: requested_profile_id,
                selected_page_id: requested_page_id,
                device_id: requested_device_id,
                device_name: requested_device_name,
            } if !authenticated => {
                if !matches!(protocol_version, Some(1 | 2)) {
                    let _ = socket
                        .send(Message::Text(
                            r#"{"type":"error","message":"update_required","protocolVersion":2}"#
                                .into(),
                        ))
                        .await;
                    break;
                }
                if state
                    .token
                    .read()
                    .map(|current| *current != token)
                    .unwrap_or(true)
                {
                    let _ = socket
                        .send(Message::Text(
                            r#"{"type":"error","message":"unauthorized"}"#.into(),
                        ))
                        .await;
                    break;
                }
                let independent = state.independent_navigation.load(Ordering::Relaxed);
                if independent && !supports_navigation {
                    let _ = socket
                        .send(Message::Text(
                            r#"{"type":"error","message":"update_required","protocolVersion":2}"#
                                .into(),
                        ))
                        .await;
                    break;
                }
                supports_independent_navigation = supports_navigation;
                device_id = requested_device_id.filter(|id| valid_id(id)).unwrap_or_default();
                protocol = protocol_version.unwrap_or(1);
                if let Some(config) = device_config(&state, &device_id) {
                    selected_profile_id = requested_profile_id
                        .filter(|id| valid_id(id))
                        .unwrap_or_else(|| config.active_profile_id.clone());
                    selected_page_id =
                        requested_page_id
                            .filter(|id| valid_id(id))
                            .unwrap_or_else(|| {
                                config
                                    .profiles
                                    .iter()
                                    .find(|profile| profile.id == selected_profile_id)
                                    .map(|profile| profile.active_page_id.clone())
                                    .unwrap_or_default()
                            });
                    if !independent {
                        selected_profile_id = config.active_profile_id.clone();
                        selected_page_id = config
                            .profiles
                            .iter()
                            .find(|profile| profile.id == selected_profile_id)
                            .map(|profile| profile.active_page_id.clone())
                            .unwrap_or_default();
                    }
                }
                authenticated = true;
                session_epoch = state.session_epoch.load(Ordering::Relaxed);
                state.active_devices.fetch_add(1, Ordering::Relaxed);
                if !device_id.is_empty() {
                    register_device(&state, &device_id, requested_device_name.as_deref());
                    // A phone camera over Wi-Fi is reached at the address its deck link came from.
                    let phone_name = state.known_devices.read().ok().and_then(|devices| devices.get(&device_id).cloned()).unwrap_or_else(|| "Phone".to_owned());
                    camera::note_phone(&device_id, &phone_name, peer_ip);
                }
                if over_usb {
                    state.usb_clients.fetch_add(1, Ordering::Relaxed);
                }
                if legacy_deck_available {
                    if let Some(source_id) =
                        requested_source_id.filter(|id| valid_id(id) && id.len() <= 56)
                    {
                        let imported = state
                            .deck_config
                            .read()
                            .map(|config| {
                                config
                                    .profiles
                                    .iter()
                                    .any(|profile| profile.id == format!("import-{source_id}"))
                            })
                            .unwrap_or(false);
                        if !imported {
                            legacy_source_id = Some(source_id.clone());
                            if let Ok(mut offers) = state.legacy_offers.write() {
                                offers.insert(
                                    source_id.clone(),
                                    LegacyImportSummary {
                                        source_id,
                                        pages: 0,
                                        buttons: 0,
                                        requested: false,
                                        ready: false,
                                    },
                                );
                            }
                        }
                    }
                }
                if socket
                    .send(Message::Text(
                        serde_json::json!({ "type": "ready", "name": pc_name(&state) })
                            .to_string()
                            .into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
                if let Some(config) = device_config(&state, &device_id) {
                    let message = device_deck_snapshot(
                        protocol,
                        &config,
                        independent,
                        &mut selected_profile_id,
                        &mut selected_page_id,
                    );
                    if socket
                        .send(Message::Text(message.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                let playback_state = current_playback_state().await;
                let message =
                    serde_json::json!({ "type": "playback_state", "state": playback_state });
                if socket
                    .send(Message::Text(message.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
                let media = state.media_state.borrow().clone();
                last_media_content = Some(media.clone());
                let message = serde_json::json!({ "type": "media_state", "state": media });
                if socket
                    .send(Message::Text(message.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            ClientMessage::InvokeButton {
                request_id,
                revision,
                button_id,
                long_press,
            } if authenticated => {
                let result = if !valid_id(&request_id) || !valid_id(&button_id) {
                    Err("invalid_request".to_owned())
                } else {
                    invoke_button(
                        &state,
                        &deck_key(&state, &device_id),
                        revision,
                        &button_id,
                        long_press,
                        state.independent_navigation.load(Ordering::Relaxed),
                        &mut selected_profile_id,
                        &mut selected_page_id,
                    )
                };
                let stale_revision = matches!(&result, Err(error) if error == "stale_revision");
                let changed_selection = matches!(&result, Ok(true));
                // A button may be a media key (play/pause on the grid): show its effect quickly.
                if result.is_ok() {
                    state.media_refresh.notify_one();
                    fast_checks_until = tokio::time::Instant::now() + Duration::from_secs(2);
                    next_playback_check = tokio::time::Instant::now() + Duration::from_millis(60);
                }
                let reply = match result {
                    Ok(_) => {
                        serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": true })
                    }
                    Err(error) => {
                        let reason = if error == "stale_revision" || error == "unknown_button" {
                            error.as_str()
                        } else if error.starts_with("Could not launch app:") {
                            "app_launch_failed"
                        } else if error.to_lowercase().contains("permission") {
                            "accessibility_permission_required"
                        } else {
                            "control_failed"
                        };
                        serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": false, "reason": reason })
                    }
                };
                if socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
                if stale_revision {
                    if let Some(config) = device_config(&state, &device_id) {
                        let snapshot = device_deck_snapshot(
                            protocol,
                            &config,
                            state.independent_navigation.load(Ordering::Relaxed),
                            &mut selected_profile_id,
                            &mut selected_page_id,
                        );
                        if socket
                            .send(Message::Text(snapshot.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                } else if changed_selection && state.independent_navigation.load(Ordering::Relaxed)
                {
                    if let Some(config) = device_config(&state, &device_id) {
                        let snapshot = device_deck_snapshot(
                            protocol,
                            &config,
                            true,
                            &mut selected_profile_id,
                            &mut selected_page_id,
                        );
                        if socket
                            .send(Message::Text(snapshot.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            ClientMessage::InvokeMediaCommand {
                request_id,
                command,
            } if authenticated => {
                let result = if valid_id(&request_id) {
                    run_action(ClientAction::Media { command })
                } else {
                    Err("invalid_request".to_owned())
                };
                if result.is_ok() {
                    state.media_refresh.notify_one();
                    fast_checks_until = tokio::time::Instant::now() + Duration::from_secs(2);
                    next_playback_check = tokio::time::Instant::now() + Duration::from_millis(60);
                }
                let reply = match result {
                    Ok(()) => {
                        serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": true })
                    }
                    Err(_) => {
                        serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": false, "reason": "control_failed" })
                    }
                };
                if socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            ClientMessage::SetSystemVolume {
                request_id,
                volume_percent,
            } if authenticated => {
                let result = if valid_id(&request_id) && volume_percent <= 100 {
                    system_media::set_system_volume(volume_percent)
                } else {
                    Err("invalid_request".to_owned())
                };
                if result.is_ok() {
                    state.media_refresh.notify_one();
                    fast_checks_until = tokio::time::Instant::now() + Duration::from_secs(2);
                    next_playback_check = tokio::time::Instant::now() + Duration::from_millis(60);
                }
                let reply = match result {
                    Ok(()) => {
                        serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": true })
                    }
                    Err(_) => {
                        serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": false, "reason": "control_failed" })
                    }
                };
                if socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            ClientMessage::SelectProfile {
                request_id,
                revision,
                profile_id,
            } if authenticated => {
                let independent = state.independent_navigation.load(Ordering::Relaxed);
                let result = if valid_id(&request_id) {
                    if independent {
                        update_device_selection(
                            &state,
                            &deck_key(&state, &device_id),
                            revision,
                            Some(&profile_id),
                            None,
                            &mut selected_profile_id,
                            &mut selected_page_id,
                        )
                    } else {
                        update_selection(&state, &deck_key(&state, &device_id), revision, Some(&profile_id), None)
                    }
                } else {
                    Err("invalid_request".to_owned())
                };
                let stale_revision = matches!(&result, Err(error) if error == "stale_revision");
                let succeeded = result.is_ok();
                let reply = selection_reply(&request_id, result);
                if socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
                if independent && succeeded {
                    if let Some(config) = device_config(&state, &device_id) {
                        let snapshot = device_deck_snapshot(
                            protocol,
                            &config,
                            true,
                            &mut selected_profile_id,
                            &mut selected_page_id,
                        );
                        if socket
                            .send(Message::Text(snapshot.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
                if stale_revision {
                    if let Some(config) = device_config(&state, &device_id) {
                        let snapshot = device_deck_snapshot(
                            protocol,
                            &config,
                            independent,
                            &mut selected_profile_id,
                            &mut selected_page_id,
                        );
                        if socket
                            .send(Message::Text(snapshot.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            ClientMessage::SelectPage {
                request_id,
                revision,
                page_id,
            } if authenticated => {
                let independent = state.independent_navigation.load(Ordering::Relaxed);
                let result = if valid_id(&request_id) {
                    if independent {
                        update_device_selection(
                            &state,
                            &deck_key(&state, &device_id),
                            revision,
                            None,
                            Some(&page_id),
                            &mut selected_profile_id,
                            &mut selected_page_id,
                        )
                    } else {
                        update_selection(&state, &deck_key(&state, &device_id), revision, None, Some(&page_id))
                    }
                } else {
                    Err("invalid_request".to_owned())
                };
                let stale_revision = matches!(&result, Err(error) if error == "stale_revision");
                let succeeded = result.is_ok();
                let reply = selection_reply(&request_id, result);
                if socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
                if independent && succeeded {
                    if let Some(config) = device_config(&state, &device_id) {
                        let snapshot = device_deck_snapshot(
                            protocol,
                            &config,
                            true,
                            &mut selected_profile_id,
                            &mut selected_page_id,
                        );
                        if socket
                            .send(Message::Text(snapshot.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
                if stale_revision {
                    if let Some(config) = device_config(&state, &device_id) {
                        let snapshot = device_deck_snapshot(
                            protocol,
                            &config,
                            independent,
                            &mut selected_profile_id,
                            &mut selected_page_id,
                        );
                        if socket
                            .send(Message::Text(snapshot.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            ClientMessage::SeekMedia {
                request_id,
                position_ms,
            } if authenticated => {
                let duration_ms = state.media_state.borrow().duration_ms;
                let result = if valid_id(&request_id)
                    && duration_ms.is_some_and(|duration| position_ms <= duration)
                {
                    system_media::seek(position_ms).await
                } else {
                    Err("invalid_request".to_owned())
                };
                if result.is_ok() {
                    state.media_refresh.notify_one();
                    fast_checks_until = tokio::time::Instant::now() + Duration::from_secs(2);
                    next_playback_check = tokio::time::Instant::now() + Duration::from_millis(60);
                }
                let reply = match result {
                    Ok(()) => {
                        serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": true })
                    }
                    Err(_) => {
                        serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": false, "reason": "control_failed" })
                    }
                };
                if socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            ClientMessage::SetStreaming { active } if authenticated => {
                let resuming = active && !streaming;
                streaming = active;
                if resuming {
                    // Back in the foreground: one fresh snapshot of everything.
                    last_playback_state = None;
                    last_players_sent = None;
                    progress_sent = Some(system_media::ProgressSent::new(&state.media_state.borrow(), std::time::Instant::now()));
                    pc_stats_history_sent = false;
                    next_playback_check = tokio::time::Instant::now();
                    let media = state.media_state.borrow().clone();
                    last_media_content = Some(media.clone());
                    let message = serde_json::json!({ "type": "media_state", "state": media });
                    if socket.send(Message::Text(message.to_string().into())).await.is_err() {
                        break;
                    }
                }
            }
            ClientMessage::SelectMediaPlayer { player_id } if authenticated => {
                if player_id.as_deref().is_none_or(media_players::valid_player_id) {
                    media_players::set_preference(player_id);
                    // Read the players again right away and tell this phone what changed.
                    state.media_refresh.notify_one();
                    last_players_sent = None;
                    fast_checks_until = tokio::time::Instant::now() + Duration::from_secs(2);
                    next_playback_check = tokio::time::Instant::now() + Duration::from_millis(150);
                }
            }
            ClientMessage::Pointer { event } if authenticated => {
                if event.is_valid() {
                    remote::send_pointer(event);
                }
            }
            ClientMessage::VoiceState { listening, text } if authenticated => {
                island::show(if listening { "listening" } else { "idle" }, &text);
            }
            ClientMessage::VoiceCommand { request_id, text } if authenticated => {
                island::show("working", &text);
                let result = if valid_id(&request_id) && text.len() <= 500 { run_voice(&text, &state, state.independent_navigation.load(Ordering::Relaxed), &mut selected_profile_id, &mut selected_page_id).await } else { Err("That was too long".to_owned()) };
                if result.is_ok() {
                    state.media_refresh.notify_one();
                }
                match &result {
                    Ok(done) => island::show("done", done),
                    Err(error) => island::show("failed", error),
                }
                let reply = match result {
                    Ok(done) => serde_json::json!({ "type": "voice_result", "requestId": request_id, "ok": true, "done": done }),
                    Err(error) => serde_json::json!({ "type": "voice_result", "requestId": request_id, "ok": false, "error": error }),
                };
                if socket.send(Message::Text(reply.to_string().into())).await.is_err() {
                    break;
                }
            }
            ClientMessage::Signature { strokes } if authenticated => {
                let result = if remote::signature_is_valid(&strokes) {
                    tauri::async_runtime::spawn_blocking(move || remote::insert_signature(&strokes))
                        .await
                        .unwrap_or_else(|_| Err("Could not insert the signature".into()))
                } else {
                    Err("That signature is empty or too long".into())
                };
                let reply = match result {
                    Ok(_) => serde_json::json!({ "type": "signature_result", "ok": true }),
                    Err(error) => serde_json::json!({ "type": "signature_result", "ok": false, "error": error }),
                };
                if socket.send(Message::Text(reply.to_string().into())).await.is_err() {
                    break;
                }
            }
            ClientMessage::EditButton {
                request_id,
                revision,
                page_id,
                folder_id,
                button,
                remove_id,
            } if authenticated => {
                let result = if valid_id(&request_id) {
                    edit_button(&state, &deck_key(&state, &device_id), revision, &page_id, folder_id.as_deref(), button, remove_id.as_deref())
                } else {
                    Err("invalid_request".into())
                };
                let reply = match result {
                    Ok(()) => serde_json::json!({ "type": "edit_result", "requestId": request_id, "ok": true }),
                    Err(error) => serde_json::json!({ "type": "edit_result", "requestId": request_id, "ok": false, "error": error }),
                };
                if socket.send(Message::Text(reply.to_string().into())).await.is_err() {
                    break;
                }
            }
            ClientMessage::PcStatsSubscribe { needs } if authenticated => {
                pc_stats_needs = pc_stats::Needs::from_names(&needs[..needs.len().min(16)]);
                state.pc_stats_demand.set(connection_id, pc_stats_needs, None);
                // The next message carries the whole minute so graphs start full.
                pc_stats_history_sent = false;
            }
            ClientMessage::WidgetSurface { surface } if authenticated => {
                if surface.is_valid() {
                    if let Ok(mut current) = state.widget_surface.write() {
                        *current = Some(surface);
                    }
                }
            }
            ClientMessage::LegacyDeck { deck } if authenticated => {
                let requested = state
                    .legacy_offers
                    .read()
                    .map(|offers| {
                        offers
                            .get(&deck.source_id)
                            .is_some_and(|offer| offer.requested)
                    })
                    .unwrap_or(false);
                let accepted = legacy_source_id.as_deref() == Some(deck.source_id.as_str())
                    && requested
                    && validate_legacy_deck(&deck).is_ok();
                if accepted {
                    if let Ok(mut offers) = state.legacy_offers.write() {
                        if let Some(offer) = offers
                            .get_mut(&deck.source_id)
                            .filter(|offer| offer.requested)
                        {
                            offer.pages = deck.pages.len();
                            offer.buttons =
                                deck.pages.iter().map(|page| page.shortcuts.len()).sum();
                            offer.ready = true;
                            if let Ok(mut pending) = state.pending_legacy.write() {
                                pending.insert(deck.source_id.clone(), deck);
                            }
                        }
                    }
                }
                let response = if accepted {
                    r#"{"type":"legacy_deck_received"}"#
                } else {
                    r#"{"type":"error","message":"invalid_legacy_deck"}"#
                };
                if socket.send(Message::Text(response.into())).await.is_err() {
                    break;
                }
            }
            _ => {
                let _ = socket
                    .send(Message::Text(
                        r#"{"type":"error","message":"unauthorized"}"#.into(),
                    ))
                    .await;
                break;
            }
        }
    }
    if authenticated {
        // A drag the phone started must not stay held after it drops.
        remote::release_buttons();
        state.active_devices.fetch_sub(1, Ordering::Relaxed);
        if !device_id.is_empty() {
            unregister_device(&state, &device_id);
        }
        if over_usb {
            state.usb_clients.fetch_sub(1, Ordering::Relaxed);
        }
    }
    // This phone no longer needs any readings.
    state.pc_stats_demand.remove(connection_id);
    if let Some(source_id) = legacy_source_id {
        if let Ok(mut offers) = state.legacy_offers.write() {
            if let Some(offer) = offers.get_mut(&source_id) {
                if !offer.ready {
                    offer.requested = false;
                }
            }
        }
    }
}

fn update_selection(
    state: &AppState,
    key: &str,
    expected_revision: u64,
    profile_id: Option<&str>,
    page_id: Option<&str>,
) -> Result<(), String> {
    mutate_deck(state, key, |config| {
        if config.revision != expected_revision {
            return Err("stale_revision".into());
        }
        if let Some(profile_id) = profile_id {
            if !config.profiles.iter().any(|profile| profile.id == profile_id) {
                return Err("unknown_profile".into());
            }
            config.active_profile_id = profile_id.to_owned();
        }
        let active_profile_id = config.active_profile_id.clone();
        let profile = config
            .profiles
            .iter_mut()
            .find(|profile| profile.id == active_profile_id)
            .ok_or_else(|| "unknown_profile".to_owned())?;
        if let Some(page_id) = page_id {
            if !profile.pages.iter().any(|page| page.id == page_id) {
                return Err("unknown_page".into());
            }
            profile.active_page_id = page_id.to_owned();
        }
        Ok(())
    })
}

/// Edits the shared deck (`key` ""), or one phone's own deck, saves it and tells the phones that use it.
fn mutate_deck(
    state: &AppState,
    key: &str,
    edit: impl FnOnce(&mut DeckConfig) -> Result<(), String>,
) -> Result<(), String> {
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are unavailable".to_owned())?;
    let next = if key.is_empty() {
        let mut config = state
            .deck_config
            .write()
            .map_err(|_| "Deck config is unavailable".to_owned())?;
        edit(&mut config)?;
        config.revision = config.revision.saturating_add(1);
        save_deck_config_file(&config_dir.join("deck-config.json"), &config)?;
        config.clone()
    } else {
        let mut decks = state
            .device_decks
            .write()
            .map_err(|_| "Deck config is unavailable".to_owned())?;
        let config = decks.get_mut(key).ok_or_else(|| "unknown_device".to_owned())?;
        edit(config)?;
        config.revision = config.revision.saturating_add(1);
        save_device_deck_file(&config_dir, key, config)?;
        config.clone()
    };
    let _ = state.deck_updates.send((key.to_owned(), next));
    Ok(())
}

/// Actions a phone may put on a button. They trigger nothing the phone's touchpad and keyboard could not
/// already do; scripts, plugins, launches and folders stay choices made on the PC.
fn phone_editable(action: &DeckAction) -> bool {
    matches!(
        action,
        DeckAction::Media { .. }
            | DeckAction::Hotkey { .. }
            | DeckAction::TypeText { .. }
            | DeckAction::OpenUrl { .. }
            | DeckAction::System { .. }
            | DeckAction::SelectPage { .. }
            | DeckAction::SelectProfile { .. }
    )
}

fn apply_button_edit(
    config: &mut DeckConfig,
    page_id: &str,
    folder_id: Option<&str>,
    button: Option<DeckButton>,
    remove_id: Option<&str>,
) -> Result<(), String> {
    let page = config
        .profiles
        .iter_mut()
        .flat_map(|profile| profile.pages.iter_mut())
        .find(|page| page.id == page_id)
        .ok_or_else(|| "unknown_page".to_owned())?;
    let buttons = match folder_id {
        Some(id) => {
            &mut page
                .folders
                .iter_mut()
                .find(|folder| folder.id == id)
                .ok_or_else(|| "unknown_folder".to_owned())?
                .buttons
        }
        None => &mut page.buttons,
    };
    if let Some(id) = remove_id {
        let index = buttons
            .iter()
            .position(|item| item.id == id)
            .ok_or_else(|| "unknown_button".to_owned())?;
        if matches!(buttons[index].action, DeckAction::OpenFolder { .. }) {
            return Err("Remove folders in Open Dock on the PC".into());
        }
        buttons.remove(index);
    }
    if let Some(button) = button {
        if !phone_editable(&button.action) || !button.long_press.as_ref().is_none_or(phone_editable) || button.app_icon_data.is_some() {
            return Err("Set up this kind of button in Open Dock on the PC".into());
        }
        match buttons.iter().position(|item| item.id == button.id) {
            Some(index) if !phone_editable(&buttons[index].action) || !buttons[index].long_press.as_ref().is_none_or(phone_editable) => {
                return Err("Edit this button in Open Dock on the PC".into());
            }
            Some(index) => buttons[index] = button,
            None => buttons.push(button),
        }
    }
    Ok(())
}

fn edit_button(
    state: &AppState,
    key: &str,
    expected_revision: u64,
    page_id: &str,
    folder_id: Option<&str>,
    button: Option<DeckButton>,
    remove_id: Option<&str>,
) -> Result<(), String> {
    mutate_deck(state, key, |config| {
        if config.revision != expected_revision {
            return Err("stale_revision".into());
        }
        let mut next = config.clone();
        apply_button_edit(&mut next, page_id, folder_id, button, remove_id)?;
        normalize_deck_layout(&mut next);
        validate_deck_config(&next)?;
        *config = next;
        Ok(())
    })
}

fn selection_reply(request_id: &str, result: Result<(), String>) -> serde_json::Value {
    match result {
        Ok(()) => {
            serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": true })
        }
        Err(error) => {
            serde_json::json!({ "type": "action_result", "requestId": request_id, "ok": false, "reason": error })
        }
    }
}

fn invoke_button(
    state: &AppState,
    key: &str,
    revision: u64,
    button_id: &str,
    long_press: bool,
    independent: bool,
    selected_profile_id: &mut String,
    selected_page_id: &mut String,
) -> Result<bool, String> {
    let config = read_deck(state, key).ok_or_else(|| "Deck config is unavailable".to_owned())?;
    if config.revision != revision {
        return Err("stale_revision".into());
    }
    let profile_id = if independent {
        selected_profile_id.as_str()
    } else {
        config.active_profile_id.as_str()
    };
    let profile = config
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "unknown_profile".to_owned())?;
    let page_id = if independent {
        selected_page_id.as_str()
    } else {
        profile.active_page_id.as_str()
    };
    let page = profile
        .pages
        .iter()
        .find(|page| page.id == page_id)
        .ok_or_else(|| "unknown_page".to_owned())?;
    let page_buttons = |page: &'_ DeckPage| {
        page.buttons
            .iter()
            .chain(page.folders.iter().flat_map(|folder| &folder.buttons))
            .find(|button| button.id == button_id)
            .cloned()
    };
    // The phone pins buttons from any page of the profile to its always-visible rail.
    let button = page_buttons(page)
        .or_else(|| profile.pages.iter().find_map(|page| page_buttons(page)))
        .ok_or_else(|| "unknown_button".to_owned())?;
    // A key without a long-press action does its normal action on a long press too.
    let action = if long_press { button.long_press.as_ref().unwrap_or(&button.action) } else { &button.action };
    let changed_selection = matches!(
        action,
        DeckAction::SelectProfile { .. } | DeckAction::SelectPage { .. }
    );
    run_deck_action(
        action,
        state,
        key,
        revision,
        independent,
        selected_profile_id,
        selected_page_id,
    )?;
    Ok(changed_selection)
}

fn run_deck_action(
    action: &DeckAction,
    state: &AppState,
    key: &str,
    revision: u64,
    independent: bool,
    selected_profile_id: &mut String,
    selected_page_id: &mut String,
) -> Result<(), String> {
    match action {
        DeckAction::Media { command } => run_action(ClientAction::Media { command: *command }),
        DeckAction::Hotkey { keys } => run_action(ClientAction::Hotkey { keys: keys.clone() }),
        DeckAction::LaunchApp { app } => run_action(ClientAction::LaunchApp { app: app.clone() }),
        DeckAction::LaunchFile { path } => {
            run_action(ClientAction::LaunchFile { path: path.clone() })
        }
        DeckAction::LaunchFolder { path } => {
            run_action(ClientAction::LaunchFolder { path: path.clone() })
        }
        DeckAction::RunScript { path, allow_on_pc } => {
            if !allow_on_pc {
                return Err("Allow this script to run on this PC in its button settings".into());
            }
            run_script(path, &[])
        }
        DeckAction::PluginAction {
            plugin_id,
            action_id,
            allow_on_pc,
            inputs,
        } => {
            if !allow_on_pc {
                return Err(
                    "Allow this plugin action to run on this PC in its button settings".into(),
                );
            }
            let config_dir = state
                .config_dir
                .read()
                .map_err(|_| "Open Dock settings are unavailable".to_owned())?
                .clone()
                .ok_or_else(|| "Open Dock settings are still starting".to_owned())?;
            run_open_dock_plugin_action(&config_dir, plugin_id, action_id, inputs)
        }
        DeckAction::Sequence { steps } => {
            let mut actions = Vec::with_capacity(steps.len());
            for step in steps {
                actions.push(match step {
                    DeckStep::Media { command } => SequenceAction::Media { command: *command },
                    DeckStep::Hotkey { keys } => SequenceAction::Hotkey { keys: keys.clone() },
                    DeckStep::LaunchApp { app } => SequenceAction::LaunchApp { app: app.clone() },
                    DeckStep::LaunchFile { path } => {
                        SequenceAction::LaunchFile { path: path.clone() }
                    }
                    DeckStep::LaunchFolder { path } => {
                        SequenceAction::LaunchFolder { path: path.clone() }
                    }
                    DeckStep::TypeText { text } => SequenceAction::TypeText { text: text.clone() },
                    DeckStep::OpenUrl { url } => SequenceAction::OpenUrl { url: url.clone() },
                    DeckStep::Delay { ms } => SequenceAction::Delay { ms: *ms },
                });
            }
            run_action(ClientAction::Sequence { actions })
        }
        DeckAction::SelectProfile { profile_id } => {
            if independent {
                update_device_selection(
                    state,
                    key,
                    revision,
                    Some(profile_id),
                    None,
                    selected_profile_id,
                    selected_page_id,
                )
            } else {
                update_selection(state, key, revision, Some(profile_id), None)
            }
        }
        DeckAction::SelectPage { page_id } => {
            if independent {
                update_device_selection(
                    state,
                    key,
                    revision,
                    None,
                    Some(page_id),
                    selected_profile_id,
                    selected_page_id,
                )
            } else {
                update_selection(state, key, revision, None, Some(page_id))
            }
        }
        // The phone shows the folder itself; the PC has nothing to run.
        DeckAction::OpenFolder { .. } => Ok(()),
        DeckAction::System { command } => remote::run_system_command(*command),
        DeckAction::TypeText { text } => run_action(ClientAction::TypeText { text: text.clone() }),
        DeckAction::OpenUrl { url } => run_action(ClientAction::OpenUrl { url: url.clone() }),
    }
}

#[cfg(windows)]
async fn current_playback_state() -> PlaybackState {
    system_media::selected_playback_state().await
}

#[cfg(target_os = "macos")]
async fn current_playback_state() -> PlaybackState {
    system_media::adapter_playback_state()
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn current_playback_state() -> PlaybackState {
    PlaybackState::Unavailable
}

#[tauri::command]
async fn get_playback_state() -> PlaybackState {
    current_playback_state().await
}

#[tauri::command]
fn get_system_media_state(
    state: tauri::State<'_, Arc<AppState>>,
) -> system_media::SystemMediaState {
    state.media_state.borrow().clone()
}

fn run_action(action: ClientAction) -> Result<(), String> {
    match action {
        ClientAction::Hotkey { keys } => {
            let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
            if keys.len() < 2 || keys.len() > 5 {
                return Err("A shortcut must contain a modifier and one key".into());
            }
            let mut modifiers = Vec::with_capacity(keys.len() - 1);
            for (index, modifier) in keys[..keys.len() - 1].iter().enumerate() {
                if keys[..index].contains(modifier) {
                    return Err("Shortcut modifiers must be unique".into());
                }
                modifiers.push(match modifier.as_str() {
                    "CTRL" => Key::Control,
                    "ALT" => Key::Alt,
                    "SHIFT" => Key::Shift,
                    "META" => Key::Meta,
                    _ => return Err("Unsupported modifier".into()),
                });
            }
            let key = parse_key(&keys[keys.len() - 1])?;
            for modifier in &modifiers {
                enigo
                    .key(*modifier, Direction::Press)
                    .map_err(|e| e.to_string())?;
            }
            enigo
                .key(key, Direction::Click)
                .map_err(|e| e.to_string())?;
            for modifier in modifiers.iter().rev() {
                enigo
                    .key(*modifier, Direction::Release)
                    .map_err(|e| e.to_string())?;
            }
        }
        ClientAction::Media { command } => {
            // On macOS, playback commands go straight to the now playing app (MediaRemote IDs:
            // toggle play/pause 2, next 4, previous 5); media keys are the fallback and need
            // Accessibility permission.
            #[cfg(target_os = "macos")]
            {
                let command_id = match command {
                    MediaCommand::PlayPause => Some(2),
                    MediaCommand::NextTrack => Some(4),
                    MediaCommand::PreviousTrack => Some(5),
                    MediaCommand::VolumeUp | MediaCommand::VolumeDown | MediaCommand::Mute => None,
                };
                if command_id.is_some_and(|id| system_media::send_media_command(id).is_ok()) {
                    return Ok(());
                }
            }
            // On Windows the media keys reach whichever app Windows calls current; when the phone chose another
            // player, the command goes to that player instead.
            #[cfg(windows)]
            if let Some(result) = system_media::control_selected_player(command) {
                return result;
            }
            let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
            let key = match command {
                MediaCommand::PlayPause => Key::MediaPlayPause,
                MediaCommand::NextTrack => Key::MediaNextTrack,
                MediaCommand::PreviousTrack => Key::MediaPrevTrack,
                MediaCommand::VolumeUp => Key::VolumeUp,
                MediaCommand::VolumeDown => Key::VolumeDown,
                MediaCommand::Mute => Key::VolumeMute,
            };
            enigo
                .key(key, Direction::Click)
                .map_err(|e| e.to_string())?;
        }
        ClientAction::LaunchApp { app } => launch_app(&app)?,
        ClientAction::LaunchFile { path } => launch_file(&path)?,
        ClientAction::LaunchFolder { path } => launch_file(&path)?,
        ClientAction::TypeText { text } => {
            validate_snippet(&text)?;
            let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
            enigo.text(&text).map_err(|error| error.to_string())?;
        }
        ClientAction::OpenUrl { url } => open_url(&url)?,
        ClientAction::Sequence { actions } => {
            if actions.is_empty() || actions.len() > 10 {
                return Err("An action sequence must contain between 1 and 10 steps".into());
            }
            for (index, action) in actions.into_iter().enumerate() {
                if index > 0 {
                    thread::sleep(Duration::from_millis(150));
                }
                let action = match action {
                    SequenceAction::Hotkey { keys } => ClientAction::Hotkey { keys },
                    SequenceAction::Media { command } => ClientAction::Media { command },
                    SequenceAction::LaunchApp { app } => ClientAction::LaunchApp { app },
                    SequenceAction::LaunchFile { path } => ClientAction::LaunchFile { path },
                    SequenceAction::LaunchFolder { path } => ClientAction::LaunchFolder { path },
                    SequenceAction::TypeText { text } => ClientAction::TypeText { text },
                    SequenceAction::OpenUrl { url } => ClientAction::OpenUrl { url },
                    SequenceAction::Delay { ms } => {
                        thread::sleep(Duration::from_millis(u64::from(ms.min(5_000))));
                        continue;
                    }
                };
                run_action(action)?;
            }
        }
    }
    Ok(())
}

/// Runs a spoken sentence (one or more commands) and says what it did.
async fn run_voice(
    text: &str,
    state: &AppState,
    independent: bool,
    selected_profile_id: &mut String,
    selected_page_id: &mut String,
) -> Result<String, String> {
    let intents = voice::parse(text);
    if intents.is_empty() {
        return Err("Say a command, such as \"open Spotify\" or \"volume up\".".into());
    }
    let mut done = Vec::new();
    for (index, intent) in intents.into_iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(Duration::from_millis(if done.last().is_some_and(|d: &String| d.starts_with("Opened")) { 1200 } else { 150 })).await;
        }
        let (action, said) = match intent {
            voice::Intent::Media(command) => (ClientAction::Media { command }, voice::spoken_name(&format!("{command:?}"))),
            voice::Intent::Keys(keys) if keys.len() == 1 => {
                let key = keys[0].clone();
                tauri::async_runtime::spawn_blocking(move || press_key(&key)).await.map_err(|_| "Could not run that".to_owned())??;
                done.push(format!("Pressed {}", voice::spoken_name(&keys[0])));
                continue;
            }
            voice::Intent::Keys(keys) => (ClientAction::Hotkey { keys: keys.clone() }, format!("Pressed {}", keys.iter().map(|key| voice::spoken_name(key)).collect::<Vec<_>>().join("+"))),
            voice::Intent::System(command) => {
                tauri::async_runtime::spawn_blocking(move || remote::run_system_command(command)).await.map_err(|_| "Could not run that".to_owned())??;
                done.push(voice::spoken_name(&format!("{command:?}")));
                continue;
            }
            voice::Intent::Volume(level) => {
                system_media::set_system_volume(level)?;
                done.push(format!("Volume {level}%"));
                continue;
            }
            voice::Intent::Type(words) => (ClientAction::TypeText { text: words.clone() }, format!("Typed \"{words}\"")),
            voice::Intent::Url(url) => (ClientAction::OpenUrl { url: url.clone() }, format!("Opened {url}")),
            voice::Intent::Open(name) | voice::Intent::Unknown(name) => {
                let loose = !text.trim().eq_ignore_ascii_case(&name);
                // The user's own deck buttons come first, then installed apps, then well-known sites.
                if let Some(button) = deck_button_named(state, &name, independent, selected_profile_id) {
                    let revision = state.deck_config.read().map(|config| config.revision).unwrap_or_default();
                    invoke_button(state, "", revision, &button.0, false, independent, selected_profile_id, selected_page_id)?;
                    done.push(format!("Pressed {}", button.1));
                    continue;
                }
                let apps = list_installed_apps().await?;
                let wanted = voice::app_alias(&name);
                if let Some(path) = voice::best_match(wanted, apps.iter().map(|app| (app.name.as_str(), app.path.as_str())), loose) {
                    let label = apps.iter().find(|app| app.path == path).map_or(name.clone(), |app| app.name.clone());
                    (ClientAction::LaunchApp { app: path.to_owned() }, format!("Opened {label}"))
                } else if let Some(url) = voice::site(&name) {
                    (ClientAction::OpenUrl { url: url.to_owned() }, format!("Opened {name}"))
                } else if loose {
                    return Err(format!("No app or site called \"{name}\"."));
                } else {
                    return Err(format!("Didn't catch that: \"{}\". Try \"open Spotify\", \"skip this song\" or \"close this tab\".", text.trim()));
                }
            }
        };
        tauri::async_runtime::spawn_blocking(move || run_action(action)).await.map_err(|_| "Could not run that".to_owned())??;
        done.push(said);
    }
    done.dedup();
    Ok(done.join(", then "))
}

static VOICE_ON: AtomicBool = AtomicBool::new(false);
static VOICE_RUN: AtomicU64 = AtomicU64::new(0);
/// Hands-free: only what follows this phrase is a command. Empty runs every sentence.
static WAKE_PHRASE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
/// When the wake phrase was said alone, or the mic button was clicked during hands-free (ms since 1970): the next
/// sentence soon after is the command.
static ARMED_AT: AtomicU64 = AtomicU64::new(0);
const ARMED_MS: u64 = 8000;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

fn voice_armed() -> bool {
    now_ms().saturating_sub(ARMED_AT.load(Ordering::SeqCst)) < ARMED_MS
}

/// Voice commands said into the PC's own mic, one after another until `stop_voice`: each sentence runs like one
/// from the phone, and the voice island shows each step. With `wake` (hands-free), only sentences that start with
/// it run, and the island stays away until it is said. Called again while listening, it only changes `wake`.
/// Ends with an error only when the PC cannot listen.
#[tauri::command]
async fn listen_voice(state: tauri::State<'_, Arc<AppState>>, wake: Option<String>) -> Result<(), String> {
    *WAKE_PHRASE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = wake.unwrap_or_default().trim().to_owned();
    if VOICE_ON.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    // A listen stopped a moment ago may still be hearing its last sentence; it ends there instead of carrying on
    // beside this one.
    let run = VOICE_RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let current = || VOICE_ON.load(Ordering::SeqCst) && VOICE_RUN.load(Ordering::SeqCst) == run;
    while current() {
        let phrase = WAKE_PHRASE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let wake = (!phrase.is_empty() && !voice_armed()).then(|| phrase.clone());
        island::show(if wake.is_some() { "idle" } else { "listening" }, "");
        #[cfg(windows)]
        let heard = tauri::async_runtime::spawn_blocking(move || pc_voice::listen_once(wake)).await.map_err(|_| "Could not listen".to_owned()).and_then(|heard| heard);
        #[cfg(not(windows))]
        let heard: Result<String, String> = { let _ = wake; Err("Voice on this PC needs Windows".into()) };
        let heard = match heard {
            Ok(text) if text.trim().is_empty() => continue,
            Ok(text) => text,
            Err(error) => {
                if current() {
                    VOICE_ON.store(false, Ordering::SeqCst);
                    island::show("failed", &error);
                }
                return Err(error);
            }
        };
        if !current() {
            return Ok(());
        }
        let heard = if phrase.is_empty() || voice_armed() {
            heard
        } else {
            match voice::after_wake_phrase(&heard, &phrase) {
                None => continue,
                // The phrase alone: the next sentence is the command.
                Some(rest) if rest.is_empty() => {
                    ARMED_AT.store(now_ms(), Ordering::SeqCst);
                    continue;
                }
                Some(rest) => rest,
            }
        };
        ARMED_AT.store(0, Ordering::SeqCst);
        island::show("working", &heard);
        let (mut profile_id, mut page_id) = (String::new(), String::new());
        match run_voice(&heard, &state, false, &mut profile_id, &mut page_id).await {
            Ok(done) => {
                state.media_refresh.notify_one();
                island::show("done", &done);
            }
            Err(error) => island::show("failed", &error),
        }
        // Long enough to read what happened before the island listens again.
        tokio::time::sleep(Duration::from_millis(1600)).await;
    }
    island::show("idle", "");
    Ok(())
}

/// Stops `listen_voice` after the sentence it is hearing now.
#[tauri::command]
fn stop_voice() {
    VOICE_ON.store(false, Ordering::SeqCst);
    island::show("idle", "");
}

/// During hands-free, a click on the mic: the next sentence is the command without the wake phrase.
#[tauri::command]
fn arm_voice() {
    ARMED_AT.store(now_ms(), Ordering::SeqCst);
    island::show("listening", "");
}

/// The deck button on the phone's current profile whose label matches `name`: (id, label).
fn deck_button_named(state: &AppState, name: &str, independent: bool, selected_profile_id: &str) -> Option<(String, String)> {
    let config = state.deck_config.read().ok()?;
    let profile_id = if independent { selected_profile_id } else { config.active_profile_id.as_str() };
    let profile = config.profiles.iter().find(|profile| profile.id == profile_id)?;
    let buttons: Vec<&DeckButton> = profile
        .pages
        .iter()
        .flat_map(|page| page.buttons.iter().chain(page.folders.iter().flat_map(|folder| &folder.buttons)))
        .filter(|button| !button.label.trim().is_empty())
        .collect();
    let id = voice::best_match(name, buttons.iter().map(|button| (button.label.trim(), button.id.as_str())), false)?;
    buttons.iter().find(|button| button.id == id).map(|button| (button.id.clone(), button.label.trim().to_owned()))
}

/// One key on its own ("press enter", "start menu").
fn press_key(key: &str) -> Result<(), String> {
    let key = if key == "META" { Key::Meta } else { parse_key(key)? };
    let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
    enigo.key(key, Direction::Click).map_err(|error| error.to_string())
}

fn run_script(path: &str, args: &[String]) -> Result<(), String> {
    validate_script_target(path)?;
    let path = Path::new(path.trim());
    if !path.is_file() {
        return Err("The selected script does not exist".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    #[cfg(windows)]
    let mut command = if extension.eq_ignore_ascii_case("ps1") {
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-File"])
            .arg(path);
        command
    } else {
        let mut command = Command::new("py.exe");
        command.args(["-3"]).arg(path);
        command
    };
    #[cfg(not(windows))]
    let mut command = if extension.eq_ignore_ascii_case("sh") {
        let mut command = Command::new("/bin/sh");
        command.arg(path);
        command
    } else {
        let mut command = Command::new("python3");
        command.arg(path);
        command
    };
    // A script runs in the background; a console window for it would only get in the way.
    quiet(&mut command)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start script: {error}"))
}

fn run_open_dock_plugin_action(
    config_dir: &Path,
    plugin_id: &str,
    action_id: &str,
    inputs: &HashMap<String, String>,
) -> Result<(), String> {
    if !valid_plugin_id(plugin_id) || !valid_plugin_id(action_id) {
        return Err("This plugin action has an invalid identifier".into());
    }
    let plugin_dir = open_dock_plugins_path(config_dir).join(plugin_id);
    let (manifest, _) = read_open_dock_plugin_manifest(&plugin_dir)?;
    if manifest.id != plugin_id {
        return Err("Installed plugin id does not match its manifest".into());
    }
    let action = manifest
        .actions
        .iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| "This plugin action is no longer installed".to_owned())?;
    if inputs
        .keys()
        .any(|id| !action.inputs.iter().any(|input| input.id == *id))
    {
        return Err("This plugin action has an unknown input".into());
    }
    let mut args = Vec::with_capacity(action.inputs.len());
    let mut total_bytes = 0usize;
    for input in &action.inputs {
        let value = inputs.get(&input.id).unwrap_or(&input.default);
        if value.len() > 1024 || value.chars().any(char::is_control) {
            return Err(format!(
                "{} is too long or contains invalid characters",
                input.label
            ));
        }
        match input.kind.as_str() {
            "number" if value.parse::<f64>().is_err_and(|_| !value.is_empty()) => {
                return Err(format!("Enter a number for {}", input.label));
            }
            "number" if !value.is_empty() && !value.parse::<f64>().is_ok_and(f64::is_finite) => {
                return Err(format!("Enter a valid number for {}", input.label));
            }
            "select" if !input.options.contains(value) => {
                return Err(format!("Choose a valid option for {}", input.label));
            }
            _ => (),
        }
        total_bytes += value.len();
        if total_bytes > 8192 {
            return Err("Plugin action inputs exceed the size limit".into());
        }
        args.push(value.clone());
    }
    let scripts = plugin_scripts(&plugin_dir, &manifest)?;
    let filename = Path::new(&action.script)
        .file_name()
        .ok_or_else(|| "Invalid plugin script".to_owned())?;
    let script = scripts
        .iter()
        .find(|(_, name)| Path::new(name) == Path::new(filename))
        .map(|(path, _)| path.as_path())
        .ok_or_else(|| "The plugin script is unavailable".to_owned())?;
    run_script(script.to_string_lossy().as_ref(), &args)
}

fn launch_app(app: &str) -> Result<(), String> {
    let app = app.trim();
    if app.is_empty() || app.len() > 512 || app.chars().any(char::is_control) {
        return Err("Enter a valid app name or path".into());
    }
    #[cfg(windows)]
    let result = if app.starts_with(win_apps::SHELL_PREFIX)
        || Path::new(app)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
    {
        Command::new("explorer.exe").arg(app).spawn()
    } else {
        Command::new(app).spawn()
    };
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-a").arg(app).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let result: Result<std::process::Child, std::io::Error> = Err(std::io::Error::other(
        "App launching is supported on Windows and macOS",
    ));
    result
        .map(|_| ())
        .map_err(|error| format!("Could not launch app: {error}"))
}

fn open_url(url: &str) -> Result<(), String> {
    validate_url(url)?;
    // url.dll hands the address to the default browser without a shell parsing it.
    #[cfg(windows)]
    let result = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let result: Result<std::process::Child, std::io::Error> = Err(std::io::Error::other(
        "Opening websites is supported on Windows and macOS",
    ));
    result
        .map(|_| ())
        .map_err(|error| format!("Could not open the website: {error}"))
}

fn launch_file(path: &str) -> Result<(), String> {
    validate_file_target(path)?;
    let path = Path::new(path.trim());
    if !path.exists() {
        return Err("That file or folder no longer exists".into());
    }
    #[cfg(windows)]
    let result = Command::new("explorer.exe").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(path).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let result: Result<std::process::Child, std::io::Error> = Err(std::io::Error::other(
        "File and folder launching is supported on Windows and macOS",
    ));
    result
        .map(|_| ())
        .map_err(|error| format!("Could not open file or folder: {error}"))
}

#[tauri::command]
async fn extract_file_thumbnail(path: String, size: Option<u32>) -> Result<String, String> {
    // File keys use 96 px; an image chosen as a key's icon asks for more so it can fill the key, stepping down
    // until the PNG fits the 64 KB a button may carry.
    let size = size.unwrap_or(96).clamp(32, 256);
    tauri::async_runtime::spawn_blocking(move || {
        let key = if size == 96 { path.clone() } else { format!("{size}:{path}") };
        cached_icon(&key, false, || {
            let mut result = read_file_thumbnail(path.clone(), size);
            for smaller in [160, 96] {
                if result.is_ok() || smaller >= size { break; }
                result = read_file_thumbnail(path.clone(), smaller);
            }
            result
        })
    })
    .await
    .map_err(|_| "Could not read a thumbnail from that file".to_owned())?
}

fn read_file_thumbnail(path: String, size: u32) -> Result<String, String> {
    validate_file_target(&path)?;
    let path = PathBuf::from(path.trim());
    if !path.exists() {
        return Err("Choose an existing file or folder".into());
    }
    #[cfg(windows)]
    {
        let script = r#"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct OpenDockThumbnailSize { public int cx; public int cy; public OpenDockThumbnailSize(int x, int y) { cx = x; cy = y; } }
[ComImport, Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface OpenDockShellItemImageFactory { [PreserveSig] int GetImage(OpenDockThumbnailSize size, uint flags, out IntPtr bitmap); }
public static class OpenDockShellThumbnail {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid interfaceId, out OpenDockShellItemImageFactory item);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr handle);
  public static IntPtr Get(string path) {
    OpenDockShellItemImageFactory item = null;
    IntPtr bitmap = IntPtr.Zero;
    Guid iid = new Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B");
    int result = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
    if (result < 0 || item == null) Marshal.ThrowExceptionForHR(result);
    try {
      result = item.GetImage(new OpenDockThumbnailSize(96, 96), 0, out bitmap);
      if (result < 0 || bitmap == IntPtr.Zero) Marshal.ThrowExceptionForHR(result);
      return bitmap;
    } finally {
      if (item != null && Marshal.IsComObject(item)) Marshal.ReleaseComObject(item);
    }
  }
}
'@
$path = $env:OPEN_DOCK_FILE_PATH
$hbitmap = [OpenDockShellThumbnail]::Get($path)
$bitmap = [System.Drawing.Bitmap]::FromHbitmap($hbitmap)
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
$bitmap.Dispose()
$stream.Dispose()
$null = [OpenDockShellThumbnail]::DeleteObject($hbitmap)
"#;
        let output = quiet(&mut Command::new("powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", &script.replace("(96, 96)", &format!("({size}, {size})"))])
            .env("OPEN_DOCK_FILE_PATH", &path)
            .output()
            .map_err(|_| "Could not read a thumbnail from that file".to_owned())?;
        if !output.status.success() {
            return Err("Windows could not create a thumbnail for that file or folder".into());
        }
        let encoded = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if encoded.is_empty() || encoded.len() > 65_500 {
            return Err("The file thumbnail is too large to use".into());
        }
        return Ok(format!("data:image/png;base64,{encoded}"));
    }
    #[cfg(target_os = "macos")]
    {
        let directory =
            std::env::temp_dir().join(format!("open-dock-thumbnail-{}", rand::random::<u64>()));
        fs::create_dir(&directory)
            .map_err(|_| "Could not prepare a thumbnail location".to_owned())?;
        let result = Command::new("/usr/bin/qlmanage")
            .args(["-t", "-s", &size.to_string(), "-o"])
            .arg(&directory)
            .arg(&path)
            .output();
        let result = match result {
            Ok(result) => result,
            Err(_) => {
                let _ = fs::remove_dir(&directory);
                return Err("Could not create a Quick Look thumbnail".into());
            }
        };
        let thumbnail = fs::read_dir(&directory).ok().and_then(|entries| {
            entries.flatten().map(|entry| entry.path()).find(|file| {
                file.extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
            })
        });
        if !result.status.success() {
            if let Some(file) = thumbnail {
                let _ = fs::remove_file(file);
            }
            let _ = fs::remove_dir(&directory);
            return Err("macOS could not create a thumbnail for that file or folder".into());
        }
        let Some(thumbnail) = thumbnail else {
            let _ = fs::remove_dir(&directory);
            return Err("macOS has no thumbnail available for that item".into());
        };
        let encoded = Command::new("/usr/bin/base64")
            .arg("-i")
            .arg(&thumbnail)
            .output()
            .map_err(|_| "Could not encode the file thumbnail".to_owned());
        let _ = fs::remove_file(&thumbnail);
        let _ = fs::remove_dir(&directory);
        let encoded = encoded?;
        if !encoded.status.success() || encoded.stdout.len() > 65_500 {
            return Err("The file thumbnail is too large to use".into());
        }
        let data = String::from_utf8_lossy(&encoded.stdout)
            .replace('\n', "")
            .replace('\r', "");
        return Ok(format!("data:image/png;base64,{data}"));
    }
    #[allow(unreachable_code)]
    Err("File thumbnails are not supported on this platform".into())
}

fn parse_key(key: &str) -> Result<Key, String> {
    if key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() {
        return Ok(Key::Unicode(
            key.to_ascii_lowercase().chars().next().unwrap(),
        ));
    }
    let special = match key {
        "SPACE" => Key::Space,
        "ENTER" => Key::Return,
        "TAB" => Key::Tab,
        "ESCAPE" => Key::Escape,
        "BACKSPACE" => Key::Backspace,
        "DELETE" => Key::Delete,
        "HOME" => Key::Home,
        "END" => Key::End,
        "PAGE_UP" => Key::PageUp,
        "PAGE_DOWN" => Key::PageDown,
        "UP" => Key::UpArrow,
        "DOWN" => Key::DownArrow,
        "LEFT" => Key::LeftArrow,
        "RIGHT" => Key::RightArrow,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        _ => return Err("Unsupported key".into()),
    };
    Ok(special)
}

/// Answers phones sweeping the network for Open Dock PCs. Gives the name only; pairing needs the PIN or QR code.
async fn discover(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(serde_json::json!({ "app": "opendock", "name": pc_name(&state), "port": PORT }))
}

#[derive(Deserialize)]
struct PairRequest {
    pin: String,
}

/// Trades the PIN shown on the PC for the pairing key.
async fn pair(State(state): State<Arc<AppState>>, axum::Json(request): axum::Json<PairRequest>) -> impl IntoResponse {
    let accepted = request.pin.len() <= 16
        && state.pin_pairing.lock().map(|mut pairing| pairing.check(&request.pin)).unwrap_or(false);
    if !accepted {
        // Slows guessing down further; the PIN also changes after 5 misses.
        tokio::time::sleep(Duration::from_secs(1)).await;
        return (axum::http::StatusCode::FORBIDDEN, axum::Json(serde_json::json!({ "error": "wrong_pin" })));
    }
    let token = state.token.read().map(|token| token.clone()).unwrap_or_default();
    (
        axum::http::StatusCode::OK,
        axum::Json(serde_json::json!({ "token": token, "name": pc_name(&state), "port": PORT })),
    )
}

async fn serve(state: Arc<AppState>) {
    let app = Router::new()
        .route("/ws", get(upgrade_socket))
        .route("/discover", get(discover))
        .route("/pair", axum::routing::post(pair))
        .with_state(state.clone());
    let listener = match TcpListener::bind(("0.0.0.0", PORT)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Could not start the Open Dock connection server: {error}");
            return;
        }
    };
    state.server_online.store(true, Ordering::Relaxed);
    if let Err(error) = axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await {
        eprintln!("Open Dock connection server stopped: {error}");
        state.server_online.store(false, Ordering::Relaxed);
    }
}

/// Pins the native window to the chosen appearance. `window.set_theme` only sets the app-wide appearance, and
/// macOS kept drawing the title bar and sidebar material in the other one on some Macs; the window's own
/// appearance overrides both the app and the system setting. System leaves the window to follow the Mac.
#[cfg(target_os = "macos")]
fn force_window_appearance(window: &tauri::WebviewWindow, mode: &str) {
    use objc2_app_kit::{NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSWindow};
    let Ok(pointer) = window.ns_window() else { return };
    // SAFETY: Tauri returns the live NSWindow, and this runs on the main thread (setup, or a command that is not async).
    unsafe {
        let ns_window = &*(pointer as *const NSWindow);
        let appearance = match mode {
            "light" => NSAppearance::appearanceNamed(NSAppearanceNameAqua),
            "dark" => NSAppearance::appearanceNamed(NSAppearanceNameDarkAqua),
            _ => None,
        };
        ns_window.setAppearance(appearance.as_deref());
    }
}

/// "light", "dark", or "system" for anything else: the same three words the app's Appearance setting uses.
fn clean_appearance(mode: &str) -> &'static str {
    match mode.trim() {
        "light" => "light",
        "dark" => "dark",
        _ => "system",
    }
}

/// Gives the native window (title bar, and on a Mac the sidebar material) the chosen look.
fn apply_appearance(window: &tauri::WebviewWindow, mode: &str) {
    let theme = match mode {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    let _ = window.set_theme(theme);
    #[cfg(target_os = "macos")]
    force_window_appearance(window, mode);
}

/// Saves the appearance and applies it to the window. Not async on purpose: macOS wants the main thread.
#[tauri::command]
fn set_appearance(app: tauri::AppHandle, state: tauri::State<'_, Arc<AppState>>, mode: String) -> Result<(), String> {
    let mode = clean_appearance(&mode);
    let config_dir = state
        .config_dir
        .read()
        .map_err(|_| "Open Dock settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open Dock settings are unavailable".to_owned())?;
    fs::write(config_dir.join("appearance"), mode).map_err(|_| "Could not save the appearance setting".to_owned())?;
    if let Some(window) = app.get_webview_window("main") {
        apply_appearance(&window, mode);
    }
    Ok(())
}

/// Brings the window back from the tray, the taskbar or a second launch.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Restarts after an update. The single-instance lock is released first, otherwise the new
/// process would find this one still running, hand off to it and exit, leaving nothing open.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    tauri_plugin_single_instance::destroy(&app);
    app.restart();
}

/// The taskbar draws a window's big icon. Tauri's set_icon only sets the small one, and with no big icon
/// Windows shows a generic app icon, so the exe's own icon resource goes in as the big one.
#[cfg(windows)]
fn set_taskbar_icon(hwnd: windows::Win32::Foundation::HWND) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{LoadImageW, SendMessageW, ICON_BIG, IMAGE_ICON, LR_DEFAULTSIZE, WM_SETICON};
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return };
        let resource = PCWSTR(tauri::utils::platform::WINDOWS_APP_ICON_RESOURCE_ID as usize as *const u16);
        if let Ok(icon) = LoadImageW(Some(HINSTANCE(module.0)), resource, IMAGE_ICON, 0, 0, LR_DEFAULTSIZE) {
            SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_BIG as usize)), Some(LPARAM(icon.0 as isize)));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Open Dock runs as administrator so it can read the CPU temperature: a manual launch asks once,
    // before anything else starts. Declining keeps it running without admin rights.
    let quiet_start = std::env::args().any(|arg| arg == "--autostart" || arg == "--no-elevate");
    if !quiet_start && !remote::is_elevated() && remote::relaunch_elevated() {
        return;
    }
    let host = local_ip_address::local_ip()
        .map(|address| address.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_owned());
    let (deck_updates, _) = broadcast::channel(16);
    let (media_state, _) =
        tokio::sync::watch::channel(system_media::SystemMediaState::unavailable());
    let (pc_stats, _) = tokio::sync::watch::channel(pc_stats::PcStatsHistory::default());
    let (legacy_requests, _) = broadcast::channel(16);
    let (navigation_updates, _) = broadcast::channel(16);
    let (auto_profile_updates, _) = broadcast::channel(16);
    let state = Arc::new(AppState {
        host,
        device_name: RwLock::new(machine_name()),
        token: RwLock::new(String::new()),
        config_dir: RwLock::new(None),
        deck_config: RwLock::new(default_deck_config()),
        deck_updates,
        device_decks: RwLock::new(HashMap::new()),
        known_devices: RwLock::new(HashMap::new()),
        device_meta: RwLock::new(HashMap::new()),
        online_devices: std::sync::Mutex::new(HashMap::new()),
        media_state,
        media_refresh: Arc::new(tokio::sync::Notify::new()),
        pc_stats,
        pc_stats_demand: Arc::new(pc_stats::Demand::default()),
        next_connection: AtomicU64::new(1),
        independent_navigation: AtomicBool::new(false),
        navigation_updates,
        auto_profile_updates,
        pending_legacy: RwLock::new(HashMap::new()),
        legacy_offers: RwLock::new(HashMap::new()),
        legacy_requests,
        active_devices: AtomicUsize::new(0),
        server_online: AtomicBool::new(false),
        android_usb_enabled: AtomicBool::new(false),
        usb_clients: AtomicUsize::new(0),
        usb_panel: RwLock::new(UsbPanel::default()),
        usb_retry: AtomicBool::new(false),
        session_epoch: AtomicUsize::new(0),
        widget_surface: RwLock::new(None),
        pin_pairing: std::sync::Mutex::new(remote::PinPairing::new()),
    });

    tauri::Builder::default()
        // Registered first: a second launch hands off to this process and exits before anything
        // else (server, monitors, tray) starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .manage(state.clone())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            delta::download_delta_update,
            delta::install_delta_update,
            camera::camera_sources,
            camera::camera_connect,
            camera::camera_disconnect,
            camera::camera_set,
            camera::camera_snapshot,
            camera::camera_preview,
            camera::camera_preview_stop,
            camera::camera_host_status,
            camera::camera_install,
            camera::camera_set_active,
            connection_info,
            deck_config,
            list_devices,
            rename_device,
            reset_device_deck,
            forget_device,
            set_pc_name,
            list_open_dock_plugins,
            install_open_dock_plugin,
            uninstall_open_dock_plugin,
            get_independent_navigation,
            set_independent_navigation,
            save_deck_config,
            get_playback_state,
            get_system_media_state,
            pc_stats_history,
            extract_app_icon,
            list_installed_apps,
            extract_file_thumbnail,
            pending_legacy_imports,
            request_legacy_deck_import,
            import_legacy_deck,
            enable_android_usb,
            get_autostart,
            set_autostart,
            retry_android_usb,
            set_appearance,
            adb_status,
            install_adb,
            rotate_pairing_key,
            restart_app,
            listen_voice,
            stop_voice,
            arm_voice
        ])
        .setup(move |app| {
            delta::remove_replaced_exe();
            let config_dir = app.path().app_config_dir()?;
            fs::create_dir_all(&config_dir)?;
            adb::init(&config_dir);
            let token = load_or_create_pairing_key(&config_dir.join("pairing-key"))
                .map_err(std::io::Error::other)?;
            *state
                .token
                .write()
                .map_err(|_| std::io::Error::other("Open Dock pairing key lock poisoned"))? = token;
            *state
                .config_dir
                .write()
                .map_err(|_| std::io::Error::other("Open Dock settings directory lock poisoned"))? =
                Some(config_dir.clone());

            let independent_navigation =
                fs::read_to_string(config_dir.join("independent-navigation"))
                    .map_or(true, |value| value.trim() == "true");
            state
                .independent_navigation
                .store(independent_navigation, Ordering::Relaxed);

            let deck_path = config_dir.join("deck-config.json");
            let deck_config = load_deck_config(&deck_path);
            let saved_config_valid = deck_path
                .metadata()
                .is_ok_and(|metadata| metadata.len() as usize <= MAX_DECK_CONFIG_BYTES)
                && fs::read(&deck_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<DeckConfig>(&bytes).ok())
                    .is_some_and(|config| validate_deck_config(&config).is_ok());
            if !saved_config_valid {
                save_deck_config_file(&deck_path, &deck_config).map_err(std::io::Error::other)?;
            }
            *state
                .deck_config
                .write()
                .map_err(|_| std::io::Error::other("Open Dock deck config lock poisoned"))? =
                deck_config;

            load_devices(&state, &config_dir);
            #[cfg(target_os = "windows")]
            {
                let icon_state = state.clone();
                let icon_dir = config_dir.clone();
                thread::spawn(move || upgrade_app_icons(&icon_state, &icon_dir));
            }

            let usb_enabled = fs::read_to_string(config_dir.join("android-usb-enabled"))
                .is_ok_and(|value| value.trim() == "true");
            state
                .android_usb_enabled
                .store(usb_enabled, Ordering::Relaxed);
            let monitor_state = state.clone();
            thread::spawn(move || run_usb_monitor(monitor_state));

            // Start with Windows unless the user turned it off: the first run turns it on, once.
            let autostart_marker = config_dir.join("autostart-set");
            if !autostart_marker.exists() && remote::set_autostart(true).is_ok() {
                let _ = fs::write(&autostart_marker, "true");
            }
            // The first run with admin rights moves autostart onto the elevated logon task.
            if remote::is_elevated() && remote::autostart_needs_task() {
                let _ = remote::set_autostart(true);
            }
            // Started with Windows, the app waits hidden in the tray, no taskbar button.
            let autostarted = std::env::args().any(|arg| arg == "--autostart");

            let profile_monitor = state.clone();
            thread::spawn(move || loop {
                if let Some(foreground) = foreground_app() {
                    switch_profile_for_foreground(&profile_monitor, &foreground);
                }
                thread::sleep(Duration::from_millis(700));
            });

            system_media::spawn_system_media_monitor(
                state.media_state.clone(),
                state.media_refresh.clone(),
                app.handle().clone(),
            );

            pc_stats::spawn_pc_stats_monitor(state.pc_stats.clone(), state.pc_stats_demand.clone());

            if let Some(window) = app.get_webview_window("main") {
                let saved = fs::read_to_string(config_dir.join("appearance")).unwrap_or_default();
                apply_appearance(&window, clean_appearance(&saved));
                // Started by hand it sits in the taskbar; with Windows it hides in the tray.
                let _ = if autostarted { window.hide() } else { window.minimize() };
            }

            if let Err(error) = island::init(app.handle()) {
                eprintln!("Open Dock: no voice island ({error})");
            }

            tauri::async_runtime::spawn(serve(state));
            let open = MenuItem::with_id(app, "open", "Show Open Dock", true, None::<&str>)?;
            let updates = MenuItem::with_id(app, "updates", "Check for Updates…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Open Dock", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &updates, &quit])?;
            let icon = app
                .default_window_icon()
                .ok_or("missing default window icon")?
                .clone();
            // Give every window the icon itself, small (title bar, Alt+Tab) and big (taskbar).
            for window in app.webview_windows().values() {
                let _ = window.set_icon(icon.clone());
                #[cfg(windows)]
                if let Ok(hwnd) = window.hwnd() {
                    set_taskbar_icon(hwnd);
                }
            }

            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "updates" => {
                        show_main_window(app);
                        // The window's Settings → Updates card runs the check.
                        let _ = app.emit("check-for-updates", ());
                    }
                    "quit" => app.exit(0),
                    _ => (),
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // Closing tucks the app into the tray (the hidden icons); the tray menu's Quit exits.
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Open Dock")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                system_media::shutdown();
            }
        });
}

#[cfg(all(test, windows))]
mod playback_timing {
    /// Times the media calls the app makes every second: `cargo test --lib playback_timing -- --ignored --nocapture`.
    #[test]
    #[ignore = "talks to this PC's media session"]
    fn media_call_costs() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            for (label, runs) in [("current_playback_state", 20), ("read_system_volume", 20)] {
                let started = std::time::Instant::now();
                for _ in 0..runs {
                    if label == "read_system_volume" {
                        let _ = super::system_media::read_system_volume();
                    } else {
                        let _ = super::current_playback_state().await;
                    }
                }
                println!("{label}: {:.1} ms per call", started.elapsed().as_secs_f64() * 1000.0 / runs as f64);
            }
        });
    }
}

#[cfg(test)]
mod deck_layout_tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn phones_edit_only_safe_buttons() {
        let script = json!({ "id": "s", "label": "s", "icon": "auto", "placement": { "row": 0, "column": 1, "rowSpan": 1, "columnSpan": 1 }, "action": { "type": "run_script", "path": "C:/a.ps1", "allowOnPc": true } });
        let mut config: DeckConfig = serde_json::from_value(json!({
            "schemaVersion": 2, "revision": 1, "activeProfileId": "p",
            "profiles": [{ "id": "p", "name": "P", "activePageId": "g", "pages": [{ "id": "g", "name": "G", "rows": 2, "columns": 3, "buttons": [button("a", 0, 0), script] }] }]
        }))
        .unwrap();
        let parse = |value: Value| Some(serde_json::from_value::<DeckButton>(value).unwrap());
        let mut hotkey = button("b", 1, 0);
        hotkey["action"] = json!({ "type": "hotkey", "keys": ["CTRL", "C"] });
        assert!(apply_button_edit(&mut config, "g", None, parse(hotkey), None).is_ok());
        assert!(apply_button_edit(&mut config, "g", None, None, Some("a")).is_ok());
        let mut sneaky = button("c", 1, 1);
        sneaky["action"] = json!({ "type": "run_script", "path": "C:/x.ps1", "allowOnPc": true });
        assert!(apply_button_edit(&mut config, "g", None, parse(sneaky), None).is_err());
        let mut rewrite = button("s", 0, 1);
        rewrite["action"] = json!({ "type": "media", "command": "mute" });
        assert!(apply_button_edit(&mut config, "g", None, parse(rewrite), None).is_err());
        let ids: Vec<_> = config.profiles[0].pages[0].buttons.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["s", "b"]);
        assert!(apply_button_edit(&mut config, "missing", None, None, Some("b")).is_err());
    }

    #[test]
    fn text_url_and_delay_actions_are_checked() {
        let action = |value: Value| validate_action(&serde_json::from_value::<DeckAction>(value).unwrap());
        assert!(action(json!({ "type": "type_text", "text": "Thanks,\nRDK" })).is_ok());
        assert!(action(json!({ "type": "type_text", "text": "  " })).is_err());
        assert!(action(json!({ "type": "open_url", "url": "https://example.com/a?b=c" })).is_ok());
        assert!(action(json!({ "type": "open_url", "url": "https://" })).is_err());
        assert!(action(json!({ "type": "open_url", "url": "file:///C:/Windows" })).is_err());
        assert!(action(json!({ "type": "open_url", "url": "https://a.com\" & calc" })).is_err());
        let sequence = |waits: &[u32]| {
            let steps: Vec<Value> = waits.iter().map(|ms| json!({ "type": "delay", "ms": ms })).collect();
            action(json!({ "type": "sequence", "steps": steps }))
        };
        assert!(sequence(&[500, 5_000]).is_ok());
        assert!(sequence(&[10]).is_err());
        assert!(sequence(&[5_000, 5_000, 500]).is_err());
    }

    fn button(id: &str, row: u8, column: u8) -> Value {
        json!({ "id": id, "label": id, "icon": "command", "placement": { "row": row, "column": column, "rowSpan": 1, "columnSpan": 1 }, "action": { "type": "media", "command": "play_pause" } })
    }

    fn clock(id: &str, row: u8, column: u8) -> Value {
        json!({ "id": id, "type": "clock", "placement": { "row": row, "column": column, "rowSpan": 1, "columnSpan": 2 } })
    }

    fn config(pages: Vec<Value>) -> DeckConfig {
        let first = pages[0]["id"].as_str().unwrap().to_owned();
        serde_json::from_value(json!({
            "schemaVersion": 1, "revision": 1, "activeProfileId": "p", "fallbackProfileId": "p",
            "profiles": [{ "id": "p", "name": "P", "pages": pages, "activePageId": first, "defaultPageId": first }]
        }))
        .unwrap()
    }

    fn page(id: &str, name: &str, buttons: Vec<Value>, area: Option<Value>) -> Value {
        let mut page = json!({ "id": id, "name": name, "rows": 2, "columns": 3, "buttons": buttons });
        if let Some(area) = area {
            page["widgetArea"] = area;
        }
        page
    }

    fn area(enabled: bool, pages: Vec<Value>) -> Value {
        json!({ "enabled": enabled, "rows": 2, "columns": 4, "pages": pages })
    }

    fn widget_page(id: &str, buttons: Vec<Value>, widgets: Vec<Value>) -> Value {
        json!({ "id": id, "name": id, "buttons": buttons, "widgets": widgets })
    }

    #[test]
    fn widget_pages_become_pages_after_their_page() {
        let mut deck = config(vec![
            page("a", "Alpha", vec![button("b1", 0, 0)], Some(area(true, vec![
                widget_page("w1", vec![], vec![clock("c1", 0, 0)]),
                widget_page("w2", vec![button("b2", 0, 0)], vec![]),
                widget_page("w3", vec![], vec![]),
            ]))),
            page("z", "Zulu", vec![], None),
        ]);
        normalize_deck_layout(&mut deck);
        validate_deck_config(&deck).unwrap();
        let names: Vec<_> = deck.profiles[0].pages.iter().map(|page| page.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Alpha widgets", "Alpha widgets 2", "Zulu"]);
        let converted = &deck.profiles[0].pages[1];
        assert_eq!((converted.rows, converted.columns, converted.widgets.len()), (2, 4, 1));
        assert!(deck.profiles[0].pages.iter().all(|page| page.widget_area.is_none()));
        assert_eq!(deck.migration_notes.len(), 1);
        // Idempotent: a second pass changes nothing.
        let before = serde_json::to_value(&deck).unwrap();
        normalize_deck_layout(&mut deck);
        assert_eq!(before, serde_json::to_value(&deck).unwrap());
    }

    #[test]
    fn widget_only_page_keeps_its_first_widget_page() {
        let mut deck = config(vec![{
            let mut only = page("a", "Alpha", vec![], Some(area(false, vec![widget_page("w1", vec![], vec![clock("c1", 0, 0)])])));
            only["rows"] = json!(0);
            only["columns"] = json!(0);
            only
        }]);
        normalize_deck_layout(&mut deck);
        validate_deck_config(&deck).unwrap();
        let only = &deck.profiles[0].pages[0];
        assert_eq!((deck.profiles[0].pages.len(), only.rows, only.columns, only.widgets.len()), (1, 2, 4, 1));
        assert!(deck.migration_notes.is_empty());
    }

    #[test]
    fn hidden_widget_area_is_noted_and_long_names_fit() {
        let name = "A very long page name here";
        let mut deck = config(vec![page("a", &name[..24], vec![button("b1", 0, 0)], Some(area(false, vec![widget_page("w1", vec![], vec![clock("c1", 0, 0)])])))]);
        normalize_deck_layout(&mut deck);
        validate_deck_config(&deck).unwrap();
        assert!(deck.profiles[0].pages[1].name.len() <= 24);
        assert!(deck.migration_notes[0].contains("hidden"));
    }

    #[test]
    fn conversion_stops_at_the_page_limit() {
        let pages = (0..MAX_PAGES - 1)
            .map(|index| page(&format!("p{index}"), &format!("P{index}"), vec![], None))
            .chain(std::iter::once(page("last", "Last", vec![button("b", 0, 0)], Some(area(true, vec![
                widget_page("w1", vec![], vec![clock("c1", 0, 0)]),
                widget_page("w2", vec![], vec![clock("c2", 0, 0)]),
            ])))))
            .collect();
        let mut deck = config(pages);
        normalize_deck_layout(&mut deck);
        validate_deck_config(&deck).unwrap();
        assert_eq!(deck.profiles[0].pages.len(), MAX_PAGES);
        assert!(deck.migration_notes[0].contains("could not be kept"));
    }

    fn folder_button(id: &str, folder: &str, row: u8, column: u8) -> Value {
        let mut value = button(id, row, column);
        value["action"] = json!({ "type": "open_folder", "folderId": folder });
        value
    }

    fn with_folder(buttons: Vec<Value>, folders: Vec<Value>) -> DeckConfig {
        let mut value = page("a", "Alpha", buttons, None);
        value["folders"] = json!(folders);
        config(vec![value])
    }

    fn folder(id: &str, buttons: Vec<Value>) -> Value {
        json!({ "id": id, "name": id, "rows": 2, "columns": 2, "buttons": buttons, "widgets": [] })
    }

    #[test]
    fn folders_validate_and_clean_up() {
        let mut deck = with_folder(vec![folder_button("fb", "f1", 0, 0)], vec![folder("f1", vec![button("inner", 0, 0)])]);
        normalize_deck_layout(&mut deck);
        validate_deck_config(&deck).unwrap();

        // A folder button for a missing folder and a folder without a button are both dropped.
        let mut deck = with_folder(vec![folder_button("fb", "gone", 0, 0), button("b", 0, 1)], vec![folder("orphan", vec![])]);
        normalize_deck_layout(&mut deck);
        validate_deck_config(&deck).unwrap();
        assert_eq!((deck.profiles[0].pages[0].buttons.len(), deck.profiles[0].pages[0].folders.len()), (1, 0));

        // Two buttons for one folder: the second goes.
        let mut deck = with_folder(vec![folder_button("fb", "f1", 0, 0), folder_button("fb2", "f1", 0, 1)], vec![folder("f1", vec![])]);
        normalize_deck_layout(&mut deck);
        validate_deck_config(&deck).unwrap();
        assert_eq!(deck.profiles[0].pages[0].buttons.len(), 1);

        // A folder button inside a folder is removed.
        let mut deck = with_folder(vec![folder_button("fb", "f1", 0, 0)], vec![folder("f1", vec![folder_button("deep", "f1", 0, 0)])]);
        normalize_deck_layout(&mut deck);
        validate_deck_config(&deck).unwrap();
        assert!(deck.profiles[0].pages[0].folders[0].buttons.is_empty());
    }

    #[test]
    fn invalid_folders_are_rejected() {
        // Reusing an id across the page and a folder.
        let deck = with_folder(vec![folder_button("fb", "f1", 0, 0)], vec![folder("f1", vec![button("fb", 0, 0)])]);
        assert!(validate_deck_config(&deck).is_err());
        // A folder button that was never normalized and points nowhere.
        let deck = with_folder(vec![folder_button("fb", "gone", 0, 0)], vec![]);
        assert!(validate_deck_config(&deck).is_err());
        // An overlapping item in a folder.
        let deck = with_folder(vec![folder_button("fb", "f1", 0, 0)], vec![folder("f1", vec![button("x", 0, 0), button("y", 0, 0)])]);
        assert!(validate_deck_config(&deck).is_err());
        // Widgets and buttons overlapping on a page.
        let mut value = page("a", "Alpha", vec![button("b", 0, 0)], None);
        value["widgets"] = json!([clock("c", 0, 0)]);
        assert!(validate_deck_config(&config(vec![value])).is_err());
    }

    #[test]
    fn older_phones_get_widgets_in_an_area_and_no_folders() {
        let mut value = page("a", "Alpha", vec![folder_button("fb", "f1", 0, 0), button("b", 0, 1)], None);
        value["folders"] = json!([folder("f1", vec![button("inner", 0, 0)])]);
        value["widgets"] = json!([clock("c", 1, 0)]);
        let mut widgets_only = page("b", "Beta", vec![], None);
        widgets_only["widgets"] = json!([clock("c2", 0, 0)]);
        let mut deck = config(vec![value, widgets_only]);
        normalize_deck_layout(&mut deck);
        validate_deck_config(&deck).unwrap();

        let old = config_for_protocol(&deck, 1);
        let pages = old["profiles"][0]["pages"].as_array().unwrap();
        assert_eq!(pages[0]["buttons"].as_array().unwrap().len(), 1);
        assert!(pages[0].get("folders").is_none() && pages[0].get("widgets").is_none());
        assert_eq!(pages[0]["widgetArea"]["pages"][0]["widgets"].as_array().unwrap().len(), 1);
        assert_eq!((pages[1]["rows"].clone(), pages[1]["columns"].clone()), (json!(0), json!(0)));
        assert!(old.get("migrationNotes").is_none());

        let new = config_for_protocol(&deck, 2);
        assert!(new["profiles"][0]["pages"][0]["folders"].is_array());
    }

    #[test]
    fn older_phones_keep_a_valid_selection_when_pages_are_cut() {
        let pages = (0..10).map(|index| page(&format!("p{index}"), &format!("P{index}"), vec![], None)).collect();
        let mut deck = config(pages);
        deck.profiles[0].active_page_id = "p9".into();
        deck.profiles[0].default_page_id = "p9".into();
        let old = config_for_protocol(&deck, 1);
        assert_eq!(old["profiles"][0]["pages"].as_array().unwrap().len(), 8);
        assert_eq!(old["profiles"][0]["activePageId"], "p0");
        assert_eq!(old["profiles"][0]["defaultPageId"], "p0");
    }
}

#[cfg(test)]
mod installed_apps_tests {
    use super::*;

    #[test]
    fn scans_bundles_and_skips_helpers() {
        let root = std::env::temp_dir().join(format!("open-dock-apps-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for path in ["Alpha.app/Contents", "Utilities/Beta.app/Contents", "Deep/One/Two/Three/Gamma.app", "alpha.app", "Folder/Readme.app", "Uninstall Alpha.app"] {
            fs::create_dir_all(root.join(path)).unwrap();
        }
        let names = |helpers: bool, depth: usize| scan_apps(&[root.clone()], "app", depth, helpers).into_iter().map(|app| app.name).collect::<Vec<_>>();
        // Bundles are found in folders, not entered, and the same name is listed once.
        assert_eq!(names(false, 2), ["Alpha", "Beta", "Readme", "Uninstall Alpha"]);
        // Helper shortcuts are dropped on request, and depth limits how far folders are searched.
        assert_eq!(names(true, 2), ["Alpha", "Beta"]);
        assert_eq!(names(true, 4), ["Alpha", "Beta", "Gamma"]);
        // A missing root is just empty.
        assert!(scan_apps(&[root.join("missing")], "app", 2, false).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_lists_store_apps_and_reads_their_icons() {
        use super::win_apps::{is_helper, tidy};
        // Pure rules first: helpers go, a name that merely contains "help" stays, ids are not repeated.
        assert!(is_helper("Uninstall Foo") && is_helper("Foo Release Notes") && !is_helper("Get Help") && !is_helper("Helper Tool"));
        let tidied = tidy(vec![("Zed".into(), "z".into()), ("Alpha".into(), "a".into()), ("Alpha again".into(), "A".into()), (" ".into(), "b".into()), ("Uninstall Zed".into(), "u".into()), ("Zip Help".into(), r"C:\Zip\zip.chm".into())]);
        assert_eq!(tidied.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["Alpha", "Zed"]);
        // Then this PC's real list: it has far more than the Start Menu shortcuts, and every row can be launched.
        let apps = tauri::async_runtime::block_on(list_installed_apps()).unwrap();
        println!("{} apps", apps.len());
        for app in apps.iter().filter(|app| app.path.starts_with(win_apps::SHELL_PREFIX)).take(8) {
            println!("store: {} -> {}", app.name, app.path);
        }
        for wanted in ["Apple Music", "Calculator", "Netflix", "Spotify"] {
            println!("{wanted}: {:?}", apps.iter().find(|app| app.name == wanted).map(|app| &app.path));
        }
        assert!(apps.iter().all(|app| !app.path.to_lowercase().ends_with(".chm")));
        let store: Vec<_> = apps.iter().filter(|app| app.path.starts_with(win_apps::SHELL_PREFIX)).collect();
        assert!(!store.is_empty(), "no Store apps listed");
        // Icons for a Store app and a desktop app come back as PNGs.
        for app in store.iter().take(3).copied().chain(apps.iter().find(|app| !app.path.starts_with(win_apps::SHELL_PREFIX))) {
            let icon = read_app_icon(app.path.clone(), true).unwrap_or_else(|error| panic!("{}: {error}", app.name));
            assert!(icon.starts_with("data:image/png;base64,"), "{}", app.name);
        }
    }
}

#[cfg(test)]
mod appearance_tests {
    use super::clean_appearance;

    #[test]
    fn appearance_is_one_of_three_words() {
        let cleaned = ["light", " dark
", "system", "", "Dark; rm"].map(clean_appearance);
        assert_eq!(cleaned, ["light", "dark", "system", "system", "system"]);
    }
}
