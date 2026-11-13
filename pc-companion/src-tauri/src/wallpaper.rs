//! Steam's Wallpaper Engine (app 431960): the phone lists the wallpapers installed on this PC and picks one.
//!
//! Everything is read from files on this PC. The phone only ever sends a wallpaper id, which is looked up in the
//! list found here, so it can never make the PC open an arbitrary file. Wallpaper Engine is driven through its own
//! command line, started with an argument list and never through a shell.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;

const WORKSHOP_APP: &str = "431960";
const MAX_ITEMS: usize = 500;
/// Previews larger than this are not sent: the phone shows a plain tile instead.
const MAX_PREVIEW_BYTES: u64 = 300_000;
/// Shrunk previews are at most this wide.
const THUMB_WIDTH: u32 = 400;
/// A phone background is at most this wide: sharp on a phone, still small to send.
const BACKDROP_WIDTH: u32 = 1600;
const CACHE_FOR: Duration = Duration::from_secs(60);

struct Entry {
    id: String,
    title: String,
    kind: String,
    project: PathBuf,
    preview: Option<PathBuf>,
}

struct Library {
    /// Wallpaper Engine's command-line program; none when it isn't installed.
    exe: Option<PathBuf>,
    entries: Vec<Entry>,
}

static CACHE: Mutex<Option<(Instant, Arc<Library>)>> = Mutex::new(None);

/// Whether this PC can run Wallpaper Engine at all.
pub(super) const SUPPORTED: bool = cfg!(windows);

#[cfg(windows)]
fn steam_root() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|line| line.contains("SteamPath"))?;
    let value = line.split("REG_SZ").nth(1)?.trim();
    let path = PathBuf::from(value);
    path.is_dir().then_some(path).or_else(|| Some(PathBuf::from(r"C:\Program Files (x86)\Steam")).filter(|path| path.is_dir()))
}

#[cfg(not(windows))]
fn steam_root() -> Option<PathBuf> {
    None
}

/// Steam's own folder plus every extra library it lists in `libraryfolders.vdf`.
fn libraries(root: &Path) -> Vec<PathBuf> {
    let mut found = vec![root.to_path_buf()];
    if let Ok(text) = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for line in text.lines() {
            let line = line.trim();
            if !line.starts_with("\"path\"") {
                continue;
            }
            // "path"		"D:\\SteamLibrary"
            if let Some(value) = line.rsplit('"').nth(1) {
                let path = PathBuf::from(value.replace("\\\\", "\\"));
                if path.is_dir() && !found.contains(&path) {
                    found.push(path);
                }
            }
        }
    }
    found
}

fn plain_file_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\', ':']) && name != ".."
}

fn read_projects(dir: &Path, prefix: &str, out: &mut Vec<Entry>) {
    let Ok(folders) = std::fs::read_dir(dir) else { return };
    for folder in folders.flatten() {
        if out.len() >= MAX_ITEMS {
            return;
        }
        let folder = folder.path();
        let Some(name) = folder.file_name().and_then(|name| name.to_str()).map(str::to_owned) else { continue };
        let project = folder.join("project.json");
        let Ok(text) = std::fs::read_to_string(&project) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) else { continue };
        let title = json["title"].as_str().map(str::trim).filter(|title| !title.is_empty()).unwrap_or(&name);
        let kind = json["type"].as_str().unwrap_or("scene").to_lowercase();
        let named = json["preview"].as_str().filter(|file| plain_file_name(file)).map(|file| folder.join(file));
        let preview = named
            .into_iter()
            .chain(["preview.jpg", "preview.png", "preview.gif"].iter().map(|file| folder.join(file)))
            .find(|path| path.is_file());
        out.push(Entry {
            id: format!("{prefix}{name}"),
            title: title.chars().take(80).collect(),
            kind: kind.chars().take(16).collect(),
            project,
            preview,
        });
    }
}

fn scan() -> Library {
    let mut library = Library { exe: None, entries: Vec::new() };
    let Some(root) = steam_root() else { return library };
    for steam in libraries(&root) {
        let install = steam.join("steamapps").join("common").join("wallpaper_engine");
        if library.exe.is_none() {
            library.exe = ["wallpaper64.exe", "wallpaper32.exe"].iter().map(|file| install.join(file)).find(|path| path.is_file());
        }
        read_projects(&steam.join("steamapps").join("workshop").join("content").join(WORKSHOP_APP), "ws-", &mut library.entries);
        read_projects(&install.join("projects").join("myprojects"), "my-", &mut library.entries);
    }
    library.entries.sort_by_key(|entry| entry.title.to_lowercase());
    library
}

/// The wallpapers on this PC, scanned at most once a minute unless `force`.
fn library(force: bool) -> Arc<Library> {
    let mut cache = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, found)) = cache.as_ref() {
        if !force && at.elapsed() < CACHE_FOR {
            return found.clone();
        }
    }
    let found = Arc::new(scan());
    *cache = Some((Instant::now(), found.clone()));
    found
}

/// The `wallpaper` message for the phone: every wallpaper's id, title and kind (previews come one at a time).
pub(super) fn list_message(force: bool) -> serde_json::Value {
    let found = library(force);
    let items: Vec<_> = found
        .entries
        .iter()
        .map(|entry| serde_json::json!({ "id": entry.id, "title": entry.title, "kind": entry.kind, "preview": entry.preview.is_some() }))
        .collect();
    serde_json::json!({ "type": "wallpaper", "supported": SUPPORTED, "installed": found.exe.is_some(), "items": items, "displays": displays(), "current": current(&found), "color": current(&found).and_then(|id| color(&found, &id)) })
}

/// `{ id, color }` of the main display's wallpaper; nulls when unknown.
pub(super) fn current_message() -> serde_json::Value {
    let found = library(false);
    let id = current(&found);
    let color = id.as_ref().and_then(|id| color(&found, id));
    serde_json::json!({ "id": id, "color": color })
}

/// A wallpaper's main colour as #rrggbb, made bright and strong enough to be an accent.
fn color(found: &Library, id: &str) -> Option<String> {
    let [r, g, b] = accent_of(&tiny_pixels(&picture(found, id)?.0)?)?;
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

/// The colour that stands out in BGR pixels: an average weighted to vivid pixels, so a red wallpaper with a dark
/// figure gives red, then set to a mid lightness and at least half saturation so it reads on light and dark.
fn accent_of(bgr: &[u8]) -> Option<[u8; 3]> {
    let (mut sum, mut total) = ([0f64; 3], 0f64);
    for pixel in bgr.chunks_exact(3) {
        let [b, g, r] = [pixel[0], pixel[1], pixel[2]].map(f64::from);
        let (max, min) = (r.max(g).max(b), r.min(g).min(b));
        let weight = (max - min) / 255.0 * (max / 255.0) + 0.01;
        sum = [sum[0] + r * weight, sum[1] + g * weight, sum[2] + b * weight];
        total += weight;
    }
    if total == 0.0 {
        return None;
    }
    let [r, g, b] = sum.map(|value| value / total / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let hue = if max == min { 0.0 } else if max == r { ((g - b) / (max - min)).rem_euclid(6.0) } else if max == g { (b - r) / (max - min) + 2.0 } else { (r - g) / (max - min) + 4.0 } * 60.0;
    let light = (max + min) / 2.0;
    let saturation = if max == min { 0.0 } else { (max - min) / (1.0 - (2.0 * light - 1.0).abs()) };
    // Grey wallpapers stay grey; colourful ones get a usable accent.
    let (saturation, light) = if saturation < 0.12 { (saturation, 0.55) } else { (saturation.max(0.55), light.clamp(0.48, 0.6)) };
    let chroma = (1.0 - (2.0 * light - 1.0).abs()) * saturation;
    let x = chroma * (1.0 - ((hue / 60.0).rem_euclid(2.0) - 1.0).abs());
    let (r, g, b) = match (hue / 60.0) as u32 { 0 => (chroma, x, 0.0), 1 => (x, chroma, 0.0), 2 => (0.0, chroma, x), 3 => (0.0, x, chroma), 4 => (x, 0.0, chroma), _ => (chroma, 0.0, x) };
    let m = light - chroma / 2.0;
    Some([r, g, b].map(|value| ((value + m) * 255.0).round().clamp(0.0, 255.0) as u8))
}

/// Wallpaper Engine's full-size snapshot of the main display's wallpaper (it keeps one for the lock screen), when it
/// is at least as new as the last wallpaper change. Previews are often tiny (128 px), this is the real picture.
fn snapshot(found: &Library) -> Option<PathBuf> {
    let config = std::fs::metadata(found.exe.as_ref()?.parent()?.join("config.json")).ok()?.modified().ok()?;
    let path = PathBuf::from(std::env::var_os("APPDATA")?).join(r"Microsoft\Windows\Themes\WallpaperEngineLockOverride.jpg");
    let taken = std::fs::metadata(&path).ok()?.modified().ok()?;
    // Written a moment after config.json; a snapshot from well before the change shows the old wallpaper.
    (taken + Duration::from_secs(10) >= config).then_some(path)
}

/// The best picture of a wallpaper: the snapshot when it is the one showing, else its preview. True when sharp.
fn picture(found: &Library, id: &str) -> Option<(PathBuf, bool)> {
    if current(found).as_deref() == Some(id) {
        if let Some(path) = snapshot(found) {
            return Some((path, true));
        }
    }
    Some((found.entries.iter().find(|entry| entry.id == id)?.preview.clone()?, false))
}

/// The wallpaper on the main display, from Wallpaper Engine's own config.json (one block per Windows user).
fn current(found: &Library) -> Option<String> {
    let config = found.exe.as_ref()?.parent()?.join("config.json");
    let json: serde_json::Value = serde_json::from_str(std::fs::read_to_string(config).ok()?.trim_start_matches('\u{feff}')).ok()?;
    let user = std::env::var("USERNAME").ok()?;
    let block = json.get(&user).or_else(|| json.as_object()?.iter().find(|(name, _)| name.eq_ignore_ascii_case(&user)).map(|(_, value)| value))?;
    let file = block["general"]["wallpaperconfig"]["selectedwallpapers"]["Monitor0"]["file"].as_str()?;
    current_id(found, file)
}

/// Which wallpaper a file belongs to: the one whose project folder holds it.
fn current_id(found: &Library, file: &str) -> Option<String> {
    let same = |path: &Path| path.to_string_lossy().replace('\\', "/").to_lowercase();
    let folder = same(Path::new(file).parent()?);
    found.entries.iter().find(|entry| entry.project.parent().is_some_and(|parent| same(parent) == folder)).map(|entry| entry.id.clone())
}

/// A wallpaper's picture as a larger JPEG data URL for the phone's background, and whether it is sharp (the
/// snapshot) or only the preview, which the phone swaps out once the snapshot is ready.
pub(super) fn backdrop(id: &str) -> Option<(String, bool)> {
    let found = library(false);
    let (path, sharp) = picture(&found, id)?;
    let jpeg = small_jpeg(&path, BACKDROP_WIDTH)?;
    Some((format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)), sharp))
}

/// One wallpaper's preview as a data URL: shrunk to a small JPEG (a full-size GIF can run the phone out of memory),
/// or the file itself when it can't be shrunk and is small enough to send.
pub(super) fn thumb(id: &str) -> Option<String> {
    let found = library(false);
    let path = found.entries.iter().find(|entry| entry.id == id)?.preview.as_ref()?;
    if let Some(jpeg) = small_jpeg(path, THUMB_WIDTH) {
        return Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)));
    }
    if std::fs::metadata(path).ok()?.len() > MAX_PREVIEW_BYTES {
        return None;
    }
    let mime = match path.extension()?.to_str()?.to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).ok()?)))
}

/// Makes Wallpaper Engine show this wallpaper on the desktop.
pub(super) fn apply(id: &str, monitor: Option<u8>) -> Result<(), String> {
    if monitor.is_some_and(|index| usize::from(index) >= displays().len().max(1)) {
        return Err("That display is no longer connected".into());
    }
    let found = library(false);
    let exe = found.exe.as_ref().ok_or("Wallpaper Engine is not installed on this PC")?;
    let entry = found.entries.iter().find(|entry| entry.id == id).ok_or("That wallpaper is no longer on this PC")?;
    // One call can miss some displays, so "all displays" asks for each display in turn.
    let targets: Vec<Option<u8>> = match monitor {
        Some(index) => vec![Some(index)],
        None => match displays().len() {
            0 | 1 => vec![None],
            count => (0..count.min(16) as u8).map(Some).collect(),
        },
    };
    for target in targets {
        let mut command = std::process::Command::new(exe);
        command.args(["-control", "openWallpaper", "-file"]).arg(&entry.project);
        if let Some(index) = target {
            command.args(["-monitor", &index.to_string()]);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        match command.status() {
            Ok(status) if status.success() => {}
            Ok(_) => return Err("Wallpaper Engine did not accept it. Is it running?".into()),
            Err(_) => return Err("Could not start Wallpaper Engine".into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_plain() {
        assert!(plain_file_name("preview.gif"));
        assert!(!plain_file_name(r"..\secret.png"));
        assert!(!plain_file_name("C:/x.png"));
        assert!(!plain_file_name(".."));
    }

    #[cfg(windows)]
    #[test]
    fn this_pc_has_a_display() {
        let found = displays();
        assert!(!found.is_empty());
        assert!(found.iter().any(|display| display["primary"] == true));
    }

    #[cfg(windows)]
    #[test]
    fn current_wallpaper_is_found_by_its_folder() {
        let entry = Entry { id: "ws-42".into(), title: "A".into(), kind: "scene".into(), project: PathBuf::from(r"F:\Steam\steamapps\workshop\content\431960\42\project.json"), preview: None };
        let found = Library { exe: None, entries: vec![entry] };
        assert_eq!(current_id(&found, "F:/steam/steamapps/workshop/content/431960/42/scene.pkg").as_deref(), Some("ws-42"));
        assert_eq!(current_id(&found, "F:/steam/steamapps/workshop/content/431960/7/scene.pkg"), None);
    }

    #[test]
    fn accent_follows_the_vivid_colour() {
        // Mostly black with a red-orange area: the accent is red-orange, not a muddy dark.
        let mut bgr = Vec::new();
        for index in 0..100 {
            bgr.extend_from_slice(if index < 40 { &[20, 60, 240] } else { &[10, 10, 10] });
        }
        let [r, g, b] = accent_of(&bgr).unwrap();
        assert!(r > 200 && g < 120 && b < 60, "{r} {g} {b}");
        // A grey picture stays grey.
        let [r, g, b] = accent_of(&[128u8; 300]).unwrap();
        assert!(r.abs_diff(g) < 4 && g.abs_diff(b) < 4);
    }

    #[test]
    fn previews_are_shrunk_to_small_jpegs() {
        // Uses this PC's own wallpapers; nothing to check on a PC without any.
        let found = library(false);
        for entry in found.entries.iter().filter(|entry| entry.preview.is_some()).take(5) {
            let data = thumb(&entry.id).expect("a preview");
            assert!(data.starts_with("data:image/jpeg;base64,"), "{}", entry.title);
            assert!(data.len() < 200_000, "{} is {} bytes", entry.title, data.len());
        }
    }

    #[test]
    fn unknown_id_is_refused() {
        assert!(apply("../../evil", None).is_err());
        assert!(thumb("../../evil").is_none());
    }
}

/// The displays this PC has, in Wallpaper Engine's `-monitor` order: the main display first.
#[cfg(windows)]
fn displays() -> Vec<serde_json::Value> {
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
    use windows::core::BOOL;

    unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, found: LPARAM) -> BOOL {
        let list = unsafe { &mut *(found.0 as *mut Vec<serde_json::Value>) };
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            let (width, height) = (info.rcMonitor.right - info.rcMonitor.left, info.rcMonitor.bottom - info.rcMonitor.top);
            let primary = info.dwFlags & 1 != 0;
            let index = list.len();
            let label = format!("Display {}{} · {width}×{height}", index + 1, if primary { " (main)" } else { "" });
            list.push(serde_json::json!({ "index": index, "label": label, "primary": primary }));
        }
        BOOL(1)
    }

    let mut list: Vec<serde_json::Value> = Vec::new();
    // The callback only runs during this call, so the list outlives it.
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut list as *mut _ as isize));
    }
    // Wallpaper Engine numbers the main display 0, then the rest in Windows' order.
    list.sort_by_key(|display| display["primary"] != true);
    for (index, display) in list.iter_mut().enumerate() {
        let size = display["label"].as_str().and_then(|label| label.split(" · ").nth(1)).unwrap_or("").to_owned();
        display["index"] = index.into();
        display["label"] = format!("Display {}{} · {size}", index + 1, if display["primary"] == true { " (main)" } else { "" }).into();
    }
    list
}

#[cfg(not(windows))]
fn displays() -> Vec<serde_json::Value> {
    Vec::new()
}

/// The picture's first frame shrunk to 24×24, as BGR bytes.
#[cfg(windows)]
fn tiny_pixels(path: &Path) -> Option<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    const SIDE: u32 = 24;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let initialized_here = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result = (|| -> windows::core::Result<Vec<u8>> {
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let decoder = factory.CreateDecoderFromFilename(PCWSTR(wide.as_ptr()), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)?;
            let frame = decoder.GetFrame(0)?;
            let scaler = factory.CreateBitmapScaler()?;
            scaler.Initialize(&frame, SIDE, SIDE, WICBitmapInterpolationModeFant)?;
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(&scaler, &GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)?;
            let mut bytes = vec![0u8; (SIDE * SIDE * 3) as usize];
            converter.CopyPixels(std::ptr::null(), SIDE * 3, &mut bytes)?;
            Ok(bytes)
        })();
        if initialized_here {
            CoUninitialize();
        }
        result.ok()
    }
}

#[cfg(not(windows))]
fn tiny_pixels(_: &Path) -> Option<Vec<u8>> {
    None
}

/// The picture's first frame, scaled down to `max_width` and saved as JPEG, using Windows' own image codecs.
#[cfg(windows)]
fn small_jpeg(path: &Path, max_width: u32) -> Option<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let initialized_here = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result = (|| -> windows::core::Result<Vec<u8>> {
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let decoder = factory.CreateDecoderFromFilename(PCWSTR(wide.as_ptr()), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)?;
            let frame = decoder.GetFrame(0)?;
            let (mut width, mut height) = (0u32, 0u32);
            frame.GetSize(&mut width, &mut height)?;
            let scale = (f64::from(max_width) / f64::from(width.max(1))).min(1.0);
            let (to_width, to_height) = (((f64::from(width) * scale) as u32).max(1), ((f64::from(height) * scale) as u32).max(1));
            let scaler = factory.CreateBitmapScaler()?;
            scaler.Initialize(&frame, to_width, to_height, WICBitmapInterpolationModeFant)?;
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(&scaler, &GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)?;
            let stream = SHCreateMemStream(None).ok_or_else(windows::core::Error::empty)?;
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
            encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
            let mut out_frame = None;
            let mut options = None;
            encoder.CreateNewFrame(&mut out_frame, &mut options)?;
            let out_frame = out_frame.ok_or_else(windows::core::Error::empty)?;
            out_frame.Initialize(options.as_ref())?;
            out_frame.SetSize(to_width, to_height)?;
            let mut format = GUID_WICPixelFormat24bppBGR;
            out_frame.SetPixelFormat(&mut format)?;
            out_frame.WriteSource(&converter, std::ptr::null())?;
            out_frame.Commit()?;
            encoder.Commit()?;
            stream.Seek(0, STREAM_SEEK_SET, None)?;
            let mut stat = STATSTG::default();
            stream.Stat(&mut stat, STATFLAG_NONAME)?;
            let mut bytes = vec![0u8; stat.cbSize as usize];
            let mut read = 0u32;
            stream.Read(bytes.as_mut_ptr().cast(), bytes.len() as u32, Some(&mut read)).ok()?;
            bytes.truncate(read as usize);
            Ok(bytes)
        })();
        if initialized_here {
            CoUninitialize();
        }
        result.ok().filter(|bytes| !bytes.is_empty())
    }
}

#[cfg(not(windows))]
fn small_jpeg(_: &Path, _: u32) -> Option<Vec<u8>> {
    None
}
