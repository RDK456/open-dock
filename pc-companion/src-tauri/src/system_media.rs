use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use super::PlaybackState;

#[cfg(any(windows, target_os = "macos"))]
const MAX_ARTWORK_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SystemMediaState {
    pub(super) source_app_id: Option<String>,
    /// A readable name for the app, such as "Spotify".
    pub(super) source_name: Option<String>,
    pub(super) title: Option<String>,
    pub(super) artist: Option<String>,
    pub(super) album: Option<String>,
    pub(super) playback_state: PlaybackState,
    pub(super) position_ms: Option<u64>,
    pub(super) duration_ms: Option<u64>,
    pub(super) artwork_data_url: Option<String>,
    pub(super) volume_percent: Option<u8>,
    /// Whether the current player accepts seek requests.
    pub(super) can_seek: bool,
    /// Playback speed while playing; 0 while a browser buffers. Missing means normal speed.
    pub(super) playback_rate: Option<f64>,
}

impl SystemMediaState {
    pub(super) fn unavailable() -> Self {
        Self {
            source_app_id: None,
            source_name: None,
            title: None,
            artist: None,
            album: None,
            playback_state: PlaybackState::Unavailable,
            position_ms: None,
            duration_ms: None,
            artwork_data_url: None,
            volume_percent: read_system_volume(),
            can_seek: false,
            playback_rate: None,
        }
    }

    pub(super) fn same_content(&self, other: &Self) -> bool {
        self.source_app_id == other.source_app_id
            && self.title == other.title
            && self.artist == other.artist
            && self.album == other.album
            && self.artwork_data_url == other.artwork_data_url
            && self.can_seek == other.can_seek
    }
}

/// Polls the system media session once a second, and every 150 ms for 2 s after `refresh` fires
/// (a control was just sent), so play/pause and track changes show up quickly.
/// What a phone last heard about playback, to decide whether a newer reading is worth sending.
#[derive(Clone, Debug)]
pub(super) struct ProgressSent {
    at: std::time::Instant,
    state: PlaybackState,
    position_ms: Option<u64>,
    duration_ms: Option<u64>,
    volume_percent: Option<u8>,
    playback_rate: Option<f64>,
}

impl ProgressSent {
    pub(super) fn new(media: &SystemMediaState, at: std::time::Instant) -> Self {
        Self {
            at,
            state: media.playback_state,
            position_ms: media.position_ms,
            duration_ms: media.duration_ms,
            volume_percent: media.volume_percent,
            playback_rate: media.playback_rate,
        }
    }
}

/// How far the position may stray from where the phone thinks it is before it counts as a seek.
const SEEK_JUMP_MS: i64 = 1500;
/// A correction this often keeps the phone's counted-forward position from drifting.
const PROGRESS_CORRECTION: std::time::Duration = std::time::Duration::from_secs(10);

/// The phone counts the play position forward on its own, so a progress message is only worth its
/// radio wake-up when something else changed, the position jumped (a seek), or a correction is due.
pub(super) fn progress_worth_sending(last: Option<&ProgressSent>, media: &SystemMediaState, now: std::time::Instant) -> bool {
    let Some(last) = last else { return true };
    if last.state != media.playback_state
        || last.duration_ms != media.duration_ms
        || last.volume_percent != media.volume_percent
        || last.playback_rate != media.playback_rate
        || now.duration_since(last.at) >= PROGRESS_CORRECTION
    {
        return true;
    }
    let (Some(then), Some(position)) = (last.position_ms, media.position_ms) else {
        return last.position_ms != media.position_ms;
    };
    let rate = if last.state == PlaybackState::Playing { last.playback_rate.unwrap_or(1.0) } else { 0.0 };
    let expected = then as f64 + now.duration_since(last.at).as_millis() as f64 * rate;
    (position as f64 - expected).abs() as i64 > SEEK_JUMP_MS
}

pub(super) fn spawn_system_media_monitor(
    updates: watch::Sender<SystemMediaState>,
    refresh: std::sync::Arc<tokio::sync::Notify>,
    app: AppHandle,
) {
    #[cfg(target_os = "macos")]
    mac_adapter::start(&app);
    tauri::async_runtime::spawn(async move {
        #[cfg(windows)]
        let mut manager = None;
        #[cfg(windows)]
        let mut artwork_track_key = None;
        #[cfg(windows)]
        let mut artwork_cache = None;
        #[cfg(windows)]
        let mut last_artwork_attempt = None;
        let mut last_media_content: Option<SystemMediaState> = None;
        let mut fast_until = std::time::Instant::now();

        loop {
            let snapshot = read_system_media_state(
                #[cfg(windows)]
                &mut manager,
                #[cfg(windows)]
                &mut artwork_track_key,
                #[cfg(windows)]
                &mut artwork_cache,
                #[cfg(windows)]
                &mut last_artwork_attempt,
            )
            .await;
            // Where the system reports one app only (macOS), that app is the only player; Windows lists
            // every player itself while reading.
            #[cfg(not(windows))]
            crate::media_players::resolve_and_publish(
                crate::media_players::single_player(snapshot.source_app_id.as_deref(), snapshot.playback_state, snapshot.title.as_deref(), snapshot.artist.as_deref()),
                snapshot.source_app_id.as_deref(),
            );
            let updated = updates.send_if_modified(|current| {
                if *current == snapshot {
                    false
                } else {
                    *current = snapshot.clone();
                    true
                }
            });
            if updated {
                if last_media_content
                    .as_ref()
                    .is_none_or(|previous| !previous.same_content(&snapshot))
                {
                    last_media_content = Some(snapshot.clone());
                    let _ = app.emit("system-media-state", &snapshot);
                } else {
                    let _ = app.emit(
                        "system-media-progress",
                        serde_json::json!({
                            "playbackState": snapshot.playback_state,
                            "positionMs": snapshot.position_ms,
                            "durationMs": snapshot.duration_ms,
                            "volumePercent": snapshot.volume_percent,
                            "playbackRate": snapshot.playback_rate,
                        }),
                    );
                }
            }
            let wait = if std::time::Instant::now() < fast_until {
                std::time::Duration::from_millis(150)
            } else {
                std::time::Duration::from_secs(1)
            };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = refresh.notified() => {
                    fast_until = std::time::Instant::now() + std::time::Duration::from_secs(2);
                }
            }
        }
    });
}

#[cfg(windows)]
mod windows_players {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    use super::bounded_text;
    use crate::media_players::{self, PlayerInfo, Preference};
    use crate::{MediaCommand, PlaybackState};

    pub(super) fn state_of(session: &Session) -> PlaybackState {
        session
            .GetPlaybackInfo()
            .and_then(|info| info.PlaybackStatus())
            .map(|status| match status {
                Status::Playing => PlaybackState::Playing,
                Status::Paused | Status::Opened | Status::Changing => PlaybackState::Paused,
                Status::Closed | Status::Stopped => PlaybackState::Stopped,
                _ => PlaybackState::Unavailable,
            })
            .unwrap_or(PlaybackState::Unavailable)
    }

    fn read_text(session: &Session) -> (Option<String>, Option<String>) {
        let Some(properties) = session.TryGetMediaPropertiesAsync().ok().and_then(|operation| operation.join().ok()) else {
            return (None, None);
        };
        (
            properties.Title().ok().and_then(|value| bounded_text(value.to_string(), 120)),
            properties.Artist().ok().and_then(|value| bounded_text(value.to_string(), 120)),
        )
    }

    pub(super) struct Selection {
        /// The session the controls and the playback state follow.
        pub(super) session: Option<Session>,
        /// The app Windows itself calls current.
        pub(super) windows_current: Option<String>,
    }

    /// Lists every media app, resolves which one to follow, and picks its session. The full read (`with_text`)
    /// also reads titles and publishes the list for the phones; the quick one only needs the playback state.
    pub(super) fn select(manager: &Manager, with_text: bool) -> Selection {
        let current = manager.GetCurrentSession().ok();
        let windows_current = current
            .as_ref()
            .and_then(|session| session.SourceAppUserModelId().ok())
            .and_then(|id| bounded_text(id.to_string(), 256));
        let mut pairs: Vec<(Session, PlayerInfo)> = Vec::new();
        if let Ok(list) = manager.GetSessions() {
            for index in 0..list.Size().unwrap_or(0) {
                let Ok(session) = list.GetAt(index) else { continue };
                let Some(id) = session.SourceAppUserModelId().ok().and_then(|id| bounded_text(id.to_string(), 256)) else { continue };
                // Several windows of one app share an id; the first stands for all.
                if pairs.iter().any(|(_, known)| known.id == id) {
                    continue;
                }
                let (title, artist) = if with_text { read_text(&session) } else { (None, None) };
                let info = PlayerInfo { name: media_players::friendly_name(&id), state: state_of(&session), id, title, artist };
                pairs.push((session, info));
            }
        }
        let infos: Vec<PlayerInfo> = pairs.iter().map(|(_, info)| info.clone()).collect();
        let controlling = if with_text {
            media_players::resolve_and_publish(infos, windows_current.as_deref()).controlling
        } else {
            media_players::build_snapshot(&media_players::preference(), infos, windows_current.as_deref(), true).0.controlling
        };
        let session = controlling
            .and_then(|id| pairs.into_iter().find(|(_, info)| info.id == id).map(|(session, _)| session))
            .or(current);
        Selection { session, windows_current }
    }

    /// Sends a playback command straight to the chosen player when the system media keys would reach a
    /// different one (a pinned player, or Auto following another app). `None` means: use the media keys.
    pub(crate) fn control(command: MediaCommand) -> Option<Result<(), String>> {
        let manager = Manager::RequestAsync().ok()?.join().ok()?;
        let selection = select(&manager, false);
        let session = selection.session?;
        let chosen = session.SourceAppUserModelId().ok().and_then(|id| bounded_text(id.to_string(), 256));
        let pinned = matches!(media_players::preference(), Preference::Pinned(_));
        if !pinned && chosen == selection.windows_current {
            return None;
        }
        let accepted = match command {
            MediaCommand::PlayPause => session.TryTogglePlayPauseAsync().ok()?.join().ok()?,
            MediaCommand::NextTrack => session.TrySkipNextAsync().ok()?.join().ok()?,
            MediaCommand::PreviousTrack => session.TrySkipPreviousAsync().ok()?.join().ok()?,
            _ => return None,
        };
        accepted.then_some(Ok(()))
    }
}

#[cfg(windows)]
pub(super) use windows_players::control as control_selected_player;

/// The playback state of the player the controls follow.
#[cfg(windows)]
pub(super) async fn selected_playback_state() -> PlaybackState {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as SessionManager;

    let Ok(operation) = SessionManager::RequestAsync() else {
        return PlaybackState::Unavailable;
    };
    let Ok(manager) = operation.await else {
        return PlaybackState::Unavailable;
    };
    match windows_players::select(&manager, false).session {
        Some(session) => windows_players::state_of(&session),
        None => PlaybackState::Stopped,
    }
}

#[cfg(windows)]
async fn read_system_media_state(
    manager: &mut Option<windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager>,
    artwork_track_key: &mut Option<(String, std::time::Instant)>,
    artwork_cache: &mut Option<String>,
    last_artwork_attempt: &mut Option<std::time::Instant>,
) -> SystemMediaState {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    if manager.is_none() {
        let Ok(operation) = SessionManager::RequestAsync() else {
            return SystemMediaState::unavailable();
        };
        let Ok(requested) = operation.await else {
            return SystemMediaState::unavailable();
        };
        *manager = Some(requested);
    }

    let Some(manager) = manager.as_ref() else {
        return SystemMediaState::unavailable();
    };
    let Some(session) = windows_players::select(manager, true).session else {
        return SystemMediaState::unavailable();
    };
    let Ok(properties_operation) = session.TryGetMediaPropertiesAsync() else {
        return SystemMediaState::unavailable();
    };
    let Ok(properties) = properties_operation.await else {
        return SystemMediaState::unavailable();
    };

    let source_app_id = session
        .SourceAppUserModelId()
        .ok()
        .and_then(|value| bounded_text(value.to_string(), 256));
    let title = properties
        .Title()
        .ok()
        .and_then(|value| bounded_text(value.to_string(), 512));
    let artist = properties
        .Artist()
        .ok()
        .and_then(|value| bounded_text(value.to_string(), 512));
    let album = properties
        .AlbumTitle()
        .ok()
        .and_then(|value| bounded_text(value.to_string(), 512));

    // Artwork first: reading it can take a moment, and the position read below should be as fresh
    // as possible when it goes out, so the phone's clock starts from the right place.
    let track_key = format!(
        "{}\0{}\0{}\0{}",
        source_app_id.as_deref().unwrap_or_default(),
        title.as_deref().unwrap_or_default(),
        artist.as_deref().unwrap_or_default(),
        album.as_deref().unwrap_or_default()
    );
    let track_changed = artwork_track_key.as_ref().map(|(key, _)| key.as_str()) != Some(track_key.as_str());
    if track_changed {
        *artwork_track_key = Some((track_key, std::time::Instant::now()));
    }
    // Browsers often publish their own app icon first and swap in the real artwork later without
    // changing the title, so the thumbnail is re-read for the same track too: every poll for the
    // first 15 s, then every 3 s while there is none, else every 10 s.
    let track_age = artwork_track_key
        .as_ref()
        .map(|(_, started)| started.elapsed())
        .unwrap_or_default();
    let refresh_every = if track_age < std::time::Duration::from_secs(15) {
        std::time::Duration::ZERO
    } else if artwork_cache.is_none() {
        std::time::Duration::from_secs(3)
    } else {
        std::time::Duration::from_secs(10)
    };
    let refresh_due = last_artwork_attempt
        .is_none_or(|last_attempt| last_attempt.elapsed() >= refresh_every);
    if track_changed || refresh_due {
        let artwork = read_artwork(&properties);
        // A failed re-read keeps the artwork already shown; a new track never keeps the old one.
        if track_changed || artwork.is_some() {
            *artwork_cache = artwork;
        }
        *last_artwork_attempt = Some(std::time::Instant::now());
    }
    let playback_state = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .map(|status| match status {
            Status::Playing => PlaybackState::Playing,
            Status::Paused | Status::Opened | Status::Changing => PlaybackState::Paused,
            Status::Closed | Status::Stopped => PlaybackState::Stopped,
            _ => PlaybackState::Unavailable,
        })
        .unwrap_or(PlaybackState::Unavailable);

    let can_seek = session
        .GetPlaybackInfo()
        .and_then(|info| info.Controls())
        .and_then(|controls| controls.IsPlaybackPositionEnabled())
        .unwrap_or(false);

    // Browsers stay "playing" at rate 0 while they buffer or show an ad. Players that publish no
    // rate are taken to play at normal speed.
    let playback_rate = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackRate())
        .and_then(|rate| rate.Value())
        .ok()
        .filter(|rate| rate.is_finite())
        .map(|rate| rate.clamp(0.0, 16.0));

    let (position_ms, duration_ms) = session
        .GetTimelineProperties()
        .ok()
        .and_then(|timeline| {
            let start = timeline.StartTime().ok()?.Duration.max(0);
            let end = timeline.EndTime().ok()?.Duration;
            let mut position = timeline.Position().ok()?.Duration;
            let duration = end.saturating_sub(start);
            // Many players (Spotify, browsers) only refresh Position on events, so add the
            // time played since it was last reported, at the current rate. Synced lyrics depend on this.
            if playback_state == PlaybackState::Playing {
                if let Ok(updated) = timeline.LastUpdatedTime() {
                    let elapsed = windows_now_ticks().saturating_sub(updated.UniversalTime);
                    if updated.UniversalTime > 0 && (0..=duration).contains(&elapsed) {
                        let played = (elapsed as f64 * playback_rate.unwrap_or(1.0)) as i64;
                        position = position.saturating_add(played);
                    }
                }
            }
            (duration > 0).then(|| {
                (
                    Some(position.saturating_sub(start).clamp(0, duration) as u64 / 10_000),
                    Some(duration as u64 / 10_000),
                )
            })
        })
        .unwrap_or((None, None));

    SystemMediaState {
        source_name: source_app_id.as_deref().map(crate::media_players::friendly_name),
        source_app_id,
        title,
        artist,
        album,
        playback_state,
        position_ms,
        duration_ms,
        artwork_data_url: artwork_cache.clone(),
        volume_percent: read_system_volume(),
        can_seek,
        playback_rate: (playback_state == PlaybackState::Playing).then_some(playback_rate).flatten(),
    }
}

#[cfg(windows)]
pub(super) fn read_system_volume() -> Option<u8> {
    use windows::Win32::{
        Media::Audio::{
            eConsole, eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator,
            MMDeviceEnumerator,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
        },
    };

    unsafe {
        let initialized_here = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result = (|| {
            let devices: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let endpoint = devices.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let volume: IAudioEndpointVolume = endpoint.Activate(CLSCTX_ALL, None).ok()?;
            let level = volume.GetMasterVolumeLevelScalar().ok()?;
            Some((level.clamp(0.0, 1.0) * 100.0).round() as u8)
        })();
        if initialized_here {
            CoUninitialize();
        }
        result
    }
}

/// Reads the default output device's volume through CoreAudio. This runs every second while
/// something plays, so it must not start a process: a child that touches AppKit is registered by
/// macOS as another Open Dock and shows a bouncing Open Dock icon in the Dock.
#[cfg(target_os = "macos")]
pub(super) fn read_system_volume() -> Option<u8> {
    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }
    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectHasProperty(object: u32, address: *const Address) -> u8;
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const std::ffi::c_void,
            size: *mut u32,
            data: *mut std::ffi::c_void,
        ) -> i32;
    }
    const SYSTEM_OBJECT: u32 = 1;
    const DEFAULT_OUTPUT_DEVICE: u32 = u32::from_be_bytes(*b"dOut");
    const GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const OUTPUT: u32 = u32::from_be_bytes(*b"outp");
    // The volume the menu bar slider shows; devices without it have per-channel volumes.
    const VIRTUAL_MAIN_VOLUME: u32 = u32::from_be_bytes(*b"vmvc");
    const VOLUME_SCALAR: u32 = u32::from_be_bytes(*b"volm");

    fn read<T: Default>(object: u32, selector: u32, scope: u32, element: u32) -> Option<T> {
        let address = Address { selector, scope, element };
        let mut value = T::default();
        let mut size = std::mem::size_of::<T>() as u32;
        // SAFETY: `value` is a plain number of `size` bytes, and the address outlives the calls.
        unsafe {
            if AudioObjectHasProperty(object, &address) == 0 {
                return None;
            }
            let status = AudioObjectGetPropertyData(object, &address, 0, std::ptr::null(), &mut size, &mut value as *mut T as *mut _);
            (status == 0 && size as usize == std::mem::size_of::<T>()).then_some(value)
        }
    }

    let device: u32 = read(SYSTEM_OBJECT, DEFAULT_OUTPUT_DEVICE, GLOBAL, 0).filter(|&id| id != 0)?;
    let scalar = read::<f32>(device, VIRTUAL_MAIN_VOLUME, OUTPUT, 0)
        .or_else(|| read::<f32>(device, VOLUME_SCALAR, OUTPUT, 0))
        .or_else(|| {
            let channels: Vec<f32> = [1, 2].iter().filter_map(|&channel| read(device, VOLUME_SCALAR, OUTPUT, channel)).collect();
            (!channels.is_empty()).then(|| channels.iter().sum::<f32>() / channels.len() as f32)
        })?;
    Some((scalar.clamp(0.0, 1.0) * 100.0).round() as u8)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(super) fn read_system_volume() -> Option<u8> {
    None
}

pub(super) fn set_system_volume(percent: u8) -> Result<(), String> {
    let percent = percent.min(100);
    #[cfg(windows)]
    {
        use windows::Win32::{
            Media::Audio::{
                eConsole, eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator,
                MMDeviceEnumerator,
            },
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
            },
        };
        unsafe {
            let initialized_here = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let result = (|| {
                let devices: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                        .map_err(|error| error.to_string())?;
                let endpoint = devices
                    .GetDefaultAudioEndpoint(eRender, eConsole)
                    .map_err(|error| error.to_string())?;
                let volume: IAudioEndpointVolume = endpoint
                    .Activate(CLSCTX_ALL, None)
                    .map_err(|error| error.to_string())?;
                volume
                    .SetMasterVolumeLevelScalar(percent as f32 / 100.0, std::ptr::null())
                    .map_err(|error| error.to_string())
            })();
            if initialized_here {
                CoUninitialize();
            }
            return result;
        }
    }
    #[cfg(target_os = "macos")]
    {
        let result = std::process::Command::new("osascript")
            .args(["-e", &format!("set volume output volume {percent}")])
            .status()
            .map_err(|error| error.to_string())?;
        if result.success() {
            Ok(())
        } else {
            Err("Could not set system output volume".into())
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = percent;
        Err("System volume control is not supported on this platform".into())
    }
}

/// Moves the current player to `position_ms` from the start of the track.
#[cfg(windows)]
pub(super) async fn seek(position_ms: u64) -> Result<(), String> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as SessionManager;

    let manager = SessionManager::RequestAsync()
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())?;
    let session = windows_players::select(&manager, false).session.ok_or("No media player is running")?;
    let start = session
        .GetTimelineProperties()
        .and_then(|timeline| timeline.StartTime())
        .map(|time| time.Duration.max(0))
        .unwrap_or(0);
    let ticks = i64::try_from(position_ms)
        .ok()
        .and_then(|ms| ms.checked_mul(10_000))
        .and_then(|offset| offset.checked_add(start))
        .ok_or("Seek position is out of range")?;
    let accepted = session
        .TryChangePlaybackPositionAsync(ticks)
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())?;
    if accepted {
        Ok(())
    } else {
        Err("The player refused the seek".into())
    }
}

#[cfg(target_os = "macos")]
pub(super) async fn seek(position_ms: u64) -> Result<(), String> {
    let micros = position_ms.saturating_mul(1000).to_string();
    tauri::async_runtime::spawn_blocking(move || mac_adapter::run(&["seek", &micros]))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(super) async fn seek(_position_ms: u64) -> Result<(), String> {
    Err("Seeking is not supported on this platform".into())
}

/// Current time as a Windows DateTime: 100 ns ticks since 1601-01-01 UTC.
#[cfg(windows)]
fn windows_now_ticks() -> i64 {
    const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
    let since_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    UNIX_EPOCH_TICKS.saturating_add((since_unix.as_nanos() / 100) as i64)
}

#[cfg(any(windows, target_os = "macos"))]
fn bounded_text(value: String, max_chars: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(max_chars).collect())
    }
}

#[cfg(windows)]
fn read_artwork(
    properties: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    use base64::Engine;
    use windows::Storage::Streams::DataReader;

    let reference = properties.Thumbnail().ok()?;
    let stream = reference.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > MAX_ARTWORK_BYTES {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size as u32).ok()?.join().ok()?;
    let mut bytes = vec![0; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let mime = artwork_mime(&bytes)?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(any(windows, target_os = "macos"))]
fn artwork_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
async fn read_system_media_state() -> SystemMediaState {
    match mac_adapter::latest() {
        Some(now_playing) => adapter_media_state(&now_playing, epoch_micros_now(), read_system_volume()),
        None => SystemMediaState::unavailable(),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn read_system_media_state() -> SystemMediaState {
    SystemMediaState::unavailable()
}

/// Play/pause state from macOS's now playing service; unavailable when nothing reports any.
#[cfg(target_os = "macos")]
pub(super) fn adapter_playback_state() -> PlaybackState {
    match mac_adapter::latest() {
        Some(now_playing) if now_playing.playing => PlaybackState::Playing,
        Some(_) => PlaybackState::Paused,
        None => PlaybackState::Unavailable,
    }
}

/// Sends a MediaRemote command (play/pause 2, next 4, previous 5) to the player macOS lists as now
/// playing. Unlike media keys it needs no Accessibility permission. With no player reporting, it
/// errors so the caller sends a media key instead, which lets macOS start the last player.
#[cfg(target_os = "macos")]
pub(super) fn send_media_command(command_id: u8) -> Result<(), String> {
    if mac_adapter::latest().is_none() {
        return Err("No app is reporting playback".into());
    }
    mac_adapter::run(&["send", &command_id.to_string()])
}

/// Stops the macOS now playing stream so its perl process doesn't outlive Open Dock.
pub(super) fn shutdown() {
    #[cfg(target_os = "macos")]
    mac_adapter::stop();
}

#[cfg(target_os = "macos")]
fn epoch_micros_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_micros() as f64)
        .unwrap_or(0.0)
}

/// One reading of `mediaremote-adapter.pl stream --no-diff --micros`.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, PartialEq)]
struct AdapterNowPlaying {
    bundle_id: String,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    playing: bool,
    duration_micros: Option<f64>,
    /// Position at `timestamp_epoch_micros`; the player doesn't report it again until something changes.
    elapsed_micros: Option<f64>,
    timestamp_epoch_micros: Option<f64>,
    playback_rate: Option<f64>,
    artwork_data_url: Option<String>,
}

#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl AdapterNowPlaying {
    fn same_track(&self, other: &Self) -> bool {
        self.bundle_id == other.bundle_id
            && self.title == other.title
            && self.artist == other.artist
            && self.album == other.album
    }
}

/// Reads one line of adapter output: `None` for a line that isn't data, `Some(None)` when no player
/// reports anything (an empty payload, or one without the adapter's mandatory keys).
#[cfg(any(target_os = "macos", test))]
fn parse_adapter_line(line: &str) -> Option<Option<AdapterNowPlaying>> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(|kind| kind.as_str()) != Some("data") {
        return None;
    }
    let payload = value.get("payload")?.as_object()?;
    let text = |key: &str, max_chars: usize| {
        payload
            .get(key)
            .and_then(|value| value.as_str())
            .and_then(|value| bounded_text(value.to_owned(), max_chars))
    };
    let number = |key: &str| {
        payload
            .get(key)
            .and_then(|value| value.as_f64())
            .filter(|value| value.is_finite() && *value >= 0.0)
    };
    let (Some(bundle_id), Some(title), Some(playing)) = (
        text("bundleIdentifier", 256),
        text("title", 512),
        payload.get("playing").and_then(|value| value.as_bool()),
    ) else {
        return Some(None);
    };
    Some(Some(AdapterNowPlaying {
        bundle_id,
        title,
        artist: text("artist", 512),
        album: text("album", 512),
        playing,
        duration_micros: number("durationMicros").filter(|duration| *duration > 0.0),
        elapsed_micros: number("elapsedTimeMicros"),
        timestamp_epoch_micros: number("timestampEpochMicros"),
        playback_rate: number("playbackRate").map(|rate| rate.min(16.0)),
        artwork_data_url: payload
            .get("artworkData")
            .and_then(|value| value.as_str())
            .and_then(adapter_artwork),
    }))
}

/// The adapter sends artwork as base64; it's checked like Windows thumbnails before it's shown.
#[cfg(any(target_os = "macos", test))]
fn adapter_artwork(encoded: &str) -> Option<String> {
    use base64::Engine;
    // Base64 is a third larger than the image, so this caps the image at MAX_ARTWORK_BYTES.
    if encoded.len() as u64 > MAX_ARTWORK_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    let mime = artwork_mime(&bytes)?;
    Some(format!("data:{mime};base64,{encoded}"))
}

#[cfg(any(target_os = "macos", test))]
fn adapter_media_state(
    now_playing: &AdapterNowPlaying,
    now_epoch_micros: f64,
    volume_percent: Option<u8>,
) -> SystemMediaState {
    // Players report the position as of `timestamp`, so while playing add the time since then at
    // the current rate. Synced lyrics depend on this, as on Windows.
    let rate = if now_playing.playing { now_playing.playback_rate.unwrap_or(1.0) } else { 0.0 };
    let (position_ms, duration_ms) = match (now_playing.elapsed_micros, now_playing.duration_micros) {
        (Some(elapsed), Some(duration)) => {
            let since = now_playing
                .timestamp_epoch_micros
                .map_or(0.0, |at| (now_epoch_micros - at).max(0.0));
            let position = (elapsed + since * rate).min(duration);
            (Some((position / 1000.0) as u64), Some((duration / 1000.0) as u64))
        }
        (None, Some(duration)) => (None, Some((duration / 1000.0) as u64)),
        _ => (None, None),
    };
    SystemMediaState {
        source_app_id: Some(now_playing.bundle_id.clone()),
        source_name: Some(crate::media_players::friendly_name(&now_playing.bundle_id)),
        title: Some(now_playing.title.clone()),
        artist: now_playing.artist.clone(),
        album: now_playing.album.clone(),
        playback_state: if now_playing.playing { PlaybackState::Playing } else { PlaybackState::Paused },
        position_ms,
        duration_ms,
        artwork_data_url: now_playing.artwork_data_url.clone(),
        volume_percent,
        can_seek: duration_ms.is_some(),
        playback_rate: if now_playing.playing { now_playing.playback_rate } else { None },
    }
}

/// Now playing on macOS through mediaremote-adapter (BSD-3-Clause,
/// https://github.com/ungive/mediaremote-adapter). Since macOS 15.4 only Apple-signed processes may
/// read MediaRemote, so the adapter's script runs in the system's /usr/bin/perl and loads its
/// framework there. Release builds bundle both (scripts/build-mediaremote-adapter.sh); a build
/// without them reports media as unavailable, as before.
#[cfg(target_os = "macos")]
mod mac_adapter {
    use super::{parse_adapter_line, AdapterNowPlaying};
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    const PERL: &str = "/usr/bin/perl";
    const SCRIPT: &str = "mediaremote-adapter.pl";
    const FRAMEWORK: &str = "MediaRemoteAdapter.framework";
    /// The library ships under a plain name: a `.framework` folder inside the app's Resources would
    /// be taken for nested code when the app is signed.
    const BUNDLED_LIBRARY: &str = "MediaRemoteAdapter.dylib";

    struct Paths {
        script: PathBuf,
        framework: PathBuf,
    }

    static PATHS: OnceLock<Paths> = OnceLock::new();
    static LATEST: Mutex<Option<AdapterNowPlaying>> = Mutex::new(None);
    static STREAM: Mutex<Option<Child>> = Mutex::new(None);
    static STOPPING: AtomicBool = AtomicBool::new(false);

    pub(super) fn start(app: &AppHandle) {
        match install(app) {
            Ok(paths) => {
                if PATHS.set(paths).is_ok() {
                    std::thread::spawn(stream_forever);
                }
            }
            Err(error) => eprintln!("Now playing on macOS is off: {error}"),
        }
    }

    pub(super) fn latest() -> Option<AdapterNowPlaying> {
        LATEST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    pub(super) fn stop() {
        STOPPING.store(true, Ordering::SeqCst);
        if let Some(mut child) = STREAM.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Runs one adapter command (`seek`, `send`) and waits up to 3 s for it to finish.
    pub(super) fn run(args: &[&str]) -> Result<(), String> {
        let paths = PATHS.get().ok_or("The now playing adapter isn't installed")?;
        let mut child = Command::new(PERL)
            .arg(&paths.script)
            .arg(&paths.framework)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("The now playing adapter failed ({status})"))
                };
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The now playing adapter didn't answer".into());
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    /// Copies the bundled adapter out of the app before use. Files inside a downloaded app carry
    /// the quarantine flag, which can stop macOS loading the library into perl; files Open Dock writes
    /// itself don't. Each file is replaced through a rename so a running copy is never rewritten.
    fn install(app: &AppHandle) -> Result<Paths, String> {
        let source = app.path().resource_dir().map_err(|error| error.to_string())?.join("mediaremote");
        let target = app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("mediaremote");
        // The script loads FRAMEWORK/MediaRemoteAdapter, so the library goes back into that layout.
        let files = [(SCRIPT, SCRIPT.to_owned()), (BUNDLED_LIBRARY, format!("{FRAMEWORK}/MediaRemoteAdapter"))];
        for (bundled, installed) in files {
            let bytes = std::fs::read(source.join(bundled)).map_err(|error| format!("{bundled}: {error}"))?;
            let destination = target.join(installed);
            if std::fs::read(&destination).ok().as_deref() == Some(bytes.as_slice()) {
                continue;
            }
            let folder = destination.parent().ok_or("Invalid adapter path")?;
            std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
            let staging = folder.join(format!(".{}.new", destination.file_name().and_then(|name| name.to_str()).unwrap_or("adapter")));
            std::fs::write(&staging, &bytes).map_err(|error| error.to_string())?;
            std::fs::rename(&staging, &destination).map_err(|error| error.to_string())?;
        }
        Ok(Paths { script: target.join(SCRIPT), framework: target.join(FRAMEWORK) })
    }

    /// Keeps one `stream` process running and stores its latest reading. A stream that ran for a
    /// while restarts after 2 s; one that keeps exiting backs off to a minute.
    fn stream_forever() {
        let Some(paths) = PATHS.get() else { return };
        let mut retry = Duration::from_secs(1);
        while !STOPPING.load(Ordering::SeqCst) {
            let started = Instant::now();
            match Command::new(PERL)
                .arg(&paths.script)
                .arg(&paths.framework)
                .args(["stream", "--no-diff", "--micros", "--debounce=100"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(mut child) => {
                    let stdout = child.stdout.take();
                    *STREAM.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(child);
                    if STOPPING.load(Ordering::SeqCst) {
                        stop();
                    }
                    if let Some(stdout) = stdout {
                        for line in BufReader::new(stdout).lines() {
                            let Ok(line) = line else { break };
                            if let Some(update) = parse_adapter_line(&line) {
                                store(update);
                            }
                        }
                    }
                    if let Some(mut child) = STREAM.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
                Err(error) => eprintln!("Could not start the now playing adapter: {error}"),
            }
            *LATEST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            retry = if started.elapsed() > Duration::from_secs(60) {
                Duration::from_secs(2)
            } else {
                (retry * 2).min(Duration::from_secs(60))
            };
            std::thread::sleep(retry);
        }
    }

    /// Artwork often arrives after the rest of a track's details, so the last image stays for the
    /// same track until a new one comes; a new track never keeps the old image.
    fn store(update: Option<AdapterNowPlaying>) {
        let mut latest = LATEST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let next = update.map(|mut now_playing| {
            if now_playing.artwork_data_url.is_none() {
                if let Some(previous) = latest.as_ref().filter(|previous| previous.same_track(&now_playing)) {
                    now_playing.artwork_data_url = previous.artwork_data_url.clone();
                }
            }
            now_playing
        });
        *latest = next;
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn playing(position_ms: u64) -> SystemMediaState {
        SystemMediaState {
            playback_state: PlaybackState::Playing,
            position_ms: Some(position_ms),
            duration_ms: Some(240_000),
            volume_percent: Some(50),
            playback_rate: None,
            ..SystemMediaState::unavailable()
        }
    }

    // A 1x1 PNG, as the adapter sends artwork: plain base64.
    const PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    fn adapter_line(payload: &str) -> String {
        format!(r#"{{"type":"data","diff":false,"payload":{payload}}}"#)
    }

    #[test]
    fn reads_adapter_output_like_the_windows_session() {
        let line = adapter_line(&format!(
            r#"{{"bundleIdentifier":"com.apple.Music","playing":true,"title":"Summer Rain","artist":"SAM KIM","album":"Our Beloved Summer","durationMicros":201000000,"elapsedTimeMicros":30000000,"timestampEpochMicros":1791230400000000,"playbackRate":1,"artworkMimeType":"image/png","artworkData":"{PNG_BASE64}"}}"#
        ));
        let now_playing = parse_adapter_line(&line).expect("a data line").expect("media");
        assert_eq!(now_playing.bundle_id, "com.apple.Music");
        assert_eq!(now_playing.title, "Summer Rain");
        assert_eq!(now_playing.artist.as_deref(), Some("SAM KIM"));
        assert!(now_playing.artwork_data_url.as_deref().is_some_and(|url| url.starts_with("data:image/png;base64,")));

        // 2.5 s after the player reported 30 s, the song is at 32.5 s.
        let state = adapter_media_state(&now_playing, 1_791_230_402_500_000.0, Some(40));
        assert_eq!(state.playback_state, PlaybackState::Playing);
        assert_eq!(state.position_ms, Some(32_500));
        assert_eq!(state.duration_ms, Some(201_000));
        assert_eq!(state.playback_rate, Some(1.0));
        assert_eq!(state.volume_percent, Some(40));
        assert_eq!(state.source_app_id.as_deref(), Some("com.apple.Music"));
        assert!(state.can_seek);

        // Never past the end, however stale the report.
        let late = adapter_media_state(&now_playing, 1_791_230_400_000_000.0 + 10_000_000_000.0, None);
        assert_eq!(late.position_ms, Some(201_000));
    }

    #[test]
    fn paused_media_keeps_its_position_and_missing_rate_means_normal_speed() {
        let paused = parse_adapter_line(&adapter_line(
            r#"{"bundleIdentifier":"com.spotify.client","playing":false,"title":"Song","durationMicros":180000000,"elapsedTimeMicros":60000000,"timestampEpochMicros":1000000,"playbackRate":0}"#,
        ))
        .unwrap()
        .unwrap();
        let state = adapter_media_state(&paused, 9_000_000.0, None);
        assert_eq!(state.playback_state, PlaybackState::Paused);
        assert_eq!(state.position_ms, Some(60_000));
        assert_eq!(state.playback_rate, None);

        let no_rate = parse_adapter_line(&adapter_line(
            r#"{"bundleIdentifier":"com.google.Chrome","playing":true,"title":"Video","durationMicros":100000000,"elapsedTimeMicros":0,"timestampEpochMicros":1000000}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(adapter_media_state(&no_rate, 3_000_000.0, None).position_ms, Some(2_000));
    }

    #[test]
    fn nothing_playing_and_junk_lines_are_told_apart() {
        assert_eq!(parse_adapter_line(&adapter_line("{}")), Some(None));
        // Missing a mandatory key (title) counts as nothing playing.
        assert_eq!(parse_adapter_line(&adapter_line(r#"{"bundleIdentifier":"a.b","playing":true}"#)), Some(None));
        assert_eq!(parse_adapter_line("not json"), None);
        assert_eq!(parse_adapter_line(r#"{"type":"other","payload":{}}"#), None);
    }

    #[test]
    fn live_streams_without_a_length_have_no_position() {
        let radio = parse_adapter_line(&adapter_line(
            r#"{"bundleIdentifier":"com.apple.Music","playing":true,"title":"Radio","elapsedTimeMicros":5000000,"timestampEpochMicros":1000000,"durationMicros":0}"#,
        ))
        .unwrap()
        .unwrap();
        let state = adapter_media_state(&radio, 2_000_000.0, None);
        assert_eq!((state.position_ms, state.duration_ms, state.can_seek), (None, None, false));
    }

    #[test]
    fn rejects_artwork_that_is_not_an_image_or_too_large() {
        assert!(adapter_artwork(PNG_BASE64).is_some());
        assert_eq!(adapter_artwork("aGVsbG8="), None, "plain text isn't an image");
        assert_eq!(adapter_artwork("!!!"), None, "not base64");
        assert_eq!(adapter_artwork(&"A".repeat((MAX_ARTWORK_BYTES as usize / 3 + 2) * 4)), None);
    }

    #[test]
    fn sends_progress_only_when_the_phone_cannot_work_it_out() {
        let start = Instant::now();
        let first = playing(10_000);
        assert!(progress_worth_sending(None, &first, start), "the first report always goes");
        let sent = ProgressSent::new(&first, start);
        // Playing steadily: 3 s later the position is 3 s on, which the phone counts itself.
        assert!(!progress_worth_sending(Some(&sent), &playing(13_000), start + Duration::from_secs(3)));
        // A seek: the position jumped.
        assert!(progress_worth_sending(Some(&sent), &playing(60_000), start + Duration::from_secs(3)));
        // Paused: the state changed.
        let paused = SystemMediaState { playback_state: PlaybackState::Paused, ..playing(13_000) };
        assert!(progress_worth_sending(Some(&sent), &paused, start + Duration::from_secs(3)));
        // Volume changed.
        assert!(progress_worth_sending(Some(&sent), &SystemMediaState { volume_percent: Some(60), ..playing(13_000) }, start + Duration::from_secs(3)));
        // A correction every 10 s even when nothing else changed.
        assert!(progress_worth_sending(Some(&sent), &playing(20_000), start + Duration::from_secs(10)));
        // Paused and still: nothing to send.
        let still = ProgressSent::new(&paused, start);
        assert!(!progress_worth_sending(Some(&still), &paused, start + Duration::from_secs(5)));
    }
}
