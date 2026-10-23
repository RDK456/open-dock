//! The voice island: a pill at the top of the PC's screen, over every app, while a voice command is heard and run.
//! It is the app's own page in a second window (main.tsx renders `Island` there), always present but transparent
//! and click-through, so showing it never takes focus from the app in front; the page draws or hides the pill.
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "island";
const WIDTH: f64 = 420.0;
const HEIGHT: f64 = 80.0;
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) -> tauri::Result<()> {
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
    let _ = APP.set(app.clone());
    place();
    Ok(())
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
    if state != "idle" {
        place();
    }
    let text: String = text.chars().take(120).collect();
    let _ = app.emit_to(LABEL, "island", serde_json::json!({ "state": state, "text": text }));
}
