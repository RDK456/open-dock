//! Phone cameras as webcams. Each phone runs a camera service (phone-app/modules/opencam) that streams H.264 over
//! TCP 47100 to whoever sends the pairing key first. This module links to every phone the user connects (Wi-Fi:
//! the address the deck link already knows; USB: an `adb forward`), shows each as its own camera, and feeds the one
//! the user picks into the "Open Dock Camera" virtual camera (camera-host/host.cpp, a helper process that decodes
//! the video and shares frames with the Windows camera DLL). Wire format: the openCam protocol, see camera-host.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

use crate::adb;

const PHONE_PORT: u16 = 47100;
const T_CONFIG: u8 = 1;
const T_FRAME: u8 = 2;
const T_JSON: u8 = 3;

/// Phones connected to the deck over Wi-Fi: (phone id, name, address).
static PHONES: Mutex<Vec<(String, String, IpAddr)>> = Mutex::new(Vec::new());
static SESSIONS: Mutex<Vec<Arc<Session>>> = Mutex::new(Vec::new());
/// The camera source feeding the virtual camera.
static ACTIVE: Mutex<Option<String>> = Mutex::new(None);
static HOST: Mutex<Option<Host>> = Mutex::new(None);
static HOST_STATE: Mutex<HostState> = Mutex::new(HostState { ready: false, error: String::new(), consumer: false });
static CONSUMER: AtomicBool = AtomicBool::new(false);
static INSTALLED: AtomicBool = AtomicBool::new(false);
/// Cameras being connected right now.
static CONNECTING: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct Host {
    /// Held so the helper lives as long as this; it exits when stdin closes.
    _child: Child,
    stdin: ChildStdin,
}

struct HostState {
    ready: bool,
    error: String,
    consumer: bool,
}

struct Session {
    id: String,
    name: String,
    stop: AtomicBool,
    writer: Mutex<TcpStream>,
    caps: Mutex<Value>,
    state: Mutex<Value>,
    csd: Mutex<Vec<u8>>,
    preview: Mutex<Option<Channel<InvokeResponseBody>>>,
    /// What the phone was last told about whether frames are wanted.
    demand: AtomicBool,
}

impl Session {
    fn send(&self, kind: u8, payload: &[u8]) -> bool {
        let mut head = [0u8; 5];
        head[0] = kind;
        head[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
        let Ok(mut socket) = self.writer.lock() else { return false };
        socket.write_all(&head).and_then(|_| socket.write_all(payload)).is_ok()
    }

    fn send_json(&self, value: Value) -> bool {
        self.send(T_JSON, value.to_string().as_bytes())
    }

    fn is_active(&self) -> bool {
        ACTIVE.lock().map(|active| active.as_deref() == Some(self.id.as_str())).unwrap_or(false)
    }

    fn wants_frames(&self) -> bool {
        self.preview.lock().map(|p| p.is_some()).unwrap_or(false) || (self.is_active() && CONSUMER.load(Ordering::Relaxed))
    }

    fn view(&self, connected: bool) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "connected": connected,
            "caps": self.caps.lock().map(|v| v.clone()).unwrap_or(Value::Null),
            "state": self.state.lock().map(|v| v.clone()).unwrap_or(Value::Null),
            "active": self.is_active(),
        })
    }
}

fn flags_of(state: &Value) -> u8 {
    u8::from(state["mirror"].as_bool().unwrap_or(false)) | (u8::from(state["rot180"].as_bool().unwrap_or(false)) << 1)
}

/// Called by the deck link when a phone authenticates over Wi-Fi.
pub fn note_phone(id: &str, name: &str, ip: IpAddr) {
    if ip.is_loopback() {
        return;
    }
    if let Ok(mut phones) = PHONES.lock() {
        phones.retain(|(known, _, _)| known != id);
        phones.push((id.to_owned(), name.to_owned(), ip));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    id: String,
    name: String,
    transport: &'static str,
    connected: bool,
}

fn usb_serials() -> Vec<(String, String)> {
    let Some(adb) = adb::find() else { return Vec::new() };
    let Ok(out) = adb::run(&adb, &["devices", "-l"], Duration::from_secs(8)) else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?;
            if parts.next()? != "device" {
                return None;
            }
            let model = parts.find_map(|p| p.strip_prefix("model:")).unwrap_or(serial).replace('_', " ");
            Some((serial.to_owned(), model))
        })
        .collect()
}

/// Every phone that could be a camera: those connected over Wi-Fi and those on a USB cable.
#[tauri::command]
pub async fn camera_sources() -> Vec<Source> {
    tauri::async_runtime::spawn_blocking(|| {
        let live: Vec<String> = SESSIONS.lock().map(|s| s.iter().map(|x| x.id.clone()).collect()).unwrap_or_default();
        let phones: Vec<(String, String)> = PHONES
            .lock()
            .map(|phones| phones.iter().map(|(id, name, _)| (format!("wifi:{id}"), name.clone())).collect())
            .unwrap_or_default();
        let mut sources: Vec<Source> = phones
            .into_iter()
            .map(|(id, name)| Source { connected: live.contains(&id), id, name, transport: "wifi" })
            .collect();
        sources.extend(usb_serials().into_iter().map(|(serial, model)| {
            let id = format!("usb:{serial}");
            Source { connected: live.contains(&id), id, name: model, transport: "usb" }
        }));
        sources
    })
    .await
    .unwrap_or_default()
}

fn resolve(id: &str) -> Result<(SocketAddr, String), String> {
    if let Some(phone) = id.strip_prefix("wifi:") {
        let phones = PHONES.lock().map_err(|_| "busy".to_owned())?;
        let (_, name, ip) = phones.iter().find(|(known, _, _)| known == phone).ok_or("That phone is not connected to Open Dock.")?;
        return Ok((SocketAddr::new(*ip, PHONE_PORT), name.clone()));
    }
    let serial = id.strip_prefix("usb:").ok_or("Unknown camera.")?;
    let adb = adb::find().ok_or(adb::MISSING)?;
    let out = adb::run(&adb, &["-s", serial, "forward", "tcp:0", &format!("tcp:{PHONE_PORT}")], Duration::from_secs(10))?;
    let port: u16 = String::from_utf8_lossy(&out.stdout).trim().parse().map_err(|_| "USB forwarding failed. Is USB debugging on?".to_owned())?;
    let name = usb_serials().into_iter().find(|(s, _)| s == serial).map(|(_, m)| m).unwrap_or_else(|| "Phone".into());
    Ok((SocketAddr::from(([127, 0, 0, 1], port)), name))
}

#[tauri::command]
pub async fn camera_connect(app: AppHandle, state: tauri::State<'_, Arc<crate::AppState>>, id: String) -> Result<(), String> {
    let token = state.token.read().map_err(|_| "busy".to_owned())?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // One attempt per phone at a time: the phone drops its older link when a second one arrives, so overlapping
        // attempts (the panel retries every few seconds) would knock each other out.
        {
            let mut trying = CONNECTING.lock().map_err(|_| "busy".to_owned())?;
            if find(&id).is_some() || trying.contains(&id) {
                return Ok(());
            }
            trying.push(id.clone());
        }
        let result = open_session(app, token, &id);
        if let Ok(mut trying) = CONNECTING.lock() {
            trying.retain(|known| known != &id);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

fn open_session(app: AppHandle, token: String, id: &str) -> Result<(), String> {
    let id = id.to_owned();
    {
        let (addr, name) = resolve(&id)?;
        let socket = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
            .map_err(|_| "The phone's camera is not running. Open the Camera tab on the phone and tap Start camera.".to_owned())?;
        let _ = socket.set_nodelay(true);
        let reader = socket.try_clone().map_err(|e| e.to_string())?;
        let session = Arc::new(Session {
            id: id.clone(),
            name,
            stop: AtomicBool::new(false),
            writer: Mutex::new(socket),
            caps: Mutex::new(Value::Null),
            state: Mutex::new(Value::Null),
            csd: Mutex::new(Vec::new()),
            preview: Mutex::new(None),
            demand: AtomicBool::new(false),
        });
        // The first message proves this PC is the paired one; the phone drops anyone else.
        session.send_json(json!({ "t": "auth", "token": token }));
        SESSIONS.lock().map_err(|_| "busy".to_owned())?.push(session.clone());
        let ticker = session.clone();
        std::thread::spawn(move || ticker_loop(ticker));
        std::thread::spawn(move || read_loop(app, session, reader));
        Ok(())
    }
}

fn find(id: &str) -> Option<Arc<Session>> {
    SESSIONS.lock().ok()?.iter().find(|s| s.id == id).cloned()
}

/// Pings the phone (it drops a silent PC) and tells it whether anyone is watching, so its camera runs only then.
fn ticker_loop(session: Arc<Session>) {
    let mut ticks = 0u32;
    while !session.stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(250));
        let want = session.wants_frames();
        if session.demand.swap(want, Ordering::Relaxed) != want {
            session.send_json(json!({ "t": "demand", "v": want }));
            if want {
                session.send_json(json!({ "t": "key" }));
            }
        }
        ticks += 1;
        if ticks % 8 == 0 && !session.send_json(json!({ "t": "ping" })) {
            break;
        }
    }
}

fn read_loop(app: AppHandle, session: Arc<Session>, mut socket: TcpStream) {
    let _ = socket.set_read_timeout(Some(Duration::from_secs(6)));
    let mut head = [0u8; 5];
    let mut packet = Vec::new();
    while !session.stop.load(Ordering::Relaxed) && socket.read_exact(&mut head).is_ok() {
        let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
        if len > 32 << 20 {
            break;
        }
        packet.resize(len, 0);
        if socket.read_exact(&mut packet).is_err() {
            break;
        }
        match head[0] {
            T_CONFIG => {
                if let Ok(mut csd) = session.csd.lock() {
                    *csd = packet.clone();
                }
                to_preview(&session, T_CONFIG, 0, &[0; 8], &packet);
                if session.is_active() {
                    to_host(T_CONFIG, &packet);
                }
            }
            T_FRAME if len > 9 => {
                to_preview(&session, T_FRAME, packet[0], &packet[1..9], &packet[9..]);
                if session.is_active() && CONSUMER.load(Ordering::Relaxed) {
                    to_host(T_FRAME, &packet);
                }
            }
            T_JSON => {
                let Ok(message) = serde_json::from_slice::<Value>(&packet) else { continue };
                match message["t"].as_str() {
                    Some("caps") => {
                        if let Ok(mut caps) = session.caps.lock() {
                            *caps = message;
                        }
                    }
                    Some("state") => {
                        if session.is_active() {
                            to_host(3, &[flags_of(&message)]);
                        }
                        if let Ok(mut state) = session.state.lock() {
                            *state = message;
                        }
                    }
                    _ => continue,
                }
                let _ = app.emit("camera-state", session.view(true));
            }
            _ => {}
        }
    }
    session.stop.store(true, Ordering::Relaxed);
    if let Ok(mut sessions) = SESSIONS.lock() {
        sessions.retain(|s| !Arc::ptr_eq(s, &session));
    }
    if let Some(serial) = session.id.strip_prefix("usb:") {
        if let Some(adb) = adb::find() {
            let _ = adb::run(&adb, &["-s", serial, "forward", "--remove-all"], Duration::from_secs(5));
        }
    }
    let _ = app.emit("camera-state", session.view(false));
}

/// Preview packet: kind (1 config, 2 frame), key flag, ptsUs (8 bytes), H.264 Annex B. The window decodes it itself.
fn to_preview(session: &Session, kind: u8, key: u8, pts: &[u8], data: &[u8]) {
    let Ok(preview) = session.preview.lock() else { return };
    if let Some(channel) = preview.as_ref() {
        let mut out = Vec::with_capacity(data.len() + 10);
        out.push(kind);
        out.push(key);
        out.extend_from_slice(pts);
        out.extend_from_slice(data);
        let _ = channel.send(InvokeResponseBody::Raw(out));
    }
}

fn to_host(kind: u8, payload: &[u8]) {
    let Ok(mut host) = HOST.lock() else { return };
    let Some(running) = host.as_mut() else { return };
    let mut head = [0u8; 5];
    head[0] = kind;
    head[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    if running.stdin.write_all(&head).and_then(|_| running.stdin.write_all(payload)).is_err() {
        *host = None;
    }
}

#[tauri::command]
pub fn camera_disconnect(id: String) {
    if let Some(session) = find(&id) {
        session.stop.store(true, Ordering::Relaxed);
        // Gone from the list at once, not when its reader notices the closed socket.
        if let Ok(mut sessions) = SESSIONS.lock() {
            sessions.retain(|s| !Arc::ptr_eq(s, &session));
        }
        if let Ok(socket) = session.writer.lock() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }
}

#[tauri::command]
pub fn camera_set(id: String, key: String, value: Value) {
    if let Some(session) = find(&id) {
        session.send_json(json!({ "t": "set", "k": key, "v": value }));
    }
}

#[tauri::command]
pub fn camera_snapshot() -> Vec<Value> {
    SESSIONS.lock().map(|sessions| sessions.iter().map(|s| s.view(true)).collect()).unwrap_or_default()
}

/// Shows this camera's feed in the window until `camera_preview_stop`.
#[tauri::command]
pub fn camera_preview(id: String, channel: Channel<InvokeResponseBody>) {
    let Some(session) = find(&id) else { return };
    if let Ok(csd) = session.csd.lock() {
        if !csd.is_empty() {
            let _ = channel.send(InvokeResponseBody::Raw([&[T_CONFIG, 0][..], &[0; 8], &csd].concat()));
        }
    }
    if let Ok(mut preview) = session.preview.lock() {
        *preview = Some(channel);
    }
    session.send_json(json!({ "t": "key" }));
}

#[tauri::command]
pub fn camera_preview_stop(id: String) {
    if let Some(session) = find(&id) {
        if let Ok(mut preview) = session.preview.lock() {
            *preview = None;
        }
    }
}

// ------------------------------------------------------------------ the virtual camera

fn host_exe(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    [dir.join("dockcam.exe"), dir.join("resources").join("dockcam.exe")].into_iter().find(|p| p.is_file())
}

fn host_command(program: &PathBuf) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn installed(exe: &PathBuf) -> bool {
    host_command(exe).arg("--check").status().is_ok_and(|status| status.success())
}

fn start_host(app: &AppHandle) -> Result<(), String> {
    if HOST.lock().map_err(|_| "busy")?.is_some() {
        return Ok(());
    }
    let exe = host_exe(app).ok_or("The virtual camera is only available on Windows 11.")?;
    if !installed(&exe) {
        return Err("The virtual camera is not installed yet. Install it first.".into());
    }
    let mut child = host_command(&exe).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    *HOST_STATE.lock().map_err(|_| "busy")? = HostState { ready: false, error: String::new(), consumer: false };
    *HOST.lock().map_err(|_| "busy")? = Some(Host { _child: child, stdin });
    let app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(mut state) = HOST_STATE.lock() {
                match line.trim() {
                    "READY" => state.ready = true,
                    "C1" => state.consumer = true,
                    "C0" => state.consumer = false,
                    other if other.starts_with("ERR") => state.error = other.to_owned(),
                    _ => {}
                }
                CONSUMER.store(state.consumer, Ordering::Relaxed);
            }
            let _ = app.emit("camera-host", host_status_value(&app));
        }
        // Helper gone: the virtual camera disappears with it.
        if let Ok(mut host) = HOST.lock() {
            *host = None;
        }
        CONSUMER.store(false, Ordering::Relaxed);
        if let Ok(mut state) = HOST_STATE.lock() {
            state.ready = false;
            state.consumer = false;
        }
        let _ = app.emit("camera-host", host_status_value(&app));
    });
    Ok(())
}

fn host_status_value(app: &AppHandle) -> Value {
    let state = HOST_STATE.lock();
    json!({
        "available": host_exe(app).is_some(),
        "running": HOST.lock().map(|h| h.is_some()).unwrap_or(false),
        "ready": state.as_ref().is_ok_and(|s| s.ready),
        "error": state.as_ref().map(|s| s.error.clone()).unwrap_or_default(),
        "consumer": state.as_ref().is_ok_and(|s| s.consumer),
        "active": ACTIVE.lock().ok().and_then(|a| a.clone()),
    })
}

#[tauri::command]
pub async fn camera_host_status(app: AppHandle) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let mut value = host_status_value(&app);
        // Checking spawns the helper; once it says yes the answer is kept.
        if !INSTALLED.load(Ordering::Relaxed) {
            INSTALLED.store(host_exe(&app).is_some_and(|exe| installed(&exe)), Ordering::Relaxed);
        }
        value["installed"] = json!(INSTALLED.load(Ordering::Relaxed));
        value
    })
    .await
    .unwrap_or(Value::Null)
}

/// Puts "Open Dock Camera" in the list of cameras (it shows black until a phone is chosen), so apps can pick it.
#[tauri::command]
pub async fn camera_host_start(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_host(&app)).await.map_err(|e| e.to_string())?
}

/// One Windows permission prompt: copies the camera DLL to Program Files and registers it.
#[tauri::command]
pub async fn camera_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = host_exe(&app).ok_or("The virtual camera is only available on Windows 11.")?;
        let script = format!("Start-Process -FilePath '{}' -ArgumentList '--install' -Verb RunAs -Wait", exe.display().to_string().replace('\'', "''"));
        let status = host_command(&PathBuf::from("powershell.exe")).args(["-NoProfile", "-Command", &script]).status().map_err(|e| e.to_string())?;
        if status.success() && installed(&exe) { Ok(()) } else { Err("The virtual camera was not installed.".into()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Picks which phone feeds the virtual camera (None turns the virtual camera off).
#[tauri::command]
pub fn camera_set_active(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let previous = ACTIVE.lock().map_err(|_| "busy")?.clone();
    if previous == id {
        return Ok(());
    }
    if let Some(wanted) = &id {
        let session = find(wanted).ok_or("Connect that camera first.")?;
        start_host(&app)?;
        *ACTIVE.lock().map_err(|_| "busy")? = id.clone();
        to_host(4, &[]);
        if let Ok(csd) = session.csd.lock() {
            if !csd.is_empty() {
                to_host(T_CONFIG, &csd);
            }
        }
        let flags = flags_of(&*session.state.lock().map_err(|_| "busy")?);
        to_host(3, &[flags]);
        session.demand.store(false, Ordering::Relaxed); // the ticker asks for a keyframe when frames are wanted
    } else {
        // The camera stays in apps' lists (black) so they don't lose it; it just has no phone behind it.
        *ACTIVE.lock().map_err(|_| "busy")? = None;
        to_host(4, &[]);
    }
    for session in SESSIONS.lock().map_err(|_| "busy")?.iter() {
        let _ = app.emit("camera-state", session.view(true));
    }
    let _ = app.emit("camera-host", host_status_value(&app));
    Ok(())
}
