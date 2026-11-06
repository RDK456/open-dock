//! The PC's clipboard history for the phone's Clipboard widget.
//!
//! Text only, kept in memory and never written to disk. The clipboard is read only while a phone is
//! showing the widget, anything copied before that stays unread, and the history is dropped after five
//! minutes with no phone watching. Copies a password manager marks as private are skipped.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::watch;

const MAX_ITEMS: usize = 20;
const MAX_CHARS: usize = 2000;
const FORGET_AFTER: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClipItem {
    pub(super) id: u64,
    pub(super) text: String,
    pub(super) at_ms: u64,
}

pub(super) struct ClipboardHistory {
    items: watch::Sender<Vec<ClipItem>>,
    /// Phone connections currently showing a clipboard widget.
    watchers: AtomicUsize,
    next_id: AtomicU64,
}

/// What one look at the clipboard found.
enum Read {
    /// Another program had it open; look again soon.
    Busy,
    /// Not text, empty, or marked private.
    Skip,
    Text(String),
}

impl ClipboardHistory {
    /// Whether this PC can read the clipboard; the phone shows a note where it can't.
    pub(super) const SUPPORTED: bool = cfg!(windows);

    pub(super) fn new() -> Self {
        Self { items: watch::channel(Vec::new()).0, watchers: AtomicUsize::new(0), next_id: AtomicU64::new(1) }
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<Vec<ClipItem>> {
        self.items.subscribe()
    }

    pub(super) fn snapshot(&self) -> Vec<ClipItem> {
        self.items.borrow().clone()
    }

    /// A phone started or stopped showing the widget.
    pub(super) fn watch(&self, on: bool) {
        if on {
            self.watchers.fetch_add(1, Ordering::Relaxed);
        } else {
            #[allow(deprecated)] // `try_update` needs a newer Rust than the release build uses
            let _ = self.watchers.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| count.checked_sub(1));
        }
    }

    fn push(&self, text: String) {
        let at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64);
        self.items.send_modify(|items| {
            // Copying the same text again moves it to the front.
            let id = match items.iter().position(|item| item.text == text) {
                Some(position) => items.remove(position).id,
                None => self.next_id.fetch_add(1, Ordering::Relaxed),
            };
            items.insert(0, ClipItem { id, text, at_ms });
            items.truncate(MAX_ITEMS);
        });
    }

    /// Puts a clip from the history back on the PC's clipboard. Phones name a clip by id and never send text.
    pub(super) fn copy_to_pc(&self, id: u64) -> Result<(), String> {
        let text = self
            .items
            .borrow()
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.text.clone())
            .ok_or_else(|| "That clip is no longer in the history".to_owned())?;
        platform::write_text(&text)
    }
}

pub(super) fn spawn_monitor(history: Arc<ClipboardHistory>) {
    std::thread::spawn(move || {
        let mut last_seen = platform::sequence();
        let mut watched = false;
        let mut idle_since = Instant::now();
        loop {
            if history.watchers.load(Ordering::Relaxed) > 0 {
                if !watched {
                    // What was copied before the widget came on screen stays unread.
                    last_seen = platform::sequence();
                    watched = true;
                }
                idle_since = Instant::now();
                let now = platform::sequence();
                if now != last_seen {
                    match platform::read_text() {
                        Read::Busy => {}
                        Read::Skip => last_seen = now,
                        Read::Text(text) => {
                            last_seen = now;
                            history.push(text.chars().take(MAX_CHARS).collect());
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(400));
            } else {
                watched = false;
                if idle_since.elapsed() > FORGET_AFTER && !history.items.borrow().is_empty() {
                    history.items.send_modify(Vec::clear);
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    });
}

#[cfg(windows)]
mod platform {
    use super::Read;
    use windows::{
        core::w,
        Win32::{
            Foundation::{HANDLE, HGLOBAL},
            System::{
                DataExchange::{
                    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
                    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
                },
                Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            },
        },
    };

    /// The standard "Unicode text" clipboard format.
    const CF_UNICODETEXT: u32 = 13;

    /// Changes on every copy, so a look at the clipboard is only needed when it moves.
    pub(super) fn sequence() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    /// Closes the clipboard when dropped, however a read ends.
    struct Open;
    impl Open {
        fn new() -> Option<Self> {
            unsafe { OpenClipboard(None).ok().map(|()| Self) }
        }
    }
    impl Drop for Open {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    pub(super) fn read_text() -> Read {
        unsafe {
            let Some(_open) = Open::new() else { return Read::Busy };
            // Password managers and the like mark what they copy as not for history.
            let skip_monitor = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
            if skip_monitor != 0 && IsClipboardFormatAvailable(skip_monitor).is_ok() {
                return Read::Skip;
            }
            let in_history = RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"));
            if in_history != 0 && IsClipboardFormatAvailable(in_history).is_ok() {
                if let Ok(handle) = GetClipboardData(in_history) {
                    let global = HGLOBAL(handle.0);
                    let pointer = GlobalLock(global) as *const u32;
                    if !pointer.is_null() {
                        let allowed = pointer.read_unaligned() != 0;
                        let _ = GlobalUnlock(global);
                        if !allowed {
                            return Read::Skip;
                        }
                    }
                }
            }
            if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() {
                return Read::Skip;
            }
            let Ok(handle) = GetClipboardData(CF_UNICODETEXT) else { return Read::Busy };
            let global = HGLOBAL(handle.0);
            let pointer = GlobalLock(global) as *const u16;
            if pointer.is_null() {
                return Read::Busy;
            }
            let capacity = GlobalSize(global) / 2;
            let mut length = 0;
            while length < capacity && *pointer.add(length) != 0 {
                length += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
            let _ = GlobalUnlock(global);
            if text.trim().is_empty() {
                Read::Skip
            } else {
                Read::Text(text)
            }
        }
    }

    pub(super) fn write_text(text: &str) -> Result<(), String> {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let _open = Open::new().ok_or_else(|| "The clipboard is in use by another program".to_owned())?;
            EmptyClipboard().map_err(|error| error.to_string())?;
            let global = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|error| error.to_string())?;
            let pointer = GlobalLock(global) as *mut u16;
            if pointer.is_null() {
                return Err("Could not reserve memory for the clipboard".into());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
            let _ = GlobalUnlock(global);
            // On success the clipboard owns the memory.
            SetClipboardData(CF_UNICODETEXT, Some(HANDLE(global.0))).map_err(|error| error.to_string())?;
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Read;

    pub(super) fn sequence() -> u32 {
        0
    }

    pub(super) fn read_text() -> Read {
        Read::Skip
    }

    pub(super) fn write_text(_text: &str) -> Result<(), String> {
        Err("Clipboard history isn't supported on this PC yet".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copying_the_same_text_again_moves_it_to_the_front_and_keeps_its_id() {
        let history = ClipboardHistory::new();
        history.push("one".into());
        history.push("two".into());
        let first_id = history.snapshot()[1].id;
        history.push("one".into());
        let items = history.snapshot();
        assert_eq!(items.iter().map(|item| item.text.as_str()).collect::<Vec<_>>(), ["one", "two"]);
        assert_eq!(items[0].id, first_id);
    }

    #[test]
    fn keeps_only_the_newest_twenty() {
        let history = ClipboardHistory::new();
        for number in 0..30 {
            history.push(format!("clip {number}"));
        }
        let items = history.snapshot();
        assert_eq!(items.len(), MAX_ITEMS);
        assert_eq!(items[0].text, "clip 29");
    }

    #[test]
    fn a_missing_clip_is_reported_not_copied() {
        let history = ClipboardHistory::new();
        assert!(history.copy_to_pc(99).is_err());
    }

    #[test]
    fn watcher_count_never_goes_below_zero() {
        let history = ClipboardHistory::new();
        history.watch(false);
        history.watch(true);
        history.watch(false);
        history.watch(false);
        assert_eq!(history.watchers.load(Ordering::Relaxed), 0);
    }
}
