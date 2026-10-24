//! Turns a spoken sentence from the phone ("yo crank it up", "open spotify and play", "close this tab") into PC
//! actions. Filler and slang are dropped first, then the words are matched against phrase lists.
//! Shut down, restart and sign out are left out on purpose: a misheard word must not end the session.

use super::{remote::SystemCommand, MediaCommand};

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Intent {
    Media(MediaCommand),
    System(SystemCommand),
    /// Modifiers first, then one key, in `parse_key` names (`META` alone is the Start key).
    Keys(Vec<String>),
    Volume(u8),
    /// An app, site or deck button by name.
    Open(String),
    Type(String),
    Url(String),
    /// Words that matched nothing; the caller still tries them as a deck button or app name.
    Unknown(String),
}

const PREFIX_FILLER: &[&str] = &[
    "hey ", "hi ", "yo ", "ok ", "okay ", "so ", "um ", "uh ", "uhh ", "umm ", "please ", "pls ", "plz ", "kindly ",
    "can you ", "could you ", "would you ", "will you ", "can u ", "could u ", "would u ", "i want to ", "i wanna ",
    "i want you to ", "i need you to ", "i need to ", "i need ", "i want ", "lemme ", "let me ", "go ahead and ", "just ",
    "quickly ", "quick ", "now ", "open dock ", "dock ", "computer ", "bro ", "dude ", "man ", "mate ", "fam ",
    "alright ", "right ", "and ", "then ", "also ", "nah ", "naw ", "nope ", "ugh ", "aight ", "oi ", "try to ", "help me ", "do me a favor and ",
];
const SUFFIX_FILLER: &[&str] = &[
    " please", " pls", " plz", " for me", " right now", " now", " real quick", " quickly", " asap", " bro", " dude",
    " man", " mate", " fam", " thanks", " thank you", " thx", " ty", " already", " again", " on the pc",
    " on my pc", " on the computer", " on my computer", " for a sec", " a bit", " a little",
];

fn table(text: &str) -> Option<Intent> {
    use MediaCommand::*;
    use SystemCommand::*;
    let keys = |k: &[&str]| Some(Intent::Keys(k.iter().map(|key| (*key).to_owned()).collect()));
    let media = |m| Some(Intent::Media(m));
    let system = |s| Some(Intent::System(s));
    match text {
        "play" | "pause" | "resume" | "unpause" | "stop" | "hold on" | "hold up" | "wait" | "freeze" | "continue"
        | "keep playing" | "play pause" | "toggle play" | "start playing" | "stop playing" | "pause music" | "play music"
        | "hit play" | "hit pause" | "press play" | "press pause" | "stop music" | "start music" | "music"
        | "play something" | "put on music" | "put some music on" | "play some music" | "pause that" | "stop that" => media(PlayPause),
        "next" | "skip" | "next song" | "next track" | "next one" | "next video" | "skip song" | "skip track"
        | "skip this" | "skip that" | "play next" | "nah next" | "nope next" | "change song" | "change the song"
        | "another song" | "different song" | "something else" | "skip it" | "next please" | "i hate this song"
        | "not this song" | "nah" | "nope" => media(NextTrack),
        "previous" | "prev" | "go back a song" | "last song" | "previous song" | "previous track" | "back one"
        | "play previous" | "the one before" | "song before" | "go back one" | "back a song" | "last track"
        | "previous one" | "play that again" | "play the last song" => media(PreviousTrack),
        "louder" | "volume up" | "turn up" | "turn it up" | "crank" | "crank up" | "crank it" | "crank it up"
        | "pump it up" | "pump up the volume" | "raise volume" | "raise the volume" | "increase volume"
        | "increase the volume" | "more volume" | "up the volume" | "bump up" | "bump it up" | "boost volume"
        | "i cant hear" | "cant hear" | "i cant hear it" | "turn up the volume" | "turn the volume up" | "sound up"
        | "make it louder" | "up" | "vol up" | "turn that up" => media(VolumeUp),
        "quieter" | "softer" | "volume down" | "turn down" | "turn it down" | "lower volume" | "lower the volume"
        | "lower it" | "decrease volume" | "decrease the volume" | "less volume" | "too loud" | "its too loud"
        | "tone it down" | "bring it down" | "reduce volume" | "reduce the volume" | "turn down the volume"
        | "turn the volume down" | "sound down" | "make it quieter" | "vol down" | "down" | "turn that down" => media(VolumeDown),
        "mute" | "unmute" | "silence" | "shut up" | "shush" | "shh" | "shhh" | "quiet" | "be quiet" | "kill the sound"
        | "kill sound" | "no sound" | "sound off" | "sound on" | "mute sound" | "mute volume" | "mute audio"
        | "unmute sound" | "silent" | "go silent" => media(Mute),
        "lock" | "lock pc" | "lock computer" | "lock the pc" | "lock the computer" | "lock screen" | "lock the screen"
        | "lock my pc" | "lock my computer" | "lock up" | "lock it" | "lock it up" | "im leaving" | "brb" => system(Lock),
        "sleep" | "go to sleep" | "sleep mode" | "sleep pc" | "nap" | "take a nap" | "goodnight" | "good night"
        | "put pc to sleep" | "put the pc to sleep" | "put it to sleep" | "night night" | "gn" => system(Sleep),
        "screenshot" | "take a screenshot" | "take screenshot" | "screen shot" | "capture screen" | "capture the screen"
        | "screen grab" | "grab the screen" | "snap the screen" | "ss" | "screencap" | "screen capture"
        | "take a pic of the screen" | "print screen" => system(Screenshot),
        "brighter" | "brightness up" | "too dark" | "its too dark" | "more brightness" | "increase brightness"
        | "raise brightness" | "turn up brightness" | "turn up the brightness" | "brighten" | "brighten up" => system(BrightnessUp),
        "dimmer" | "brightness down" | "too bright" | "its too bright" | "dim" | "dim the screen" | "dim it"
        | "lower brightness" | "decrease brightness" | "less brightness" | "turn down brightness"
        | "turn down the brightness" => system(BrightnessDown),
        "close" | "close it" | "close this" | "close that" | "close window" | "close the window" | "close this window"
        | "close app" | "close the app" | "close this app" | "kill it" | "kill this" | "kill this app" | "quit"
        | "quit this" | "exit" | "exit this" | "get rid of this" | "get rid of it" | "alt f4" | "bye" => keys(&["ALT", "F4"]),
        "close tab" | "close the tab" | "close this tab" | "kill the tab" | "kill this tab" => keys(&["CTRL", "W"]),
        "new tab" | "open a new tab" | "open new tab" | "open tab" | "another tab" => keys(&["CTRL", "T"]),
        "reopen tab" | "reopen the tab" | "reopen closed tab" | "bring back the tab" | "undo close tab"
        | "restore tab" => keys(&["CTRL", "SHIFT", "T"]),
        "next tab" | "switch tab" | "other tab" => keys(&["CTRL", "TAB"]),
        "previous tab" | "last tab" | "tab back" => keys(&["CTRL", "SHIFT", "TAB"]),
        "new window" | "open a new window" | "open new window" => keys(&["CTRL", "N"]),
        "incognito" | "private window" | "incognito window" | "open incognito" | "go incognito" => keys(&["CTRL", "SHIFT", "N"]),
        "minimize" | "minimise" | "minimize this" | "minimize it" | "minimize window" | "minimize the window"
        | "hide this" | "hide it" | "hide window" | "hide the window" | "shrink it" => keys(&["META", "DOWN"]),
        "maximize" | "maximise" | "maximize this" | "maximize it" | "maximize window" | "make it bigger"
        | "make it big" | "bigger" | "expand" | "expand it" => keys(&["META", "UP"]),
        "full screen" | "fullscreen" | "go full screen" | "go fullscreen" | "exit full screen" | "exit fullscreen" => keys(&["F11"]),
        "show desktop" | "desktop" | "go to desktop" | "go to the desktop" | "hide everything" | "minimize all"
        | "minimize everything" | "clear the screen" | "clear screen" | "home screen" | "panic" => keys(&["META", "D"]),
        "switch window" | "switch windows" | "switch app" | "switch apps" | "next window" | "alt tab" | "change window"
        | "other window" | "other app" | "go back to the other window" | "swap" | "swap windows" => keys(&["ALT", "TAB"]),
        "task view" | "show all windows" | "all windows" | "show windows" => keys(&["META", "TAB"]),
        "copy" | "copy this" | "copy that" | "copy it" | "ctrl c" => keys(&["CTRL", "C"]),
        "paste" | "paste it" | "paste that" | "paste this" | "ctrl v" => keys(&["CTRL", "V"]),
        "cut" | "cut this" | "cut it" | "cut that" | "ctrl x" => keys(&["CTRL", "X"]),
        "undo" | "undo that" | "undo it" | "go back a step" | "oops" | "my bad" | "ctrl z" => keys(&["CTRL", "Z"]),
        "redo" | "redo that" | "redo it" | "ctrl y" => keys(&["CTRL", "Y"]),
        "select all" | "select everything" | "highlight all" | "ctrl a" => keys(&["CTRL", "A"]),
        "save" | "save it" | "save this" | "save that" | "save the file" | "ctrl s" => keys(&["CTRL", "S"]),
        "save as" => keys(&["CTRL", "SHIFT", "S"]),
        "print" | "print this" | "print it" => keys(&["CTRL", "P"]),
        "find" | "find on page" | "search page" | "search this page" | "find in page" | "ctrl f" => keys(&["CTRL", "F"]),
        "refresh" | "reload" | "refresh page" | "refresh the page" | "reload page" | "reload the page" | "refresh it" => keys(&["F5"]),
        "go back" | "back" | "go back a page" | "previous page" | "back a page" => keys(&["ALT", "LEFT"]),
        "go forward" | "forward" | "next page" | "forward a page" => keys(&["ALT", "RIGHT"]),
        "scroll down" | "page down" | "scroll" | "move down" | "keep scrolling" => keys(&["PAGE_DOWN"]),
        "scroll up" | "page up" | "move up" => keys(&["PAGE_UP"]),
        "scroll to top" | "go to top" | "top" | "go to the top" | "scroll to the top" => keys(&["HOME"]),
        "scroll to bottom" | "go to bottom" | "bottom" | "go to the bottom" | "scroll to the bottom" => keys(&["END"]),
        "enter" | "press enter" | "hit enter" | "submit" | "send" | "send it" | "confirm" | "ok" | "okay" | "yes" | "go" => keys(&["ENTER"]),
        "escape" | "esc" | "cancel" | "press escape" | "hit escape" | "get out" | "back out" => keys(&["ESCAPE"]),
        "space" | "spacebar" | "press space" | "hit space" => keys(&["SPACE"]),
        "backspace" | "delete that" | "erase" | "rub that out" => keys(&["BACKSPACE"]),
        "delete" | "press delete" | "delete it" | "delete this" | "remove it" | "trash it" => keys(&["DELETE"]),
        "tab" | "press tab" | "hit tab" => keys(&["TAB"]),
        "start menu" | "start" | "windows key" | "open start" | "open start menu" | "press windows" => keys(&["META"]),
        "settings" | "open settings" | "windows settings" | "pc settings" | "open windows settings" => keys(&["META", "I"]),
        "file explorer" | "files" | "explorer" | "my files" | "open file explorer" | "open files" | "open explorer"
        | "open my files" | "this pc" | "my computer" | "open this pc" | "folders" => keys(&["META", "E"]),
        "task manager" | "open task manager" | "whats using my cpu" | "whats slowing my pc" => keys(&["CTRL", "SHIFT", "ESCAPE"]),
        "run dialog" | "open run" | "run box" => keys(&["META", "R"]),
        "snip" | "snipping tool" | "snip the screen" | "clip the screen" | "screen snip" | "snip it" => keys(&["META", "SHIFT", "S"]),
        "notifications" | "show notifications" | "notification center" | "open notifications" => keys(&["META", "N"]),
        "quick settings" | "action center" | "open quick settings" => keys(&["META", "A"]),
        "windows search" | "search windows" | "search the pc" | "search my pc" => keys(&["META", "S"]),
        "clipboard" | "clipboard history" | "show clipboard" | "open clipboard" => keys(&["META", "V"]),
        "max volume" | "volume max" | "full volume" | "max it out" | "max it" | "full blast" | "blast it" => Some(Intent::Volume(100)),
        "half volume" | "volume half" | "half" => Some(Intent::Volume(50)),
        "volume zero" | "zero volume" | "volume off" | "no volume" => Some(Intent::Volume(0)),
        _ => None,
    }
}

const SITES: &[(&str, &str)] = &[
    ("youtube", "https://www.youtube.com"), ("yt", "https://www.youtube.com"), ("gmail", "https://mail.google.com"),
    ("mail", "https://mail.google.com"), ("email", "https://mail.google.com"), ("google", "https://www.google.com"),
    ("netflix", "https://www.netflix.com"), ("reddit", "https://www.reddit.com"), ("twitter", "https://x.com"),
    ("x", "https://x.com"), ("instagram", "https://www.instagram.com"), ("insta", "https://www.instagram.com"),
    ("ig", "https://www.instagram.com"), ("facebook", "https://www.facebook.com"), ("fb", "https://www.facebook.com"),
    ("github", "https://github.com"), ("chatgpt", "https://chatgpt.com"), ("gpt", "https://chatgpt.com"),
    ("claude", "https://claude.ai"), ("whatsapp", "https://web.whatsapp.com"), ("amazon", "https://www.amazon.com"),
    ("maps", "https://maps.google.com"), ("google maps", "https://maps.google.com"), ("drive", "https://drive.google.com"),
    ("google drive", "https://drive.google.com"), ("docs", "https://docs.google.com"), ("google docs", "https://docs.google.com"),
    ("sheets", "https://sheets.google.com"), ("outlook", "https://outlook.live.com"), ("linkedin", "https://www.linkedin.com"),
    ("twitch", "https://www.twitch.tv"), ("prime video", "https://www.primevideo.com"), ("prime", "https://www.primevideo.com"),
    ("hotstar", "https://www.hotstar.com"), ("disney plus", "https://www.disneyplus.com"), ("translate", "https://translate.google.com"),
    ("google translate", "https://translate.google.com"), ("calendar", "https://calendar.google.com"), ("news", "https://news.google.com"),
    ("weather", "https://www.google.com/search?q=weather"), ("wikipedia", "https://www.wikipedia.org"), ("wiki", "https://www.wikipedia.org"),
    ("pinterest", "https://www.pinterest.com"), ("tiktok", "https://www.tiktok.com"), ("spotify web", "https://open.spotify.com"),
    ("stack overflow", "https://stackoverflow.com"), ("stackoverflow", "https://stackoverflow.com"),
];

/// Short or spoken names for apps, matched against installed app names.
const APP_ALIASES: &[(&str, &str)] = &[
    ("calc", "calculator"), ("vs code", "visual studio code"), ("vscode", "visual studio code"), ("code", "visual studio code"),
    ("chrome", "google chrome"), ("edge", "microsoft edge"), ("browser", "microsoft edge"), ("internet", "microsoft edge"),
    ("word", "word"), ("ms word", "word"), ("powerpoint", "powerpoint"), ("ppt", "powerpoint"), ("excel", "excel"),
    ("cmd", "command prompt"), ("command line", "command prompt"), ("terminal", "terminal"), ("powershell", "windows powershell"),
    ("notepad", "notepad"), ("paint", "paint"), ("camera", "camera"), ("photos", "photos"), ("pictures", "photos"),
    ("store", "microsoft store"), ("app store", "microsoft store"), ("teams", "microsoft teams"), ("steam", "steam"),
    ("vlc", "vlc media player"), ("obs", "obs studio"), ("clock", "clock"), ("alarm", "clock"), ("timer", "clock"),
];

/// "VolumeUp" or "PAGE_DOWN" as people say it: "Volume up", "Page down"; "META" is the Windows key.
pub(super) fn spoken_name(code: &str) -> String {
    match code {
        "META" => return "Windows".into(),
        "CTRL" => return "Ctrl".into(),
        "PlayPause" => return "Play/pause".into(),
        _ => {}
    }
    let mut words = String::new();
    for (index, c) in code.replace('_', " ").chars().enumerate() {
        if index > 0 && c.is_uppercase() && !words.ends_with(' ') && code.chars().any(char::is_lowercase) {
            words.push(' ');
        }
        words.push(c);
    }
    let lower = words.to_lowercase();
    let mut chars = lower.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

pub(super) fn site(name: &str) -> Option<&'static str> {
    SITES.iter().find(|(site, _)| *site == name).map(|(_, url)| *url)
}

pub(super) fn app_alias(name: &str) -> &str {
    APP_ALIASES.iter().find(|(alias, _)| *alias == name).map_or(name, |(_, app)| app)
}

fn normalize(said: &str) -> String {
    let lower = said.to_lowercase().replace(" dot com", ".com").replace(" dot org", ".org").replace(" dot net", ".net").replace(" dot ", ".");
    let cleaned: String = lower
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '%' || c == '/' || c == ':' { c } else if c == '\'' || c == '’' { '\0' } else { ' ' })
        .filter(|c| *c != '\0')
        .collect();
    let mut text = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    text = text.trim_matches('.').to_owned();
    strip_filler(&text)
}

fn strip_filler(text: &str) -> String {
    let mut text = format!("{text} ");
    loop {
        let before = text.len();
        for filler in PREFIX_FILLER {
            if text.len() > filler.len() {
                if let Some(rest) = text.strip_prefix(filler) {
                    text = rest.to_owned();
                }
            }
        }
        let mut trimmed = format!(" {}", text.trim_end());
        for filler in SUFFIX_FILLER {
            if trimmed.len() > filler.len() + 1 {
                if let Some(rest) = trimmed.strip_suffix(filler) {
                    trimmed = rest.to_owned();
                }
            }
        }
        text = format!("{} ", trimmed.trim_start());
        if text.len() == before {
            return text.trim().to_owned();
        }
    }
}

fn number(word: &str) -> Option<u32> {
    if let Ok(value) = word.trim_end_matches('%').parse::<u32>() {
        return Some(value);
    }
    const WORDS: &[&str] = &["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
    if let Some(index) = WORDS.iter().position(|w| *w == word) {
        return Some(index as u32);
    }
    match word {
        "once" | "a" | "an" => Some(1),
        "twice" | "couple" => Some(2),
        "thrice" | "few" => Some(3),
        "thirty" => Some(30), "forty" => Some(40), "fifty" => Some(50), "sixty" => Some(60), "seventy" => Some(70),
        "eighty" => Some(80), "ninety" => Some(90), "hundred" => Some(100),
        _ => None,
    }
}

/// "volume up 3 times", "skip two songs", "turn it up a lot": the phrase without the count, and the count.
fn split_count(text: &str) -> (String, u32) {
    for (tail, count) in [(" a lot", 5), (" lots", 5), (" way up", 5), (" way down", 5), (" a bunch", 5), (" more", 2), (" a couple times", 2), (" a few times", 3)] {
        if let Some(rest) = text.strip_suffix(tail) {
            return (rest.to_owned(), count);
        }
    }
    let words: Vec<&str> = text.split(' ').collect();
    let mut end = words.len();
    while end > 0 && matches!(words[end - 1], "times" | "time" | "x" | "songs" | "song" | "tracks" | "track" | "steps" | "notches" | "clicks" | "more") {
        end -= 1;
    }
    if end >= 2 {
        let (before, by) = if end >= 3 && words[end - 2] == "by" { (end - 2, true) } else { (end - 1, false) };
        if let Some(count) = number(words[end - 1]) {
            let _ = by;
            return (words[..before].join(" "), count.clamp(1, 20));
        }
    }
    (text.to_owned(), 1)
}

fn volume_level(text: &str) -> Option<u8> {
    if !(text.contains("volume") || text.contains("sound") || text.contains("vol ")) {
        return None;
    }
    let words: Vec<&str> = text.split(' ').collect();
    let level = words.iter().enumerate().find_map(|(index, word)| {
        let value = number(word)?;
        // "volume 40", "volume to forty", "set the volume at 40 percent"; "volume up 3" is a step count instead.
        let after_to = index > 0 && matches!(words[index - 1], "to" | "at" | "volume");
        let percent = word.ends_with('%') || words.get(index + 1).is_some_and(|next| *next == "percent");
        let tens = words.get(index + 1).and_then(|next| number(next)).filter(|n| value >= 20 && *n < 10).unwrap_or(0);
        (after_to || percent).then_some(value + tens)
    })?;
    Some(level.min(100) as u8)
}

fn after<'a>(text: &'a str, verbs: &[&str]) -> Option<&'a str> {
    verbs.iter().find_map(|verb| text.strip_prefix(verb).map(str::trim).filter(|rest| !rest.is_empty()))
}

fn query_url(base: &str, query: &str) -> String {
    let mut encoded = String::new();
    for byte in query.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => encoded.push(byte as char),
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    format!("{base}{encoded}")
}

pub(super) fn search_url(query: &str) -> String {
    query_url("https://www.google.com/search?q=", query)
}

fn youtube_url(query: &str) -> String {
    query_url("https://www.youtube.com/results?search_query=", query)
}

/// "press ctrl shift t", "hit alt f4", "windows d".
fn key_combo(text: &str) -> Option<Intent> {
    let rest = after(text, &["press ", "hit ", "push ", "tap ", "do "]).unwrap_or(text);
    let mut keys = Vec::new();
    for word in rest.split([' ', '+']).filter(|w| !w.is_empty() && *w != "plus" && *w != "and" && *w != "the" && *w != "key") {
        let key = match word {
            "ctrl" | "control" | "ctl" => "CTRL".to_owned(),
            "alt" | "option" => "ALT".to_owned(),
            "shift" => "SHIFT".to_owned(),
            "win" | "windows" | "super" | "meta" | "start" | "cmd" | "command" => "META".to_owned(),
            "enter" | "return" => "ENTER".to_owned(),
            "escape" | "esc" => "ESCAPE".to_owned(),
            "tab" => "TAB".to_owned(),
            "space" | "spacebar" => "SPACE".to_owned(),
            "backspace" => "BACKSPACE".to_owned(),
            "delete" | "del" => "DELETE".to_owned(),
            "home" => "HOME".to_owned(),
            "end" => "END".to_owned(),
            "up" => "UP".to_owned(), "down" => "DOWN".to_owned(), "left" => "LEFT".to_owned(), "right" => "RIGHT".to_owned(),
            f if f.len() <= 3 && f.starts_with('f') && f[1..].parse::<u8>().is_ok_and(|n| (1..=12).contains(&n)) => f.to_uppercase(),
            c if c.len() == 1 && c.as_bytes()[0].is_ascii_alphanumeric() => c.to_uppercase(),
            _ => return None,
        };
        keys.push(key);
    }
    let modifiers = ["CTRL", "ALT", "SHIFT", "META"];
    let count = keys.len();
    let shape_ok = count >= 2 && count <= 5 && keys[..count - 1].iter().all(|k| modifiers.contains(&k.as_str()));
    let single_ok = count == 1 && rest.len() < text.len();
    (shape_ok || single_ok).then_some(Intent::Keys(keys))
}

fn parse_one(text: &str, original: &str) -> Option<Intent> {
    if text.is_empty() {
        return None;
    }
    if let Some(intent) = table(text) {
        return Some(intent);
    }
    // "pause the video", "skip this song", "mute the pc": drop the object and look again.
    for object in [" the music", " the song", " this song", " that song", " the video", " this video", " the track", " music",
        " the audio", " audio", " the sound", " sound", " the pc", " the computer", " my pc", " it", " this", " that", " the volume", " volume"] {
        if let Some(rest) = text.strip_suffix(object) {
            if let Some(intent) = table(rest) {
                return Some(intent);
            }
        }
    }
    if let Some(level) = volume_level(text) {
        return Some(Intent::Volume(level));
    }
    // Typed text keeps the words as said, with their case, from the original sentence.
    for verb in ["type out ", "type in ", "type ", "write down ", "write out ", "write ", "dictate ", "enter text ", "input ", "put in "] {
        if let Some(words) = text.strip_prefix(verb).filter(|rest| !rest.is_empty()) {
            let lower = original.to_lowercase();
            let kept = lower
                .find(verb.trim_end())
                .map(|at| at + verb.trim_end().len())
                .filter(|at| original.is_char_boundary(*at) && lower.len() == original.len())
                .map(|at| original[at..].trim().trim_end_matches(['.', '!', '?']).to_owned())
                .filter(|kept| !kept.is_empty())
                .unwrap_or_else(|| words.to_owned());
            return Some(Intent::Type(kept));
        }
    }
    for (verbs, site) in [(&["search youtube for ", "youtube search ", "search on youtube for ", "youtube "][..], "youtube"), (&["search spotify for ", "spotify search "][..], "spotify")] {
        if let Some(query) = after(text, verbs) {
            return Some(Intent::Url(if site == "youtube" { youtube_url(query) } else { query_url("https://open.spotify.com/search/", query) }));
        }
    }
    if let Some(query) = after(text, &["play ", "put on ", "throw on ", "blast ", "queue up ", "queue ", "listen to ", "watch "]) {
        if let Some(song) = query.strip_suffix(" on spotify") {
            return Some(Intent::Url(query_url("https://open.spotify.com/search/", song)));
        }
        let song = query.strip_suffix(" on youtube").or_else(|| query.strip_suffix(" on yt")).unwrap_or(query);
        return Some(Intent::Url(youtube_url(song)));
    }
    if let Some(query) = after(text, &["search for ", "search up ", "search ", "google ", "look up ", "lookup ", "find me ", "find out ",
        "bing ", "look for ", "find "]) {
        if let Some(on_youtube) = query.strip_suffix(" on youtube").or_else(|| query.strip_suffix(" on yt")) {
            return Some(Intent::Url(youtube_url(on_youtube)));
        }
        let query = query.strip_suffix(" on google").unwrap_or(query);
        return Some(Intent::Url(search_url(query)));
    }
    if ["what ", "whats ", "who ", "whos ", "how ", "hows ", "where ", "wheres ", "when ", "why ", "which ", "is ", "are ", "define ",
        "meaning of ", "weather ", "news ", "translate "].iter().any(|start| text.starts_with(start)) {
        return Some(Intent::Url(search_url(text)));
    }
    if let Some(name) = after(text, &["open up ", "open ", "launch ", "start up ", "start ", "run ", "fire up ", "boot up ", "pull up ",
        "bring up ", "load up ", "load ", "get me ", "show me ", "gimme ", "give me ", "go to ", "take me to ", "visit ",
        "switch to ", "jump to ", "head to ", "navigate to ", "hop on ", "get on "]) {
        let name = name.strip_prefix("the ").or_else(|| name.strip_prefix("my ")).unwrap_or(name);
        let name = name.strip_suffix(" app").or_else(|| name.strip_suffix(" website")).or_else(|| name.strip_suffix(" site")).unwrap_or(name);
        if let Some(intent) = table(&format!("open {name}")).or_else(|| table(name).filter(|i| matches!(i, Intent::Keys(_)))) {
            return Some(intent);
        }
        if name.contains('.') && !name.contains(' ') {
            return Some(Intent::Url(if name.starts_with("http") { name.to_owned() } else { format!("https://{name}") }));
        }
        return Some(Intent::Open(name.to_owned()));
    }
    if let Some(intent) = key_combo(text) {
        return Some(intent);
    }
    None
}

/// What the sentence asks for, in order. Empty when nothing in it made sense.
pub(super) fn parse(said: &str) -> Vec<Intent> {
    let text = normalize(said);
    if text.is_empty() {
        return Vec::new();
    }
    let (phrase, count) = split_count(&text);
    let repeatable = |intent: &Intent| matches!(intent, Intent::Media(_) | Intent::Keys(_) | Intent::System(SystemCommand::BrightnessUp | SystemCommand::BrightnessDown));
    if count > 1 {
        if let Some(intent) = parse_one(&phrase, said).filter(repeatable) {
            return vec![intent; count as usize];
        }
    }
    let whole = parse_one(&text, said);
    // Typing and searching take the rest of the sentence, "and" included.
    if matches!(whole, Some(Intent::Type(_)) | Some(Intent::Url(_))) {
        return whole.into_iter().collect();
    }
    // "open spotify and play", "copy that then switch window and paste".
    let mut parts = vec![text.clone()];
    for joiner in [" and then ", " then ", " and also ", " after that ", " and "] {
        parts = parts.iter().flat_map(|part| part.split(joiner).map(str::to_owned).collect::<Vec<_>>()).collect();
    }
    if parts.len() > 1 && parts.len() <= 5 {
        let each: Vec<Option<Intent>> = parts.iter().map(|part| parse_one(&strip_filler(part), part)).collect();
        if each.iter().all(|intent| intent.as_ref().is_some_and(|i| !matches!(i, Intent::Unknown(_)))) {
            return each.into_iter().flatten().collect();
        }
    }
    vec![whole.unwrap_or(Intent::Unknown(text))]
}

/// The name that best matches what was said: exact, then starts with, then a whole word, then contains. With
/// `loose` ("open …" was said), last a name that sounds alike once the spaces are gone: recognizers split a name
/// they don't know into words ("spot if i", "spot this fy" for Spotify), more so with an accent.
pub(super) fn best_match<'a>(name: &str, candidates: impl Iterator<Item = (&'a str, &'a str)>, loose: bool) -> Option<&'a str> {
    let want = name.to_lowercase();
    let squash = |text: &str| sound(&text.chars().filter(|c| c.is_alphanumeric()).collect::<String>());
    let want_sound = squash(&want);
    let rank = |candidate: &str| {
        let candidate = candidate.to_lowercase();
        if candidate == want {
            Some(0)
        } else if candidate.starts_with(&format!("{want} ")) || candidate.starts_with(&want) {
            Some(1)
        } else if candidate.split(|c: char| !c.is_alphanumeric()).any(|word| word == want) {
            Some(2)
        } else if loose && want.len() >= 3 && candidate.contains(&want) {
            Some(3)
        } else if loose && want_sound.len() >= 4 {
            // The whole name or its first word: at most a third of its letters off, or all of them, in order, among
            // a few extra ones ("spotthisfy").
            let first = candidate.split_whitespace().next().unwrap_or_default();
            let within = |target: &str| {
                let mut heard = want_sound.chars();
                target.chars().all(|letter| heard.any(|c| c == letter)) && want_sound.len() * 2 <= target.len() * 3
            };
            [squash(&candidate), squash(first)]
                .iter()
                .filter(|target| target.len() >= 4)
                .map(|target| (edit_distance(&want_sound, target), target))
                .filter(|(distance, target)| distance * 3 <= target.len() || within(target))
                .map(|(distance, _)| 10 + distance)
                .min()
        } else {
            None
        }
    };
    candidates
        .filter_map(|(candidate, id)| rank(candidate).map(|rank| (rank, candidate.len(), id)))
        .min_by_key(|(rank, len, _)| (*rank, *len))
        .map(|(_, _, id)| id)
}

// The wake phrase ("hey dock") for hands-free listening on the PC: the same rules as the phone's
// phone-app/src/wake-phrase.ts, so both hear it alike.
const GREETINGS: [&str; 9] = ["hey", "hi", "hay", "a", "ok", "okay", "hello", "yo", "he"];

fn wake_words(text: &str) -> Vec<String> {
    let plain: String = text.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    plain.split_whitespace().map(str::to_owned).collect()
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for j in 1..=b.len() {
            let kept = row[j];
            row[j] = (row[j] + 1).min(row[j - 1] + 1).min(previous + usize::from(ca != b[j - 1]));
            previous = kept;
        }
    }
    row[b.len()]
}

// Recognizers spell a short word the way it sounded: "dock" comes back as doc, docks, dog or duck.
fn sound(word: &str) -> String {
    let mut sound = word.replace("ck", "k").replace('c', "k");
    if sound.ends_with('g') {
        sound.pop();
        sound.push('k');
    }
    let mut sound = sound.replace("ph", "f");
    if sound.chars().count() > 1 && sound.ends_with('s') {
        sound.pop();
    }
    sound
}

fn same_word(heard: &str, wanted: &str) -> bool {
    heard == wanted
        || (GREETINGS.contains(&heard) && GREETINGS.contains(&wanted))
        || (wanted.chars().count() >= 3 && edit_distance(&sound(heard), &sound(wanted)) <= 1)
}

/// The words after the wake phrase ("" when it was said alone), or None when the phrase is not in `text`.
pub(super) fn after_wake_phrase(text: &str, phrase: &str) -> Option<String> {
    let heard = wake_words(text);
    let wanted = wake_words(phrase);
    if wanted.is_empty() {
        return None;
    }
    for start in 0..(heard.len() + 1).saturating_sub(wanted.len()) {
        if wanted.iter().enumerate().all(|(index, word)| same_word(&heard[start + index], word)) {
            return Some(heard[start + wanted.len()..].join(" "));
        }
    }
    // The greeting can be lost before the recognizer starts hearing: "dock, lights on" counts too.
    let core: Vec<&String> = wanted.iter().filter(|word| !GREETINGS.contains(&word.as_str())).collect();
    if !core.is_empty() && core.len() < wanted.len() && core.len() <= heard.len() && core.iter().enumerate().all(|(index, word)| same_word(&heard[index], word)) {
        return Some(heard[core.len()..].join(" "));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use Intent::*;

    fn keys(k: &[&str]) -> Intent {
        Keys(k.iter().map(|key| (*key).to_owned()).collect())
    }

    #[test]
    fn understands_slang_and_filler() {
        assert_eq!(parse("Volume up."), vec![Media(MediaCommand::VolumeUp)]);
        assert_eq!(parse("yo crank it up bro"), vec![Media(MediaCommand::VolumeUp)]);
        assert_eq!(parse("Can you please pause the video?"), vec![Media(MediaCommand::PlayPause)]);
        assert_eq!(parse("nah skip this song"), vec![Media(MediaCommand::NextTrack)]);
        assert_eq!(parse("it's too loud"), vec![Media(MediaCommand::VolumeDown)]);
        assert_eq!(parse("shut up"), vec![Media(MediaCommand::Mute)]);
        assert_eq!(parse("please lock the computer"), vec![System(SystemCommand::Lock)]);
        assert_eq!(parse("kill this tab"), vec![keys(&["CTRL", "W"])]);
        assert_eq!(parse("get rid of this"), vec![keys(&["ALT", "F4"])]);
        assert_eq!(parse("shut down"), vec![Unknown("shut down".into())]);
    }

    #[test]
    fn counts_levels_and_chains() {
        assert_eq!(parse("volume up 3 times"), vec![Media(MediaCommand::VolumeUp); 3]);
        assert_eq!(parse("skip two songs"), vec![Media(MediaCommand::NextTrack); 2]);
        assert_eq!(parse("set the volume to forty"), vec![Volume(40)]);
        assert_eq!(parse("volume 35 percent"), vec![Volume(35)]);
        assert_eq!(parse("volume to sixty five"), vec![Volume(65)]);
        assert_eq!(parse("max it out"), vec![Volume(100)]);
        assert_eq!(parse("open spotify and play"), vec![Open("spotify".into()), Media(MediaCommand::PlayPause)]);
        assert_eq!(parse("copy that then switch window and paste"), vec![keys(&["CTRL", "C"]), keys(&["ALT", "TAB"]), keys(&["CTRL", "V"])]);
        assert_eq!(parse("open tom and jerry"), vec![Open("tom and jerry".into())]);
    }

    #[test]
    fn opens_types_and_searches() {
        assert_eq!(parse("Fire up the Spotify app"), vec![Open("spotify".into())]);
        assert_eq!(parse("open youtube dot com"), vec![Url("https://youtube.com".into())]);
        assert_eq!(parse("open file explorer"), vec![keys(&["META", "E"])]);
        assert_eq!(parse("Type Hello World and stuff"), vec![Type("Hello World and stuff".into())]);
        assert_eq!(parse("search for rust traits"), vec![Url("https://www.google.com/search?q=rust+traits".into())]);
        assert_eq!(parse("what's the weather"), vec![Url("https://www.google.com/search?q=whats+the+weather".into())]);
        assert_eq!(parse("play lofi beats"), vec![Url("https://www.youtube.com/results?search_query=lofi+beats".into())]);
        assert_eq!(parse("press ctrl shift t"), vec![keys(&["CTRL", "SHIFT", "T"])]);
        assert_eq!(parse("hit f5"), vec![keys(&["F5"])]);
        assert_eq!(parse("spotify"), vec![Unknown("spotify".into())]);
        assert_eq!(search_url("a b&c"), "https://www.google.com/search?q=a+b%26c");
        assert_eq!(spoken_name("VolumeUp"), "Volume up");
        assert_eq!(spoken_name("PAGE_DOWN"), "Page down");
        assert_eq!(spoken_name("F5"), "F5");
        assert_eq!(spoken_name("META"), "Windows");
    }

    #[test]
    fn picks_the_closest_name() {
        let apps = [("Spotify", "a"), ("Spotify Helper Tool", "b"), ("Visual Studio Code", "c"), ("WordPad", "d"), ("Word", "e")];
        let list = || apps.iter().map(|(n, p)| (*n, *p));
        assert_eq!(best_match("spotify", list(), true), Some("a"));
        assert_eq!(best_match(app_alias("vs code"), list(), true), Some("c"));
        assert_eq!(best_match("word", list(), true), Some("e"));
        assert_eq!(best_match("chrome", list(), true), None);
        assert_eq!(best_match("tify", list(), false), None);
        // Names split into sound-alike words.
        assert_eq!(best_match("spot if i", list(), true), Some("a"));
        assert_eq!(best_match("spot this fy", list(), true), Some("a"));
        assert_eq!(best_match("word pad", list(), true), Some("d"));
        assert_eq!(best_match("spot if i", list(), false), None);
        assert_eq!(best_match("notepad", list(), true), None);
    }

    #[test]
    fn hears_the_wake_phrase() {
        let after = |text| after_wake_phrase(text, "hey dock");
        assert_eq!(after("hey dock open spotify").as_deref(), Some("open spotify"));
        assert_eq!(after("Hey, Dock.").as_deref(), Some(""));
        assert_eq!(after("hi doc volume up").as_deref(), Some("volume up"));
        assert_eq!(after("a duck next track").as_deref(), Some("next track"));
        assert_eq!(after("okay docks lock pc").as_deref(), Some("lock pc"));
        assert_eq!(after("dock open chrome").as_deref(), Some("open chrome"));
        assert_eq!(after("the dog is barking"), None);
        assert_eq!(after("open spotify"), None);
        assert_eq!(after("hey there"), None);
        assert_eq!(after("hey"), None);
    }
}
