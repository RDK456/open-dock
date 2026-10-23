//! Pairs an Android phone over USB with no QR code. A phone that USB debugging already trusts can be handed the
//! pairing key over the cable: Open Dock opens its `opendock://pair` link on the phone through adb.
//!
//! The phone gets three tries per plug-in (a new cable, or Retry, starts three more). Once it has connected, it is
//! not pushed again, so closing the app on the phone does not bring it back.

use std::path::Path;
use std::time::{Duration, Instant};

use super::adb;

/// The phone app's Android package, so the link opens Open Dock and nothing else.
pub const PACKAGE: &str = "app.opendock.phone";
pub const MAX_TRIES: u8 = 3;
/// After a phone shows up, how long an already-running app has to connect by itself.
const GRACE: Duration = Duration::from_secs(3);
/// After a link is sent, how long the phone has to connect before the next try.
const WAIT: Duration = Duration::from_secs(9);

#[derive(Debug, PartialEq)]
pub struct Phone {
    pub serial: String,
    pub model: String,
}

/// The one phone in `adb devices -l`, or the message to show when there isn't a usable one.
pub fn parse_devices(output: &str) -> Result<Phone, String> {
    let rows: Vec<(&str, &str, &str)> = output
        .lines()
        .skip(1)
        .filter(|line| !line.trim().is_empty() && !line.starts_with('*'))
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            Some((words.next()?, words.next()?, line))
        })
        .collect();
    let has = |state: &str| rows.iter().any(|row| row.1 == state);
    if has("unauthorized") {
        return Err("Unlock your Android phone and allow USB debugging for this PC".into());
    }
    if has("no") {
        return Err("This PC is not allowed to use the phone over USB. On Linux, add a udev rule for the phone".into());
    }
    if has("offline") {
        return Err("The phone is not responding. Unplug it, plug it in again and unlock it".into());
    }
    if rows.len() > 1 {
        return Err("Connect only one Android phone by USB at a time".into());
    }
    match rows.first() {
        Some((serial, "device", line)) => {
            let model = line.split_whitespace().find_map(|word| word.strip_prefix("model:")).unwrap_or_default().replace('_', " ");
            Ok(Phone { serial: (*serial).to_owned(), model })
        }
        _ => Err("Connect one Android phone by USB and turn on USB debugging".into()),
    }
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|byte| if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) { (byte as char).to_string() } else { format!("%{byte:02X}") })
        .collect()
}

/// The link the phone app opens to pair: the PC's address and key, and USB as the way to reach it.
pub fn pair_link(host: &str, port: u16, token: &str, name: &str) -> String {
    format!("opendock://pair?host={}&port={port}&token={token}&name={}&transport=usb", encode(host), encode(name))
}

/// Opens `link` in the Open Dock app on the phone.
pub fn send_link(adb: &Path, serial: &str, link: &str) -> Result<(), String> {
    // adb joins its arguments for the phone's shell, where `&` would end the command: quote the link.
    let quoted = format!("'{link}'");
    let output = adb::run(adb, &["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", &quoted, "-p", PACKAGE], Duration::from_secs(15))?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if output.status.success() && !text.contains("Error") {
        return Ok(());
    }
    Err(if text.contains("unable to resolve") || text.contains("not installed") {
        "Install or update the Open Dock app on the phone".into()
    } else {
        "Could not open Open Dock on the phone. Unlock it and try again".into()
    })
}

/// Where one plug-in is in its three tries.
#[derive(Default)]
pub struct Pairing {
    serial: String,
    since: Option<Instant>,
    tries: u8,
    last: Option<Instant>,
    was_connected: bool,
}

impl Pairing {
    /// The phone is gone: the next one starts fresh.
    pub fn lost(&mut self) {
        *self = Self::default();
    }

    /// The Retry button: three more tries, starting now.
    pub fn retry(&mut self, now: Instant) {
        self.tries = 0;
        self.last = None;
        self.was_connected = false;
        self.since = Some(now.checked_sub(GRACE).unwrap_or(now));
    }

    /// True when the link should be sent now.
    pub fn should_send(&mut self, serial: &str, connected: bool, now: Instant) -> bool {
        if self.serial != serial {
            *self = Self { serial: serial.to_owned(), since: Some(now), ..Self::default() };
        }
        if connected {
            self.was_connected = true;
            self.tries = 0;
            return false;
        }
        if self.was_connected {
            return false;
        }
        let since = self.since.unwrap_or(now);
        let due = match self.last {
            None => now.duration_since(since) >= GRACE,
            Some(last) => self.tries < MAX_TRIES && now.duration_since(last) >= WAIT,
        };
        if due {
            self.tries += 1;
            self.last = Some(now);
        }
        due
    }

    pub fn status(&self, connected: bool, now: Instant) -> &'static str {
        if connected {
            "connected"
        } else if self.was_connected {
            "idle"
        } else if self.tries >= MAX_TRIES && self.last.is_some_and(|last| now.duration_since(last) >= WAIT) {
            "failed"
        } else {
            "pairing"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_phone_and_explains_the_rest() {
        let list = |rows: &str| parse_devices(&format!("List of devices attached\n{rows}"));
        assert_eq!(list("R5CT\tdevice product:x model:Pixel_7 device:y transport_id:1\n"), Ok(Phone { serial: "R5CT".into(), model: "Pixel 7".into() }));
        assert_eq!(list("* daemon started successfully\nR5CT\tdevice\n").unwrap().model, "");
        assert!(list("R5CT\tunauthorized\n").unwrap_err().contains("allow USB debugging"));
        assert!(list("R5CT\toffline\n").unwrap_err().contains("not responding"));
        assert!(list("A\tdevice\nB\tdevice\n").unwrap_err().contains("only one"));
        assert!(list("").unwrap_err().starts_with("Connect one"));
    }

    #[test]
    fn the_link_is_one_safe_argument() {
        let link = pair_link("192.168.1.5", 39421, &"ab".repeat(32), "Dev's PC & more");
        assert_eq!(link, format!("opendock://pair?host=192.168.1.5&port=39421&token={}&name=Dev%27s%20PC%20%26%20more&transport=usb", "ab".repeat(32)));
        // No quote can end the shell's quoting around it.
        assert!(!link.contains('\''));
    }

    #[test]
    fn three_tries_then_failed_and_retry_gives_three_more() {
        let start = Instant::now();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        let mut pairing = Pairing::default();
        // A phone that is already connecting gets a moment before the first push.
        assert!(!pairing.should_send("P", false, at(0)));
        assert!(!pairing.should_send("P", false, at(2)));
        assert!(pairing.should_send("P", false, at(3)));
        assert!(!pairing.should_send("P", false, at(5)));
        assert!(pairing.should_send("P", false, at(12)));
        assert!(pairing.should_send("P", false, at(21)));
        assert_eq!(pairing.status(false, at(25)), "pairing");
        assert!(!pairing.should_send("P", false, at(40)), "no fourth try");
        assert_eq!(pairing.status(false, at(40)), "failed");
        pairing.retry(at(41));
        assert!(pairing.should_send("P", false, at(41)));
        assert_eq!(pairing.status(false, at(42)), "pairing");
        // A new cable starts fresh.
        pairing.lost();
        assert!(!pairing.should_send("P", false, at(50)));
    }

    #[test]
    fn a_phone_that_connected_is_not_pushed_again() {
        let start = Instant::now();
        let mut pairing = Pairing::default();
        assert!(!pairing.should_send("P", true, start));
        assert_eq!(pairing.status(true, start), "connected");
        // The app was closed on the phone: leave it alone.
        assert!(!pairing.should_send("P", false, start + Duration::from_secs(60)));
        assert_eq!(pairing.status(false, start), "idle");
    }
}
