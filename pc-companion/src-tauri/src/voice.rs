//! Turns a spoken sentence from the phone ("open spotify", "volume up", "type hello") into one PC action.
//! Shut down, restart and sign out are left out on purpose: a misheard word must not end the session.

use super::{remote::SystemCommand, MediaCommand};

#[derive(Debug, PartialEq)]
pub(super) enum Intent {
    Media(MediaCommand),
    System(SystemCommand),
    Open(String),
    Type(String),
    Search(String),
    Url(String),
}

pub(super) fn parse(said: &str) -> Option<Intent> {
    let text = said.trim().trim_end_matches(['.', '!', '?']).trim();
    let text = text.strip_prefix("please ").or_else(|| text.strip_prefix("Please ")).unwrap_or(text).trim();
    let lower = text.to_lowercase();
    let fixed = match lower.as_str() {
        "play" | "pause" | "resume" | "play pause" | "stop music" | "play music" | "pause music" => Some(Intent::Media(MediaCommand::PlayPause)),
        "next" | "next song" | "next track" | "skip" | "skip song" => Some(Intent::Media(MediaCommand::NextTrack)),
        "previous" | "previous song" | "previous track" | "last song" => Some(Intent::Media(MediaCommand::PreviousTrack)),
        "volume up" | "louder" | "turn it up" | "increase volume" => Some(Intent::Media(MediaCommand::VolumeUp)),
        "volume down" | "quieter" | "softer" | "turn it down" | "decrease volume" => Some(Intent::Media(MediaCommand::VolumeDown)),
        "mute" | "unmute" | "mute volume" => Some(Intent::Media(MediaCommand::Mute)),
        "lock" | "lock pc" | "lock computer" | "lock the pc" | "lock the computer" | "lock screen" => Some(Intent::System(SystemCommand::Lock)),
        "sleep" | "go to sleep" | "sleep pc" => Some(Intent::System(SystemCommand::Sleep)),
        "screenshot" | "take a screenshot" | "take screenshot" => Some(Intent::System(SystemCommand::Screenshot)),
        "brightness up" | "brighter" | "increase brightness" => Some(Intent::System(SystemCommand::BrightnessUp)),
        "brightness down" | "dimmer" | "decrease brightness" => Some(Intent::System(SystemCommand::BrightnessDown)),
        _ => None,
    };
    if fixed.is_some() {
        return fixed;
    }
    // The rest keeps the words as said (original case) after the verb. Lowercasing keeps ASCII verbs' byte lengths.
    let after = |verbs: &[&str]| {
        verbs.iter().find_map(|verb| {
            (lower.starts_with(verb) && text.is_char_boundary(verb.len()))
                .then(|| text[verb.len()..].trim().to_owned())
                .filter(|rest| !rest.is_empty())
        })
    };
    if let Some(words) = after(&["type ", "write ", "dictate "]) {
        return Some(Intent::Type(words));
    }
    if let Some(query) = after(&["search for ", "search ", "google ", "look up "]) {
        return Some(Intent::Search(query));
    }
    if let Some(name) = after(&["open ", "launch ", "start ", "run "]) {
        let name = name.strip_prefix("the ").unwrap_or(&name).to_owned();
        if name.contains('.') && !name.contains(' ') {
            let url = if name.starts_with("http") { name } else { format!("https://{name}") };
            return Some(Intent::Url(url));
        }
        return Some(Intent::Open(name));
    }
    None
}

/// The installed app whose name best matches what was said: exact, then starts with, then contains.
pub(super) fn best_app<'a>(name: &str, apps: impl Iterator<Item = (&'a str, &'a str)>) -> Option<&'a str> {
    let want = name.to_lowercase();
    let rank = |app: &str| {
        let app = app.to_lowercase();
        if app == want { 0 } else if app.starts_with(&want) { 1 } else if app.contains(&want) { 2 } else { 3 }
    };
    apps.map(|(app, path)| (rank(app), app.len(), path))
        .filter(|(rank, _, _)| *rank < 3)
        .min_by_key(|(rank, len, _)| (*rank, *len))
        .map(|(_, _, path)| path)
}

pub(super) fn search_url(query: &str) -> String {
    let mut encoded = String::new();
    for byte in query.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => encoded.push(byte as char),
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    format!("https://www.google.com/search?q={encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn understands_commands() {
        assert_eq!(parse("Volume up."), Some(Intent::Media(MediaCommand::VolumeUp)));
        assert_eq!(parse("please lock the computer"), Some(Intent::System(SystemCommand::Lock)));
        assert_eq!(parse("Open Spotify"), Some(Intent::Open("Spotify".into())));
        assert_eq!(parse("open youtube.com"), Some(Intent::Url("https://youtube.com".into())));
        assert_eq!(parse("Type Hello World"), Some(Intent::Type("Hello World".into())));
        assert_eq!(parse("search for rust traits"), Some(Intent::Search("rust traits".into())));
        assert_eq!(parse("shut down"), None);
        assert_eq!(parse("open"), None);
    }

    #[test]
    fn picks_the_closest_app() {
        let apps = [("Spotify", "a"), ("Spotify Helper Tool", "b"), ("Visual Studio Code", "c")];
        assert_eq!(best_app("spotify", apps.iter().map(|(n, p)| (*n, *p))), Some("a"));
        assert_eq!(best_app("code", apps.iter().map(|(n, p)| (*n, *p))), Some("c"));
        assert_eq!(best_app("chrome", apps.iter().map(|(n, p)| (*n, *p))), None);
        assert_eq!(search_url("a b&c"), "https://www.google.com/search?q=a+b%26c");
    }
}
