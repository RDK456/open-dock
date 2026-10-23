//! Finds Android Debug Bridge (adb), which the Android USB option needs, and downloads Google's copy when the PC has none.
//!
//! An adb the user already has (PATH, Android Studio, Homebrew) is used first, so a running adb server is never
//! restarted by a different version. Only when none works does the app offer to download Google's platform-tools
//! (a pinned release, checked against its SHA-256) into its own settings folder: no installer, no PATH change.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;

/// Error text the front end recognises: no adb on this PC, offer the download.
pub const MISSING: &str = "ADB_MISSING";

const VERSION: &str = "37.0.1";

struct Pin {
    os: &'static str,
    size: u64,
    sha256: &'static str,
    exe: &'static str,
    /// The only files unpacked from the zip.
    files: &'static [&'static str],
}

// SHA-256 and sizes of Google's platform-tools_r37.0.1 zips (sizes and SHA-1 match Google's repository2-3.xml).
#[cfg(target_os = "windows")]
const PIN: Pin = Pin {
    os: "win",
    size: 8_044_989,
    sha256: "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99",
    exe: "adb.exe",
    files: &["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "libwinpthread-1.dll", "NOTICE.txt"],
};
#[cfg(target_os = "macos")]
const PIN: Pin = Pin {
    os: "darwin",
    size: 16_110_554,
    sha256: "ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d",
    exe: "adb",
    files: &["adb", "NOTICE.txt"],
};
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const PIN: Pin = Pin {
    os: "linux",
    size: 9_054_187,
    sha256: "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1",
    exe: "adb",
    files: &["adb", "NOTICE.txt"],
};

static MANAGED_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static RESOLVED: Mutex<Option<PathBuf>> = Mutex::new(None);
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Where a downloaded copy lives: `<settings folder>/platform-tools`.
pub fn init(config_dir: &Path) {
    *MANAGED_DIR.lock().unwrap() = Some(config_dir.join("platform-tools"));
}

fn managed_dir() -> Option<PathBuf> {
    MANAGED_DIR.lock().unwrap().clone()
}

fn managed_exe() -> Option<PathBuf> {
    managed_dir().map(|dir| dir.join(PIN.exe))
}

fn command(program: &Path) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        // Without this a console window flashes each time the app (a GUI program) starts adb.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Runs adb with a deadline, so a stuck adb server can never hang the app.
pub fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut child = command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("adb could not start: {error}"))?;
    fn drain(stream: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut stream) = stream {
                let _ = stream.read_to_end(&mut bytes);
            }
            let _ = sender.send(bytes);
        });
        receiver
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("adb did not answer in time".into());
            }
            Err(error) => return Err(format!("adb failed: {error}")),
        }
    };
    // A freshly started adb server may keep the pipes open; the output is complete once the client exits.
    Ok(Output {
        status,
        stdout: out.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
        stderr: err.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
    })
}

fn works(program: &Path) -> bool {
    run(program, &["version"], Duration::from_secs(10))
        .is_ok_and(|output| output.status.success() && String::from_utf8_lossy(&output.stdout).contains("Android Debug Bridge"))
}

/// Places where an adb is usually found when it is not on PATH (the app may have started before PATH changed).
fn known_places() -> Vec<PathBuf> {
    let mut places: Vec<PathBuf> = Vec::new();
    let exe = PIN.exe;
    for variable in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(root) = std::env::var_os(variable) {
            places.push(PathBuf::from(root).join("platform-tools").join(exe));
        }
    }
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            places.push(local.join("Android").join("Sdk").join("platform-tools").join(exe));
            // WinGet (Google.PlatformTools) installs per user and adds its folder to the user PATH.
            let packages = local.join("Microsoft").join("WinGet").join("Packages");
            if let Ok(entries) = fs::read_dir(packages) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with("Google.PlatformTools") {
                        places.push(entry.path().join("platform-tools").join(exe));
                    }
                }
            }
            places.push(local.join("Microsoft").join("WinGet").join("Links").join(exe));
        }
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(variable) {
                places.push(PathBuf::from(root).join("Android").join("platform-tools").join(exe));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = &home {
            places.push(home.join("Library/Android/sdk/platform-tools").join(exe));
        }
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] {
            places.push(PathBuf::from(dir).join(exe));
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if let Some(home) = &home {
            places.push(home.join("Android/Sdk/platform-tools").join(exe));
        }
        for dir in ["/usr/bin", "/usr/local/bin"] {
            places.push(PathBuf::from(dir).join(exe));
        }
    }
    places
}

fn resolve() -> Option<PathBuf> {
    let on_path = PathBuf::from(PIN.exe);
    if works(&on_path) {
        return Some(on_path);
    }
    for place in known_places().into_iter().chain(managed_exe()) {
        if place.is_file() && works(&place) {
            return Some(place);
        }
    }
    None
}

/// An adb that runs, or None. The answer is remembered until that adb stops working.
pub fn find() -> Option<PathBuf> {
    let cached = RESOLVED.lock().unwrap().clone();
    if let Some(path) = cached {
        // A bare "adb" is looked up on PATH at run time; a full path must still exist.
        if path.components().count() == 1 || path.is_file() {
            return Some(path);
        }
    }
    let found = resolve();
    *RESOLVED.lock().unwrap() = found.clone();
    found
}

/// Forgets the remembered adb, so the next use looks again (after adb failed or after an install).
pub fn forget() {
    *RESOLVED.lock().unwrap() = None;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    available: bool,
    installing: bool,
    download_mb: u64,
}

pub fn status() -> Status {
    Status { available: find().is_some(), installing: INSTALLING.load(Ordering::Relaxed), download_mb: PIN.size.div_ceil(1_000_000) }
}

#[derive(Clone, Serialize)]
struct Progress {
    stage: &'static str,
    received: u64,
    total: u64,
}

struct InstallGuard;
impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The download timed out. Check the internet connection and try again.".into()
    } else if error.is_connect() {
        "Could not reach dl.google.com. Check the internet connection (or proxy or firewall) and try again.".into()
    } else {
        format!("The download failed: {error}")
    }
}

/// Downloads Google's platform-tools, checks them, unpacks adb and returns its path. One install runs at a time.
pub async fn install(app: tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(existing) = find() {
        return Ok(existing);
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("The USB tools are already being downloaded".into());
    }
    let _guard = InstallGuard;
    let dir = managed_dir().ok_or("Open Dock settings are unavailable")?;
    install_into(&dir, |stage, received| {
        let _ = app.emit("adb-progress", Progress { stage, received, total: PIN.size });
    })
    .await?;
    forget();
    find().ok_or_else(|| "adb was installed but does not run".to_owned())
}

async fn install_into(dir: &Path, emit: impl Fn(&'static str, u64)) -> Result<(), String> {
    let parent = dir.parent().ok_or("Open Dock settings are unavailable")?.to_path_buf();
    let part = parent.join("platform-tools.zip.part");
    let staging = parent.join("platform-tools.new");
    let old = parent.join("platform-tools.old");
    // Leftovers of an install that was interrupted.
    let _ = fs::remove_file(&part);
    let _ = fs::remove_dir_all(&staging);

    let result = async {
        emit("download", 0);
        let url = format!("https://dl.google.com/android/repository/platform-tools_r{VERSION}-{}.zip", PIN.os);
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .user_agent("Open Dock")
            .build()
            .map_err(network_error)?;
        let mut response = client.get(url).send().await.map_err(network_error)?;
        if !response.status().is_success() {
            return Err(format!("Google's download server answered {}. Try again later.", response.status()));
        }
        let mut file = fs::File::create(&part).map_err(|error| format!("Could not save the download: {error}"))?;
        let mut hasher = Sha256::new();
        let mut received = 0_u64;
        let mut reported = 0_u64;
        // A stalled connection fails after 30 s without data instead of hanging forever.
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), response.chunk())
            .await
            .map_err(|_| "The download stalled. Check the internet connection and try again.".to_owned())?
            .map_err(network_error)?
        {
            received += chunk.len() as u64;
            if received > PIN.size {
                return Err("The download was larger than expected and was stopped.".into());
            }
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|error| format!("Could not save the download (is the disk full?): {error}"))?;
            if received - reported >= 200_000 {
                reported = received;
                emit("download", received);
            }
        }
        file.flush().map_err(|error| format!("Could not save the download: {error}"))?;
        drop(file);
        emit("verify", received);
        let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        if received != PIN.size || digest != PIN.sha256 {
            return Err("The download was incomplete or damaged and was discarded. Try again.".into());
        }
        emit("unpack", received);
        let (zip_path, staging_dir) = (part.clone(), staging.clone());
        tokio::task::spawn_blocking(move || unpack(&zip_path, &staging_dir))
            .await
            .map_err(|_| "Unpacking the download failed".to_owned())??;
        if !works(&staging.join(PIN.exe)) {
            return Err("Open Dock could not start the downloaded adb. Security software may have blocked it; allow it or install Android Platform-Tools yourself.".into());
        }
        swap_in(dir, &staging, &old)
    }
    .await;
    let _ = fs::remove_file(&part);
    let _ = fs::remove_dir_all(&staging);
    result
}

/// Unpacks only the files adb needs, flattened into `staging`, and refuses paths that escape it.
fn unpack(zip_path: &Path, staging: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|error| format!("Could not read the download: {error}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "The download is not a valid archive".to_owned())?;
    fs::create_dir_all(staging).map_err(|error| format!("Could not create a folder for adb: {error}"))?;
    let mut found = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| "The download is not a valid archive".to_owned())?;
        if entry.is_dir() || entry.enclosed_name().is_none() {
            continue;
        }
        let Some(name) = entry.enclosed_name().and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned())) else { continue };
        if !PIN.files.contains(&name.as_str()) {
            continue;
        }
        let target = staging.join(&name);
        let mut output = fs::File::create(&target).map_err(|error| format!("Could not write {name}: {error}"))?;
        std::io::copy(&mut entry, &mut output).map_err(|error| format!("Could not write {name} (is the disk full?): {error}"))?;
        drop(output);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
        }
        if name != "NOTICE.txt" {
            found += 1;
        }
    }
    if found != PIN.files.len() - 1 {
        return Err("The download is missing files adb needs".into());
    }
    Ok(())
}

/// Replaces the managed folder with the new one. The old copy is stopped first: Windows will not move a running adb.
fn swap_in(dir: &Path, staging: &Path, old: &Path) -> Result<(), String> {
    if dir.exists() {
        let exe = dir.join(PIN.exe);
        if exe.is_file() {
            let _ = run(&exe, &["kill-server"], Duration::from_secs(5));
        }
        let _ = fs::remove_dir_all(old);
        fs::rename(dir, old).map_err(|_| "adb is in use. Close programs that use adb (or restart Open Dock) and try again.".to_owned())?;
    }
    if let Err(error) = fs::rename(staging, dir) {
        let _ = fs::rename(old, dir);
        return Err(format!("Could not install adb: {error}"));
    }
    let _ = fs::remove_dir_all(old);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_with(names: &[&str]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("open-dock-adb-test-{}-{}.zip", std::process::id(), names.len()));
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for name in names {
            writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(b"x").unwrap();
        }
        writer.finish().unwrap();
        path
    }

    #[test]
    fn unpack_keeps_only_adb_files_and_ignores_paths_that_escape() {
        let mut names: Vec<String> = PIN.files.iter().map(|file| format!("platform-tools/{file}")).collect();
        names.push("platform-tools/fastboot".into());
        names.push("../escape/adb".into());
        let zip = zip_with(&names.iter().map(String::as_str).collect::<Vec<_>>());
        let staging = std::env::temp_dir().join(format!("open-dock-adb-staging-{}", std::process::id()));
        let _ = fs::remove_dir_all(&staging);
        unpack(&zip, &staging).unwrap();
        let mut got: Vec<String> = fs::read_dir(&staging).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        got.sort();
        let mut want: Vec<String> = PIN.files.iter().map(|file| file.to_string()).collect();
        want.sort();
        assert_eq!(got, want);
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(&zip);
    }

    #[test]
    fn unpack_rejects_an_archive_without_adb() {
        let zip = zip_with(&["platform-tools/NOTICE.txt"]);
        let staging = std::env::temp_dir().join(format!("open-dock-adb-staging2-{}", std::process::id()));
        assert!(unpack(&zip, &staging).is_err());
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(&zip);
    }

    // Downloads Google's real zip: cargo test --lib adb::tests::downloads -- --ignored
    #[tokio::test]
    #[ignore]
    async fn downloads_checks_and_runs_adb() {
        let root = std::env::temp_dir().join(format!("open-dock-adb-e2e-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let dir = root.join("platform-tools");
        let stages = std::sync::Mutex::new(Vec::new());
        install_into(&dir, |stage, _| stages.lock().unwrap().push(stage)).await.unwrap();
        assert!(works(&dir.join(PIN.exe)));
        let stages = stages.into_inner().unwrap();
        assert!(stages.contains(&"download") && stages.contains(&"verify") && stages.contains(&"unpack"));
        // Installing over an existing copy works too (an update, or a repair).
        install_into(&dir, |_, _| {}).await.unwrap();
        assert!(works(&dir.join(PIN.exe)));
        assert!(!root.join("platform-tools.new").exists() && !root.join("platform-tools.zip.part").exists());
        let _ = fs::remove_dir_all(&root);
    }

    // Needs an adb installed outside PATH (e.g. WinGet or the Android SDK): cargo test --lib adb::tests::finds -- --ignored
    #[test]
    #[ignore]
    fn finds_adb_when_path_does_not_have_it() {
        std::env::set_var("PATH", "");
        forget();
        let found = find().expect("no adb in the usual places");
        assert!(found.is_file(), "{found:?}");
        assert!(works(&found));
    }

    #[test]
    fn swap_replaces_an_existing_install() {
        let root = std::env::temp_dir().join(format!("open-dock-adb-swap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (dir, staging, old) = (root.join("platform-tools"), root.join("platform-tools.new"), root.join("platform-tools.old"));
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(dir.join("marker"), "old").unwrap();
        fs::write(staging.join("marker"), "new").unwrap();
        swap_in(&dir, &staging, &old).unwrap();
        assert_eq!(fs::read_to_string(dir.join("marker")).unwrap(), "new");
        assert!(!old.exists() && !staging.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
