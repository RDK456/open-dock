//! Frames per second of the game in front, for the FPS widgets. Windows only.
//! Like PresentMon, it listens to the present calls that Windows traces (ETW): DXGI covers DirectX 10-12,
//! D3D9 covers old games, and the kernel's present event covers Vulkan and OpenGL. Presents are counted
//! per process; the foreground window's process is the game. The window decides the mode: a window the
//! size of its monitor is Fullscreen when Windows reports exclusive Direct3D, else Borderless; any
//! other window is Windowed. Tracing needs admin rights, which the app has when it starts with Windows.
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
    thread::JoinHandle,
};
use windows::{
    core::{GUID, PCWSTR, PWSTR},
    Win32::{
        Foundation::{HWND, RECT},
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        System::Diagnostics::Etw::{
            CloseTrace, ControlTraceW, EnableTraceEx2, OpenTraceW, ProcessTrace, StartTraceW,
            CONTROLTRACE_HANDLE, EVENT_CONTROL_CODE_ENABLE_PROVIDER, EVENT_RECORD,
            EVENT_TRACE_CONTROL_STOP, EVENT_TRACE_LOGFILEW, EVENT_TRACE_PROPERTIES,
            EVENT_TRACE_REAL_TIME_MODE, PROCESS_TRACE_MODE_EVENT_RECORD,
            PROCESS_TRACE_MODE_REAL_TIME, PROCESSTRACE_HANDLE, WNODE_FLAG_TRACED_GUID,
        },
        UI::{
            Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN},
            WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId},
        },
    },
};

const SESSION: &str = "OpenDockFps";
const DXGI: GUID = GUID::from_u128(0xCA11C036_0102_4A2D_A6AD_F03CFED5D3C9);
const D3D9: GUID = GUID::from_u128(0x783ACA0A_790E_4D7F_8451_AA850511C6B9);
const DXGKRNL: GUID = GUID::from_u128(0x802EC45A_1E99_4B83_9920_87C98277BA9D);
/// Present_Start in DXGI and D3D9, and the kernel's Present info event.
const DXGI_PRESENT: u16 = 42;
const D3D9_PRESENT: u16 = 1;
const KERNEL_PRESENT: u16 = 184;
/// Windowed programs that present constantly but are not games.
const NOT_GAMES: &[&str] = &["explorer", "dwm", "chrome", "msedge", "firefox", "brave", "opera", "code", "claude", "discord", "spotify", "slack", "teams", "msedgewebview2", "vlc", "mpv", "obs64", "taskmgr"];
/// A windowed program that is not a known game shows an FPS only above this.
const WINDOWED_MIN_FPS: f32 = 20.0;

/// Presents since the last read, with the first and last event time (100 ns), so the rate does not
/// depend on when Windows hands the buffered events over.
#[derive(Clone, Copy, Default)]
struct Presents {
    n: u32,
    first: i64,
    last: i64,
}

impl Presents {
    fn rate(self) -> f32 {
        if self.n < 2 || self.last <= self.first {
            return 0.0;
        }
        (self.n - 1) as f32 * 1e7 / (self.last - self.first) as f32
    }
}

/// Presents per process since the last read: [DXGI and D3D9, kernel].
fn counts() -> &'static Mutex<HashMap<u32, [Presents; 2]>> {
    static COUNTS: OnceLock<Mutex<HashMap<u32, [Presents; 2]>>> = OnceLock::new();
    COUNTS.get_or_init(Default::default)
}

unsafe extern "system" fn on_event(record: *mut EVENT_RECORD) {
    let header = &(*record).EventHeader;
    let (slot, wanted) = match header.ProviderId {
        id if id == DXGI => (0, DXGI_PRESENT),
        id if id == D3D9 => (0, D3D9_PRESENT),
        id if id == DXGKRNL => (1, KERNEL_PRESENT),
        _ => return,
    };
    if header.EventDescriptor.Id == wanted {
        if let Ok(mut counts) = counts().lock() {
            let at = header.TimeStamp;
            let presents = &mut counts.entry(header.ProcessId).or_default()[slot];
            if presents.n == 0 {
                presents.first = at;
            }
            presents.n += 1;
            presents.last = at;
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// The trace session's properties, with room for its name behind them.
fn properties() -> Vec<u64> {
    let size = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() + 2 * (SESSION.len() + 1);
    let mut buffer = vec![0u64; size.div_ceil(8)];
    let properties = buffer.as_mut_ptr().cast::<EVENT_TRACE_PROPERTIES>();
    unsafe {
        (*properties).Wnode.BufferSize = size as u32;
        (*properties).Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        // Event times in system time (100 ns), and buffers handed over every second.
        (*properties).Wnode.ClientContext = 2;
        (*properties).FlushTimer = 1;
        (*properties).LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
        (*properties).LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;
    }
    buffer
}

/// Stops our session by handle, or by name with a default handle (one left running by a crash).
fn stop_session(handle: CONTROLTRACE_HANDLE) {
    let mut buffer = properties();
    let name = wide(SESSION);
    unsafe {
        let _ = ControlTraceW(
            handle,
            PCWSTR(name.as_ptr()),
            buffer.as_mut_ptr().cast(),
            EVENT_TRACE_CONTROL_STOP,
        );
    }
}

/// A running trace. Dropping it stops the session.
pub(super) struct FpsMeter {
    session: CONTROLTRACE_HANDLE,
    consumer: Option<JoinHandle<()>>,
}

/// What the game in front is doing.
pub(super) struct FpsReading {
    pub(super) fps: f32,
    pub(super) game: String,
    pub(super) mode: &'static str,
}

impl FpsMeter {
    /// None when tracing is refused, which is the case without admin rights.
    pub(super) fn new() -> Option<Self> {
        stop_session(CONTROLTRACE_HANDLE::default());
        counts().lock().ok()?.clear();
        let mut buffer = properties();
        let name = wide(SESSION);
        let mut session = CONTROLTRACE_HANDLE::default();
        unsafe {
            if StartTraceW(&mut session, PCWSTR(name.as_ptr()), buffer.as_mut_ptr().cast()).is_err() {
                return None;
            }
            for (provider, keywords) in [(DXGI, 0), (D3D9, 0), (DXGKRNL, 1)] {
                let _ = EnableTraceEx2(session, &provider, EVENT_CONTROL_CODE_ENABLE_PROVIDER.0, 4, keywords, 0, 0, None);
            }
        }
        let consumer = std::thread::spawn(|| unsafe {
            let mut name = wide(SESSION);
            let mut log = EVENT_TRACE_LOGFILEW::default();
            log.LoggerName = PWSTR(name.as_mut_ptr());
            log.Anonymous1.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
            log.Anonymous2.EventRecordCallback = Some(on_event);
            let trace: PROCESSTRACE_HANDLE = OpenTraceW(&mut log);
            if trace.Value == u64::MAX {
                return;
            }
            let _ = ProcessTrace(&[trace], None, None);
            let _ = CloseTrace(trace);
        });
        Some(FpsMeter { session, consumer: Some(consumer) })
    }

    /// The game in front and its frame rate over the last `seconds`; None when nothing in front is a game.
    pub(super) fn read(&mut self) -> Option<FpsReading> {
        let seen = std::mem::take(&mut *counts().lock().ok()?);
        let (window, pid) = foreground()?;
        let [primary, kernel] = seen.get(&pid).copied().unwrap_or_default();
        let fps = if primary.n > 0 { primary } else { kernel }.rate();
        let app = crate::foreground_app()?;
        let known = crate::game_name(&app);
        let stem = Path::new(&app.path).file_stem()?.to_str()?.to_lowercase();
        let mode = window_mode(window);
        let game = known.is_some() || mode != "Windowed";
        if fps <= 0.0 || (!game && (fps < WINDOWED_MIN_FPS || NOT_GAMES.contains(&stem.as_str()))) {
            return None;
        }
        Some(FpsReading { fps: (fps * 10.0).round() / 10.0, game: known.unwrap_or(stem), mode })
    }
}

impl Drop for FpsMeter {
    fn drop(&mut self) {
        stop_session(self.session);
        if let Some(consumer) = self.consumer.take() {
            let _ = consumer.join();
        }
    }
}

fn foreground() -> Option<(HWND, u32)> {
    unsafe {
        let window = GetForegroundWindow();
        let mut pid = 0;
        GetWindowThreadProcessId(window, Some(&mut pid));
        (!window.is_invalid() && pid != 0 && pid != std::process::id()).then_some((window, pid))
    }
}

/// "Fullscreen", "Borderless" or "Windowed", from the window's size against its monitor.
fn window_mode(window: HWND) -> &'static str {
    unsafe {
        let mut area = RECT::default();
        let mut monitor = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let screen = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        if GetWindowRect(window, &mut area).is_err() || !GetMonitorInfoW(screen, &mut monitor).as_bool() {
            return "Windowed";
        }
        let full = monitor.rcMonitor;
        let covers = area.left <= full.left && area.top <= full.top && area.right >= full.right && area.bottom >= full.bottom;
        match (covers, SHQueryUserNotificationState()) {
            (false, _) => "Windowed",
            (true, Ok(state)) if state == QUNS_RUNNING_D3D_FULL_SCREEN => "Fullscreen",
            _ => "Borderless",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Counts presents for 4 s with admin rights: `cargo test --lib fps_live -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs admin rights and a program drawing"]
    fn fps_live() {
        let mut meter = FpsMeter::new().expect("no trace session (run as admin)");
        std::thread::sleep(std::time::Duration::from_secs(4));
        let seen = counts().lock().unwrap().clone();
        let mut rows: Vec<_> = seen.into_iter().collect();
        rows.sort_by_key(|(_, count)| std::cmp::Reverse(count[0].n + count[1].n));
        for (pid, [primary, kernel]) in rows.iter().take(8) {
            println!("pid {pid}: dxgi/d3d9 {}, kernel {}", primary.n, kernel.n);
        }
        println!("{:?}", meter.read().map(|r| (r.fps, r.game, r.mode)));
        assert!(!rows.is_empty(), "no present events seen");
    }
}
