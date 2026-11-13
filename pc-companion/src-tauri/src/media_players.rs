//! Which media player the phone is talking to. Windows lists every app that registered media controls;
//! this module holds what is platform-neutral: how a player is named, which one a choice resolves to, and
//! the shared choice and snapshot that the Windows reader and the phone connections both use.

use std::sync::Mutex;

use serde::Serialize;

use super::PlaybackState;

/// What the person chose: follow whichever player is playing, or stay on one app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Preference {
    Auto,
    Pinned(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlayerInfo {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) state: PlaybackState,
    pub(super) title: Option<String>,
    pub(super) artist: Option<String>,
}

/// What the phone is told: every player, which one the controls go to, and whether a pinned player vanished.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlayersSnapshot {
    pub(super) players: Vec<PlayerInfo>,
    pub(super) controlling: Option<String>,
    /// Whether the phone may offer a choice of player. macOS reports one app only, so there it may not.
    pub(super) can_switch: bool,
    pub(super) pinned: Option<String>,
    /// The name of a pinned player that closed, until the person next chooses a player.
    pub(super) lost: Option<String>,
}

static PREFERENCE: Mutex<Preference> = Mutex::new(Preference::Auto);
static SNAPSHOT: Mutex<Option<PlayersSnapshot>> = Mutex::new(None);
static LOST: Mutex<Option<String>> = Mutex::new(None);

pub(super) fn preference() -> Preference {
    PREFERENCE.lock().map(|value| value.clone()).unwrap_or(Preference::Auto)
}

/// `None` means Auto.
pub(super) fn set_preference(player_id: Option<String>) {
    if let Ok(mut lost) = LOST.lock() {
        *lost = None;
    }
    if let Ok(mut value) = PREFERENCE.lock() {
        *value = match player_id {
            Some(id) if valid_player_id(&id) => Preference::Pinned(id),
            _ => Preference::Auto,
        };
    }
}

/// Player ids come from the PC's own list, but the phone sends one back, so it is checked like any input.
pub(super) fn valid_player_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

pub(super) fn snapshot() -> Option<PlayersSnapshot> {
    SNAPSHOT.lock().ok().and_then(|value| value.clone())
}

pub(super) fn publish(snapshot: PlayersSnapshot) {
    if let Ok(mut value) = SNAPSHOT.lock() {
        *value = Some(snapshot);
    }
}

pub(super) struct Resolution {
    /// Index into the players that was resolved.
    pub(super) controlling: Option<usize>,
    /// A pinned player is gone, so Auto took over.
    pub(super) pin_lost: bool,
}

/// Auto: the app Windows calls current if it is playing, else any app that is playing, else Windows' choice,
/// else the first one. Pinned: that app while it exists; once it is gone, Auto, and the loss is reported.
pub(super) fn resolve(preference: &Preference, players: &[PlayerInfo], windows_current: Option<&str>) -> Resolution {
    let position = |id: &str| players.iter().position(|player| player.id == id);
    let mut pin_lost = false;
    if let Preference::Pinned(id) = preference {
        match position(id) {
            Some(index) => return Resolution { controlling: Some(index), pin_lost: false },
            None => pin_lost = true,
        }
    }
    let current = windows_current.and_then(position);
    let playing = |index: usize| players[index].state == PlaybackState::Playing;
    let controlling = current
        .filter(|index| playing(*index))
        .or_else(|| (0..players.len()).find(|index| playing(*index)))
        .or(current)
        .or(if players.is_empty() { None } else { Some(0) });
    Resolution { controlling, pin_lost }
}

/// The snapshot for a choice, and whether a pinned player is gone.
pub(super) fn build_snapshot(preference: &Preference, players: Vec<PlayerInfo>, windows_current: Option<&str>, can_switch: bool) -> (PlayersSnapshot, bool) {
    let resolution = resolve(preference, &players, windows_current);
    let snapshot = PlayersSnapshot {
        controlling: resolution.controlling.map(|index| players[index].id.clone()),
        can_switch,
        pinned: match preference {
            Preference::Pinned(id) if !resolution.pin_lost => Some(id.clone()),
            _ => None,
        },
        lost: None,
        players,
    };
    (snapshot, resolution.pin_lost)
}

/// Resolves the current choice for `players`, publishes the result for the phones, and drops back to Auto
/// (remembering the player's name for one notice) when a pinned player has gone.
pub(super) fn resolve_and_publish(players: Vec<PlayerInfo>, windows_current: Option<&str>) -> PlayersSnapshot {
    let preference = preference();
    let (mut snapshot, pin_lost) = build_snapshot(&preference, players, windows_current, cfg!(windows));
    if let (true, Preference::Pinned(id)) = (pin_lost, &preference) {
        if let Ok(mut value) = PREFERENCE.lock() {
            *value = Preference::Auto;
        }
        if let Ok(mut lost) = LOST.lock() {
            *lost = Some(friendly_name(id));
        }
    }
    snapshot.lost = LOST.lock().ok().and_then(|value| value.clone());
    publish(snapshot.clone());
    snapshot
}

/// Where only one app is reported (macOS), that app is the only player.
#[cfg(any(not(windows), test))]
pub(super) fn single_player(source_app_id: Option<&str>, state: PlaybackState, title: Option<&str>, artist: Option<&str>) -> Vec<PlayerInfo> {
    match source_app_id {
        Some(id) if !id.is_empty() => vec![PlayerInfo { id: id.to_owned(), name: friendly_name(id), state, title: title.map(str::to_owned), artist: artist.map(str::to_owned) }],
        _ => Vec::new(),
    }
}

/// Chromium browsers add a per-user hash to their app id ("Helium.EXT476RSTCBNKLTWZBCGD673S4", "Vivaldi.EXT476…"),
/// and Opera adds a number. That tail is not a name.
fn looks_like_hash(part: &str) -> bool {
    part.len() >= 8
        && (part.chars().all(|c| c.is_ascii_digit())
            || (part.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) && part.chars().any(|c| c.is_ascii_digit())))
}

/// A readable name for an app id: "Spotify.exe" and "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" are Spotify,
/// "com.google.Chrome" is Chrome. Unknown apps get their file or package name with a capital letter.
pub(super) fn friendly_name(app_id: &str) -> String {
    const KNOWN: &[(&str, &str)] = &[
        ("spotify", "Spotify"),
        ("msedge", "Microsoft Edge"),
        ("microsoftedge", "Microsoft Edge"),
        ("chromecanary", "Chrome Canary"),
        ("chrome", "Chrome"),
        ("firefox", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vivaldi", "Vivaldi"),
        ("vlc", "VLC"),
        ("wmplayer", "Windows Media Player"),
        ("zunemusic", "Media Player"),
        ("zunevideo", "Movies & TV"),
        ("applemusic", "Apple Music"),
        ("itunes", "iTunes"),
        ("com.apple.music", "Music"),
        ("tidal", "TIDAL"),
        ("deezer", "Deezer"),
        ("foobar2000", "foobar2000"),
        ("mpc-hc", "MPC-HC"),
        ("potplayer", "PotPlayer"),
        ("musicbee", "MusicBee"),
        ("youtubemusic", "YouTube Music"),
        ("amazonmusic", "Amazon Music"),
        ("discord", "Discord"),
        ("phonelink", "Phone Link"),
        ("yourphone", "Phone Link"),
    ];
    let lower = app_id.to_lowercase();
    if let Some((_, name)) = KNOWN.iter().find(|(key, _)| lower.contains(key)) {
        return (*name).to_owned();
    }
    // "Package_family!App" → "App"; a path → its file name; reverse-domain ids → their last part; no ".exe".
    let mut name = app_id.rsplit('!').next().unwrap_or(app_id);
    name = name.rsplit(['\\', '/']).next().unwrap_or(name);
    let name = name.strip_suffix(".exe").or_else(|| name.strip_suffix(".EXE")).unwrap_or(name);
    let name = name.split('_').next().unwrap_or(name);
    let mut parts: Vec<&str> = name.split('.').collect();
    while parts.len() > 1 && parts.last().is_some_and(|part| looks_like_hash(part)) {
        parts.pop();
    }
    let name = parts.last().copied().unwrap_or(name).trim();
    let mut characters = name.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().chain(characters).take(24).collect(),
        None => "Unknown player".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The choice and snapshot are shared by the whole process, so tests that change them take turns.
    static GLOBALS: Mutex<()> = Mutex::new(());

    fn player(id: &str, state: PlaybackState) -> PlayerInfo {
        PlayerInfo { id: id.to_owned(), name: friendly_name(id), state, title: None, artist: None }
    }

    #[test]
    fn names_are_readable() {
        assert_eq!(friendly_name("Spotify.exe"), "Spotify");
        assert_eq!(friendly_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(friendly_name("chrome.exe"), "Chrome");
        assert_eq!(friendly_name("MSEdge"), "Microsoft Edge");
        assert_eq!(friendly_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(friendly_name("com.apple.Music"), "Music");
        assert_eq!(friendly_name("com.google.Chrome"), "Chrome");
        // Chromium browsers tag their id with a per-user hash, which must not become the name.
        assert_eq!(friendly_name("Helium.EXT476RSTCBNKLTWZBCGD673S4"), "Helium");
        assert_eq!(friendly_name("ChromeCanary.EXT476RSTCBNKLTWZBCGD673S4"), "Chrome Canary");
        assert_eq!(friendly_name("Vivaldi.EXT476RSTCBNKLTWZBCGD673S4"), "Vivaldi");
        assert_eq!(friendly_name("OperaSoftware.OperaWebBrowser.1781555376"), "Opera");
        assert_eq!(friendly_name("TheBrowserCompany.Arc_ttt1ap7aakyb4!Arc"), "Arc");
        assert_eq!(friendly_name("Some.Vendor.AwesomePlayer.ABCD1234EFGH"), "AwesomePlayer");
        assert_eq!(friendly_name("C:\\Tools\\fooplayer.exe"), "Fooplayer");
        assert_eq!(friendly_name("Some.Vendor.AwesomePlayer_abc123!App"), "App");
        assert_eq!(friendly_name("Some.Vendor.AwesomePlayer"), "AwesomePlayer");
        assert_eq!(friendly_name(""), "Unknown player");
        assert!(friendly_name(&"x".repeat(200)).chars().count() <= 24);
    }

    #[test]
    fn auto_prefers_a_playing_player() {
        let players = [player("a.exe", PlaybackState::Paused), player("b.exe", PlaybackState::Playing)];
        // Windows says A, but A is paused and B plays: follow B.
        assert_eq!(resolve(&Preference::Auto, &players, Some("a.exe")).controlling, Some(1));
        // Both play: stay with Windows' choice, so it does not flip back and forth.
        let both = [player("a.exe", PlaybackState::Playing), player("b.exe", PlaybackState::Playing)];
        assert_eq!(resolve(&Preference::Auto, &both, Some("b.exe")).controlling, Some(1));
        assert_eq!(resolve(&Preference::Auto, &both, None).controlling, Some(0));
        // None plays: Windows' choice, else the first.
        let idle = [player("a.exe", PlaybackState::Paused), player("b.exe", PlaybackState::Paused)];
        assert_eq!(resolve(&Preference::Auto, &idle, Some("b.exe")).controlling, Some(1));
        assert_eq!(resolve(&Preference::Auto, &idle, Some("gone.exe")).controlling, Some(0));
        assert_eq!(resolve(&Preference::Auto, &[], Some("a.exe")).controlling, None);
    }

    #[test]
    fn a_pinned_player_stays_until_it_is_gone() {
        let players = [player("a.exe", PlaybackState::Paused), player("b.exe", PlaybackState::Playing)];
        let pinned = resolve(&Preference::Pinned("a.exe".into()), &players, Some("b.exe"));
        assert_eq!((pinned.controlling, pinned.pin_lost), (Some(0), false));
        // Pinned to a player that closed: Auto takes over and the loss is reported.
        let lost = resolve(&Preference::Pinned("gone.exe".into()), &players, Some("a.exe"));
        assert_eq!((lost.controlling, lost.pin_lost), (Some(1), true));
        let nothing = resolve(&Preference::Pinned("gone.exe".into()), &[], None);
        assert_eq!((nothing.controlling, nothing.pin_lost), (None, true));
    }

    #[test]
    fn the_snapshot_names_what_it_controls() {
        let players = vec![player("a.exe", PlaybackState::Paused), player("b.exe", PlaybackState::Playing)];
        let (auto, lost) = build_snapshot(&Preference::Auto, players.clone(), None, true);
        assert_eq!((auto.controlling.as_deref(), auto.pinned.as_deref(), lost), (Some("b.exe"), None, false));
        let (pinned, _) = build_snapshot(&Preference::Pinned("a.exe".into()), players.clone(), None, true);
        assert_eq!((pinned.controlling.as_deref(), pinned.pinned.as_deref()), (Some("a.exe"), Some("a.exe")));
        let (gone, lost) = build_snapshot(&Preference::Pinned("zzz".into()), players, None, true);
        assert_eq!((gone.pinned, lost), (None, true));
    }

    #[test]
    fn switching_is_offered_only_where_the_platform_can_do_it() {
        let _turn = GLOBALS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let players = vec![player("a", PlaybackState::Playing)];
        assert!(build_snapshot(&Preference::Auto, players.clone(), None, true).0.can_switch);
        assert!(!build_snapshot(&Preference::Auto, players.clone(), None, false).0.can_switch);
        // The published snapshot follows the platform: Windows lists players, macOS reports one app.
        assert_eq!(resolve_and_publish(players, None).can_switch, cfg!(windows));
        let json = serde_json::to_value(build_snapshot(&Preference::Auto, vec![], None, true).0).unwrap();
        assert_eq!(json["canSwitch"], true);
    }

    #[test]
    fn a_vanished_pin_falls_back_to_auto_and_is_reported_once() {
        let _turn = GLOBALS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let players = |ids: &[&str]| ids.iter().map(|id| player(id, PlaybackState::Playing)).collect::<Vec<_>>();
        set_preference(Some("spotify.exe".into()));
        let present = resolve_and_publish(players(&["spotify.exe", "chrome.exe"]), None);
        assert_eq!((present.pinned.as_deref(), present.lost.as_deref()), (Some("spotify.exe"), None));
        // Spotify closes: Auto takes over and the name is kept for the notice.
        let after = resolve_and_publish(players(&["chrome.exe"]), Some("chrome.exe"));
        assert_eq!((after.controlling.as_deref(), after.pinned, after.lost.as_deref()), (Some("chrome.exe"), None, Some("Spotify")));
        assert_eq!(preference(), Preference::Auto);
        // The notice stays until the person chooses again, even if Spotify comes back.
        assert_eq!(resolve_and_publish(players(&["spotify.exe", "chrome.exe"]), None).lost.as_deref(), Some("Spotify"));
        set_preference(None);
        assert_eq!(resolve_and_publish(players(&["chrome.exe"]), None).lost, None);
        assert_eq!(snapshot().map(|value| value.players.len()), Some(1));
    }

    #[test]
    fn one_app_is_the_only_player() {
        let only = single_player(Some("com.apple.Music"), PlaybackState::Playing, Some("Song"), None);
        assert_eq!((only.len(), only[0].name.as_str()), (1, "Music"));
        assert!(single_player(None, PlaybackState::Unavailable, None, None).is_empty());
        assert!(single_player(Some(""), PlaybackState::Playing, None, None).is_empty());
    }

    #[test]
    fn player_ids_are_checked_before_use() {
        let _turn = GLOBALS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(valid_player_id("Spotify.exe"));
        assert!(!valid_player_id(""));
        assert!(!valid_player_id("a\nb"));
        assert!(!valid_player_id(&"x".repeat(300)));
        set_preference(Some("Spotify.exe".into()));
        assert_eq!(preference(), Preference::Pinned("Spotify.exe".into()));
        set_preference(Some("bad\nid".into()));
        assert_eq!(preference(), Preference::Auto);
        set_preference(Some("again.exe".into()));
        set_preference(None);
        assert_eq!(preference(), Preference::Auto);
    }
}
