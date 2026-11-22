//! The voice island: a pill at the top of the PC's screen, over every app, while a voice command is heard and run.
//! It is the app's own page in a second window (main.tsx renders `Island` there), transparent and click-through,
//! so showing it never takes focus from the app in front; the page draws or hides the pill. The window is made
//! the first time a voice command is heard, so a PC that never uses voice never pays for a second web view.
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "island";
const WIDTH: f64 = 420.0;
const HEIGHT: f64 = 80.0;
static APP: OnceLock<AppHandle> = OnceLock::new();
/// What the pill shows now, for a window that opens after the event was sent.
static LAST: Mutex<Option<serde_json::Value>> = Mutex::new(None);

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn open(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Open Dock voice")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .inner_size(WIDTH, HEIGHT)
        .build()?;
    window.set_ignore_cursor_events(true)?;
    place();
    Ok(())
}

/// The pill's state for a window that just opened.
#[tauri::command]
pub fn island_state() -> Option<serde_json::Value> {
    LAST.lock().ok().and_then(|last| last.clone())
}

/// Top centre of the primary screen (checked again each time, in case the screens changed).
fn place() {
    let Some(window) = APP.get().and_then(|app| app.get_webview_window(LABEL)) else { return };
    let Ok(Some(monitor)) = window.primary_monitor() else { return };
    let scale = monitor.scale_factor();
    let x = monitor.position().x + (monitor.size().width as i32 - (WIDTH * scale) as i32) / 2;
    let _ = window.set_position(PhysicalPosition::new(x, monitor.position().y + (6.0 * scale) as i32));
}

/// `state` is "listening", "working", "done", "failed" or "idle"; `text` is what was heard, or what happened.
pub fn show(state: &str, text: &str) {
    let Some(app) = APP.get() else { return };
    let opened = app.get_webview_window(LABEL).is_some();
    if state == "idle" && !opened {
        return;
    }
    if !opened {
        if let Err(error) = open(app) {
            eprintln!("Open Dock: no voice island ({error})");
            return;
        }
    } else if state != "idle" {
        place();
    }
    let text: String = text.chars().take(120).collect();
    let payload = serde_json::json!({ "state": state, "text": text });
    if let Ok(mut last) = LAST.lock() {
        *last = Some(payload.clone());
    }
    let _ = app.emit_to(LABEL, "island", payload);
}
