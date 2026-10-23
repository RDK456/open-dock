//! Controls borrowed from WinDock: power and display actions, screenshots, the phone touchpad and keyboard,
//! and PIN pairing for phones that found this PC on the network instead of scanning its QR code.

use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
use rand::Rng;
use serde::{Deserialize, Serialize};

use super::quiet;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SystemCommand {
    Lock,
    Sleep,
    Restart,
    Shutdown,
    SignOut,
    BrightnessUp,
    BrightnessDown,
    Screenshot,
}

pub(super) fn run_system_command(command: SystemCommand) -> Result<(), String> {
    match command {
        SystemCommand::Screenshot => screenshot().map(|_| ()),
        SystemCommand::BrightnessUp => change_brightness(10),
        SystemCommand::BrightnessDown => change_brightness(-10),
        _ => power(command),
    }
}

#[cfg(windows)]
fn power(command: SystemCommand) -> Result<(), String> {
    let (program, args): (&str, &[&str]) = match command {
        SystemCommand::Lock => ("rundll32.exe", &["user32.dll,LockWorkStation"]),
        // ponytail: SetSuspendState hibernates instead when hibernation is on; a powrprof call can tell them apart if that matters.
        SystemCommand::Sleep => ("rundll32.exe", &["powrprof.dll,SetSuspendState", "0,1,0"]),
        SystemCommand::Restart => ("shutdown.exe", &["/r", "/t", "0"]),
        SystemCommand::Shutdown => ("shutdown.exe", &["/s", "/t", "0"]),
        SystemCommand::SignOut => ("shutdown.exe", &["/l"]),
        _ => unreachable!(),
    };
    quiet(&mut Command::new(program))
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|_| "Windows did not accept the power action".into())
}

#[cfg(target_os = "macos")]
fn power(command: SystemCommand) -> Result<(), String> {
    let (program, args): (&str, &[&str]) = match command {
        SystemCommand::Lock => ("pmset", &["displaysleepnow"]),
        SystemCommand::Sleep => ("pmset", &["sleepnow"]),
        SystemCommand::Restart => ("osascript", &["-e", "tell app \"System Events\" to restart"]),
        SystemCommand::Shutdown => ("osascript", &["-e", "tell app \"System Events\" to shut down"]),
        SystemCommand::SignOut => ("osascript", &["-e", "tell app \"System Events\" to log out"]),
        _ => unreachable!(),
    };
    quiet(&mut Command::new(program))
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|_| "macOS did not accept the power action".into())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn power(_: SystemCommand) -> Result<(), String> {
    Err("Power actions are not supported on this platform".into())
}

/// Built-in panels only (WMI); ponytail: external monitors need DDC/CI, add it when someone asks.
#[cfg(windows)]
fn change_brightness(step: i32) -> Result<(), String> {
    let script = format!(
        "$b=(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness; \
         $n=[Math]::Max(0,[Math]::Min(100,$b+({step}))); \
         Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=1;Brightness=[byte]$n}} | Out-Null"
    );
    let output = quiet(&mut Command::new("powershell.exe"))
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|_| "Could not change the brightness".to_owned())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("This display does not let Windows change its brightness".into())
    }
}

#[cfg(not(windows))]
fn change_brightness(_step: i32) -> Result<(), String> {
    // ponytail: macOS has no public brightness API; the keyboard's brightness keys still work.
    Err("Use the Mac's brightness keys".into())
}

fn capture_folder() -> Result<PathBuf, String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| "Could not find your Pictures folder".to_owned())?;
    let folder = PathBuf::from(home).join("Pictures").join("Open Dock");
    std::fs::create_dir_all(&folder).map_err(|_| "Could not create the Pictures/Open Dock folder".to_owned())?;
    Ok(folder)
}

fn capture_path() -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis())
        .unwrap_or_default();
    Ok(capture_folder()?.join(format!("Screenshot-{stamp}.png")))
}

/// Saves the main monitor as a PNG in Pictures/Open Dock and returns where it went.
#[cfg(windows)]
pub(super) fn screenshot() -> Result<PathBuf, String> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    let (width, height) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    if width <= 0 || height <= 0 {
        return Err("No monitor to capture".into());
    }
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    // SAFETY: every handle made here is released before returning; GetDIBits writes at most width*height*4 bytes.
    let lines = unsafe {
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap.into());
        let copied = BitBlt(memory, 0, 0, width, height, Some(screen), 0, 0, SRCCOPY).is_ok();
        SelectObject(memory, previous);
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            ..Default::default()
        };
        let lines = if copied {
            GetDIBits(memory, bitmap, 0, height as u32, Some(pixels.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS)
        } else {
            0
        };
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        lines
    };
    if lines != height {
        return Err("Windows did not hand over the screen image".into());
    }
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    let png = super::icon_png::encode_png(width as u32, height as u32, &pixels)?;
    let path = capture_path()?;
    std::fs::write(&path, png).map_err(|_| "Could not save the screenshot".to_owned())?;
    Ok(path)
}

#[cfg(target_os = "macos")]
pub(super) fn screenshot() -> Result<PathBuf, String> {
    let path = capture_path()?;
    let status = quiet(&mut Command::new("screencapture"))
        .args(["-x", "-m"])
        .arg(&path)
        .status()
        .map_err(|_| "Could not run screencapture".to_owned())?;
    if status.success() {
        Ok(path)
    } else {
        Err("Allow Open Dock to record the screen in Privacy & Security".into())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(super) fn screenshot() -> Result<PathBuf, String> {
    Err("Screenshots are not supported on this platform".into())
}

/// A finger-drawn signature: strokes of `[x, y]` points on a 1600×600 canvas, 0,0 at the top left.
pub(super) type Strokes = Vec<Vec<[f32; 2]>>;
const SIGN_WIDTH: u32 = 1600;
const SIGN_HEIGHT: u32 = 600;

pub(super) fn signature_is_valid(strokes: &Strokes) -> bool {
    let points: usize = strokes.iter().map(Vec::len).sum();
    !strokes.is_empty()
        && strokes.len() <= 300
        && points <= 20_000
        && strokes.iter().flatten().all(|[x, y]| x.is_finite() && y.is_finite())
}

/// Draws the strokes in dark ink on a transparent canvas, as RGBA.
fn draw_signature(strokes: &Strokes) -> Vec<u8> {
    const RADIUS: f32 = 5.0;
    let (width, height) = (SIGN_WIDTH as i64, SIGN_HEIGHT as i64);
    let mut rgba = vec![0u8; (width * height * 4) as usize];
    // ponytail: stamps an antialiased disc every pixel along each segment; fine at 20k points on 1600×600.
    let mut stamp = |cx: f32, cy: f32| {
        let x0 = ((cx - RADIUS).floor() as i64).max(0);
        let x1 = ((cx + RADIUS).ceil() as i64).min(width - 1);
        let y0 = ((cy - RADIUS).floor() as i64).max(0);
        let y1 = ((cy + RADIUS).ceil() as i64).min(height - 1);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let distance = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                let alpha = ((RADIUS + 0.5 - distance).clamp(0.0, 1.0) * 255.0) as u8;
                let index = ((y * width + x) * 4) as usize;
                if alpha > rgba[index + 3] {
                    rgba[index..index + 4].copy_from_slice(&[24, 24, 27, alpha]);
                }
            }
        }
    };
    for stroke in strokes {
        if let [[x, y]] = stroke[..] {
            stamp(x, y);
        }
        for pair in stroke.windows(2) {
            let ([ax, ay], [bx, by]) = (pair[0], pair[1]);
            let steps = (bx - ax).hypot(by - ay).ceil().clamp(1.0, 4_000.0) as usize;
            for step in 0..=steps {
                let t = step as f32 / steps as f32;
                stamp(ax + (bx - ax) * t, ay + (by - ay) * t);
            }
        }
    }
    rgba
}

/// Saves the signature as a transparent PNG in Pictures/Open Dock/Signatures, puts it on the clipboard
/// and pastes it into whatever has focus on the PC.
pub(super) fn insert_signature(strokes: &Strokes) -> Result<PathBuf, String> {
    let png = super::icon_png::encode_png(SIGN_WIDTH, SIGN_HEIGHT, &draw_signature(strokes))?;
    let folder = capture_folder()?.join("Signatures");
    std::fs::create_dir_all(&folder).map_err(|_| "Could not create the Signatures folder".to_owned())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis())
        .unwrap_or_default();
    let path = folder.join(format!("Signature-{stamp}.png"));
    std::fs::write(&path, png).map_err(|_| "Could not save the signature".to_owned())?;
    copy_image(&path)?;
    let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
    let held = if cfg!(target_os = "macos") { enigo::Key::Meta } else { enigo::Key::Control };
    let _ = enigo.key(held, Direction::Press);
    let pasted = enigo.key(enigo::Key::Unicode('v'), Direction::Click);
    let _ = enigo.key(held, Direction::Release);
    pasted.map_err(|error| error.to_string())?;
    Ok(path)
}

/// Offers the PNG with its transparency for apps that read it, and on white as a bitmap for those that do not.
#[cfg(windows)]
fn copy_image(path: &std::path::Path) -> Result<(), String> {
    let path = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
         $bytes = [IO.File]::ReadAllBytes('{path}'); $data = New-Object Windows.Forms.DataObject; \
         $data.SetData('PNG', (New-Object IO.MemoryStream(,$bytes))); \
         $image = [Drawing.Image]::FromStream((New-Object IO.MemoryStream(,$bytes))); \
         $flat = New-Object Drawing.Bitmap($image.Width, $image.Height); $g = [Drawing.Graphics]::FromImage($flat); \
         $g.Clear([Drawing.Color]::White); $g.DrawImage($image, 0, 0); $data.SetImage($flat); \
         [Windows.Forms.Clipboard]::SetDataObject($data, $true)"
    );
    let status = quiet(&mut Command::new("powershell.exe"))
        .args(["-NoProfile", "-STA", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|_| "Could not reach the clipboard".to_owned())?;
    if status.success() { Ok(()) } else { Err("Could not copy the signature".into()) }
}

#[cfg(target_os = "macos")]
fn copy_image(path: &std::path::Path) -> Result<(), String> {
    let path = path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let status = quiet(&mut Command::new("osascript"))
        .args(["-e", &format!("set the clipboard to (read (POSIX file \"{path}\") as «class PNGf»)")])
        .status()
        .map_err(|_| "Could not reach the clipboard".to_owned())?;
    if status.success() { Ok(()) } else { Err("Could not copy the signature".into()) }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn copy_image(_path: &std::path::Path) -> Result<(), String> {
    Err("Signatures are not supported on this platform".into())
}

/// One touchpad or keyboard event from the phone. Moves are relative, in PC pixels.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum PointerEvent {
    Move { dx: i32, dy: i32 },
    Scroll { dx: i32, dy: i32 },
    /// Pinch: wheel steps with Ctrl (Cmd on a Mac) held, which zooms browsers, editors and image viewers.
    Zoom { steps: i32 },
    Click { button: PointerButton },
    Press { button: PointerButton },
    Release { button: PointerButton },
    Text { text: String },
    Key { key: String },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum PointerButton {
    Left,
    Right,
    Middle,
}

impl PointerEvent {
    pub(super) fn is_valid(&self) -> bool {
        let small = |value: &i32| value.abs() <= 4_000;
        match self {
            PointerEvent::Move { dx, dy } | PointerEvent::Scroll { dx, dy } => small(dx) && small(dy),
            PointerEvent::Zoom { steps } => steps.abs() <= 20,
            PointerEvent::Text { text } => !text.is_empty() && text.len() <= 2_000,
            PointerEvent::Key { key } => super::parse_key(key).is_ok(),
            _ => true,
        }
    }
}

/// Input runs on one thread with one Enigo: making an Enigo per touch move is too slow for a touchpad.
pub(super) fn send_pointer(event: PointerEvent) {
    static SENDER: OnceLock<Mutex<mpsc::Sender<PointerEvent>>> = OnceLock::new();
    let sender = SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<PointerEvent>();
        thread::spawn(move || {
            let Ok(mut enigo) = Enigo::new(&Settings::default()) else { return };
            let button = |button: PointerButton| match button {
                PointerButton::Left => Button::Left,
                PointerButton::Right => Button::Right,
                PointerButton::Middle => Button::Middle,
            };
            for event in receiver {
                let _ = match event {
                    PointerEvent::Move { dx, dy } => enigo.move_mouse(dx, dy, Coordinate::Rel),
                    PointerEvent::Scroll { dx, dy } => {
                        if dy != 0 {
                            let _ = enigo.scroll(dy, Axis::Vertical);
                        }
                        if dx != 0 { enigo.scroll(dx, Axis::Horizontal) } else { Ok(()) }
                    }
                    PointerEvent::Zoom { steps } => {
                        let held = if cfg!(target_os = "macos") { enigo::Key::Meta } else { enigo::Key::Control };
                        let _ = enigo.key(held, Direction::Press);
                        let _ = enigo.scroll(-steps, Axis::Vertical);
                        enigo.key(held, Direction::Release)
                    }
                    PointerEvent::Click { button: b } => enigo.button(button(b), Direction::Click),
                    PointerEvent::Press { button: b } => enigo.button(button(b), Direction::Press),
                    PointerEvent::Release { button: b } => enigo.button(button(b), Direction::Release),
                    PointerEvent::Text { text } => enigo.text(&text),
                    PointerEvent::Key { key } => match super::parse_key(&key) {
                        Ok(key) => enigo.key(key, Direction::Click),
                        Err(_) => Ok(()),
                    },
                };
            }
        });
        Mutex::new(sender)
    });
    if let Ok(sender) = sender.lock() {
        let _ = sender.send(event);
    }
}

/// Releases every button, for when the phone leaves the touchpad or drops mid-drag.
pub(super) fn release_buttons() {
    for button in [PointerButton::Left, PointerButton::Right, PointerButton::Middle] {
        send_pointer(PointerEvent::Release { button });
    }
}

/// The six-digit code shown on the PC. A phone that found this PC on the network trades it for the pairing key.
/// A new code is drawn after each pairing and after 5 wrong guesses, so guessing does not pay.
pub(super) struct PinPairing {
    pin: String,
    failures: u8,
}

impl PinPairing {
    pub(super) fn new() -> Self {
        Self { pin: Self::draw(), failures: 0 }
    }

    fn draw() -> String {
        format!("{:06}", rand::rng().random_range(0..1_000_000))
    }

    pub(super) fn pin(&self) -> &str {
        &self.pin
    }

    /// True when `guess` is the current code. Either way the code may change.
    pub(super) fn check(&mut self, guess: &str) -> bool {
        if guess.trim() == self.pin {
            self.pin = Self::draw();
            self.failures = 0;
            return true;
        }
        self.failures += 1;
        if self.failures >= 5 {
            self.pin = Self::draw();
            self.failures = 0;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_works_once_and_five_misses_change_it() {
        let mut pairing = PinPairing::new();
        let pin = pairing.pin().to_owned();
        assert_eq!(pin.len(), 6);
        assert!(pairing.check(&pin));
        assert_ne!(pairing.pin(), pin, "a used code is replaced");

        let pin = pairing.pin().to_owned();
        let wrong = if pin == "000000" { "000001" } else { "000000" };
        for _ in 0..4 {
            assert!(!pairing.check(wrong));
        }
        assert_eq!(pairing.pin(), pin, "four misses keep the code");
        assert!(!pairing.check(wrong));
        assert_ne!(pairing.pin(), pin, "the fifth miss draws a new code");
    }

    #[test]
    fn pointer_events_are_bounded() {
        assert!(PointerEvent::Move { dx: 10, dy: -10 }.is_valid());
        assert!(!PointerEvent::Move { dx: 9_000, dy: 0 }.is_valid());
        assert!(PointerEvent::Zoom { steps: -3 }.is_valid());
        assert!(!signature_is_valid(&vec![]));
        assert!(!signature_is_valid(&vec![vec![[f32::NAN, 1.0]]]));
    }

    #[test]
    fn a_signature_inks_only_along_its_stroke() {
        let rgba = draw_signature(&vec![vec![[100.0, 300.0], [200.0, 300.0]], vec![[-50.0, 9_000.0]]]);
        let alpha = |x: usize, y: usize| rgba[(y * SIGN_WIDTH as usize + x) * 4 + 3];
        assert_eq!(alpha(150, 300), 255, "on the line");
        assert_eq!(alpha(150, 320), 0, "beside the line");
        assert_eq!(alpha(10, 10), 0, "a point off the canvas draws nothing");
        assert!(!PointerEvent::Zoom { steps: 500 }.is_valid());
        assert!(!PointerEvent::Text { text: String::new() }.is_valid());
        assert!(PointerEvent::Key { key: "ENTER".into() }.is_valid());
        assert!(!PointerEvent::Key { key: "NOPE".into() }.is_valid());
    }
}
