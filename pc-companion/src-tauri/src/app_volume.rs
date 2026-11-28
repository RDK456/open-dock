//! Sound controls for the dials and keys: per-app volume (the Windows volume mixer), the microphone,
//! and which speakers play. Apps are named by their program file without ".exe", lower case
//! ("spotify", "chrome"), and every audio session of that program moves together.
#[cfg(windows)]
mod imp {
    use windows::core::{Interface, GUID, HRESULT, IUnknown, PCWSTR, PWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, eMultimedia, eRender, ERole, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    pub fn path(pid: u32) -> Option<String> {
        // SAFETY: the handle is closed below; the buffer outlives the call and its length is passed with it.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buffer = [0u16; 1024];
            let mut len = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(process);
            ok.then(|| String::from_utf16_lossy(&buffer[..len as usize]))
        }
    }

    pub fn name_of(path: &str) -> Option<String> {
        std::path::Path::new(path).file_stem().map(|stem| stem.to_string_lossy().to_lowercase())
    }

    /// One app's audio session: its name, program file and volume.
    pub struct Session {
        pub name: String,
        pub path: String,
        pub volume: ISimpleAudioVolume,
    }

    /// Every app with an audio session on the default speakers.
    pub fn sessions() -> Vec<Session> {
        // SAFETY: plain COM calls on interfaces this function owns.
        unsafe {
            let result = (|| -> windows::core::Result<Vec<Session>> {
                let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let manager: IAudioSessionManager2 = devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)?;
                let list = manager.GetSessionEnumerator()?;
                let mut out = Vec::new();
                for index in 0..list.GetCount()? {
                    let control = list.GetSession(index)?;
                    let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
                    let Ok(pid) = control2.GetProcessId() else { continue };
                    let Some(path) = path(pid) else { continue };
                    let (Some(name), Ok(volume)) = (name_of(&path), control.cast::<ISimpleAudioVolume>()) else { continue };
                    out.push(Session { name, path, volume });
                }
                Ok(out)
            })();
            result.unwrap_or_default()
        }
    }

    /// The program file of the window you're using now.
    pub fn focused() -> Option<String> {
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
        let mut pid = 0;
        // SAFETY: reads the foreground window's process id into a local.
        unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid)) };
        (pid != 0).then(|| path(pid)).flatten()
    }

    /// The default microphone's volume control.
    pub fn mic() -> Option<IAudioEndpointVolume> {
        // SAFETY: plain COM calls.
        unsafe {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            devices.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?.Activate(CLSCTX_ALL, None).ok()
        }
    }

    /// Speakers and headphones that are plugged in: (device id, name), and the default one's id.
    pub fn outputs() -> Option<(Vec<(String, String)>, String)> {
        // SAFETY: plain COM calls; the id strings are copied before their memory is freed.
        unsafe {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let id = |device: &windows::Win32::Media::Audio::IMMDevice| -> Option<String> {
                let raw = device.GetId().ok()?;
                let text = raw.to_string().ok();
                windows::Win32::System::Com::CoTaskMemFree(Some(raw.0 as _));
                text
            };
            let default = id(&devices.GetDefaultAudioEndpoint(eRender, eConsole).ok()?)?;
            let list = devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).ok()?;
            let mut out = Vec::new();
            for index in 0..list.GetCount().ok()? {
                let Ok(device) = list.Item(index) else { continue };
                let Some(device_id) = id(&device) else { continue };
                let name = device.OpenPropertyStore(STGM_READ).ok()
                    .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName).ok())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "Speakers".into());
                out.push((device_id, name));
            }
            Some((out, default))
        }
    }

    /// Makes a device the default for every role. Windows has no public call for this; this is the
    /// IPolicyConfig interface the Sound settings use (stable since Windows 7, used by many mixer tools).
    pub fn set_default_output(id: &str) -> bool {
        const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
        const IID_POLICY_CONFIG: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
        type SetDefaultEndpoint = unsafe extern "system" fn(*mut std::ffi::c_void, PCWSTR, ERole) -> HRESULT;
        let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
        // SAFETY: the object is created, queried and released here; SetDefaultEndpoint is the 11th method
        // after IUnknown's three in IPolicyConfig's vtable.
        unsafe {
            let Ok(unknown) = CoCreateInstance::<_, IUnknown>(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL) else { return false };
            let mut raw = std::ptr::null_mut();
            if unknown.query(&IID_POLICY_CONFIG, &mut raw).is_err() || raw.is_null() {
                return false;
            }
            let config = IUnknown::from_raw(raw);
            let vtable = *(raw as *const *const usize);
            let set: SetDefaultEndpoint = std::mem::transmute(*vtable.add(13));
            let ok = [eConsole, eMultimedia, eCommunications].into_iter().all(|role| set(config.as_raw(), PCWSTR(wide.as_ptr()), role).is_ok());
            drop(config);
            ok
        }
    }

    pub fn with_com<T>(work: impl FnOnce() -> T) -> T {
        // SAFETY: balanced with CoUninitialize when this call started COM on the thread.
        let here = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        let value = work();
        if here {
            unsafe { CoUninitialize() };
        }
        value
    }
}

/// A dial's reading: level 0 to 100 (None when it can't be read) and whether it is muted.
#[derive(Default)]
pub(super) struct Reading {
    pub(super) level: Option<u8>,
    pub(super) muted: Option<bool>,
}

fn percent(scalar: f32) -> u8 {
    (scalar * 100.0).round().clamp(0.0, 100.0) as u8
}

/// The app an app dial with no app of its own follows: the focused window's program, or, while that one
/// makes no sound (an editor, the desktop), the last focused app that did. Returns (name, program file).
pub(super) fn focused() -> Option<(String, String)> {
    #[cfg(windows)]
    {
        static LAST: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);
        let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(path) = imp::focused() {
            let name = imp::name_of(&path).unwrap_or_default();
            if imp::with_com(|| imp::sessions().iter().any(|session| session.name == name)) {
                *last = Some((name, path));
            }
        }
        last.clone()
    }
    #[cfg(not(windows))]
    None
}

/// The program file of an app with sound, for its icon.
pub(super) fn path_of(app: &str) -> Option<String> {
    #[cfg(windows)]
    {
        imp::with_com(|| imp::sessions().into_iter().find(|session| session.name == app).map(|session| session.path))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        None
    }
}

/// Apps playing sound right now, by name, each once.
pub(super) fn apps() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut names: Vec<String> = imp::with_com(|| imp::sessions().into_iter().map(|session| session.name).collect());
        names.sort();
        names.dedup();
        names
    }
    #[cfg(not(windows))]
    Vec::new()
}

/// The app's volume and mute, empty when it has no audio session.
pub(super) fn reading(app: &str) -> Reading {
    #[cfg(windows)]
    {
        imp::with_com(|| {
            let Some(session) = imp::sessions().into_iter().find(|session| session.name == app) else { return Reading::default() };
            // SAFETY: COM calls on a live interface.
            unsafe {
                Reading {
                    level: session.volume.GetMasterVolume().ok().map(percent),
                    muted: session.volume.GetMute().ok().map(|muted| muted.as_bool()),
                }
            }
        })
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Reading::default()
    }
}

pub(super) fn set(app: &str, level: u8) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::with_com(|| {
            let mut found = false;
            for session in imp::sessions().into_iter().filter(|session| session.name == app) {
                // SAFETY: a COM call on a live interface.
                found |= unsafe { session.volume.SetMasterVolume(level.min(100) as f32 / 100.0, std::ptr::null()) }.is_ok();
            }
            if found { Ok(()) } else { Err(format!("{app} isn't playing sound")) }
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, level);
        Err("Per-app volume is only on Windows".into())
    }
}

/// Mutes or unmutes every session of the app, following the first one.
pub(super) fn toggle_mute(app: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::with_com(|| {
            let sessions: Vec<_> = imp::sessions().into_iter().filter(|session| session.name == app).collect();
            // SAFETY: COM calls on live interfaces.
            let muted = sessions.first().and_then(|session| unsafe { session.volume.GetMute() }.ok()).ok_or(format!("{app} isn't playing sound"))?;
            for session in &sessions {
                let _ = unsafe { session.volume.SetMute(!muted.as_bool(), std::ptr::null()) };
            }
            Ok(())
        })
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Per-app volume is only on Windows".into())
    }
}

/// The default microphone's level and mute.
pub(super) fn mic_reading() -> Reading {
    #[cfg(windows)]
    {
        imp::with_com(|| {
            let Some(mic) = imp::mic() else { return Reading::default() };
            // SAFETY: COM calls on a live interface.
            unsafe { Reading { level: mic.GetMasterVolumeLevelScalar().ok().map(percent), muted: mic.GetMute().ok().map(|muted| muted.as_bool()) } }
        })
    }
    #[cfg(not(windows))]
    Reading::default()
}

pub(super) fn set_mic(level: u8) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::with_com(|| {
            let mic = imp::mic().ok_or("No microphone")?;
            // SAFETY: a COM call on a live interface.
            unsafe { mic.SetMasterVolumeLevelScalar(level.min(100) as f32 / 100.0, std::ptr::null()) }.map_err(|error| error.to_string())
        })
    }
    #[cfg(not(windows))]
    {
        let _ = level;
        Err("No microphone".into())
    }
}

pub(super) fn toggle_mic_mute() -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::with_com(|| {
            let mic = imp::mic().ok_or("No microphone")?;
            // SAFETY: COM calls on a live interface.
            unsafe {
                let muted = mic.GetMute().map_err(|error| error.to_string())?;
                mic.SetMute(!muted.as_bool(), std::ptr::null()).map_err(|error| error.to_string())
            }
        })
    }
    #[cfg(not(windows))]
    Err("No microphone".into())
}

/// Moves sound to the next plugged-in speakers or headphones; returns their name.
pub(super) fn next_output() -> Result<String, String> {
    #[cfg(windows)]
    {
        imp::with_com(|| {
            let (devices, current) = imp::outputs().ok_or("Could not list the speakers")?;
            if devices.len() < 2 {
                return Err("Only one speaker is plugged in".into());
            }
            let at = devices.iter().position(|(id, _)| *id == current).map_or(0, |index| (index + 1) % devices.len());
            let (id, name) = &devices[at];
            if imp::set_default_output(id) { Ok(name.clone()) } else { Err("Windows did not switch the speakers".into()) }
        })
    }
    #[cfg(not(windows))]
    Err("Switching speakers is only on Windows".into())
}

/// Valid app names: what [apps] produces, so nothing odd reaches the deck file.
pub(super) fn valid_name(app: &str) -> bool {
    (1..=64).contains(&app.len()) && app.chars().all(|c| c.is_ascii_alphanumeric() || "._- ".contains(c))
}

#[cfg(test)]
mod tests {
    #[test]
    fn names_are_plain_program_names() {
        assert!(super::valid_name("spotify") && super::valid_name("msedge.beta"));
        assert!(!super::valid_name("") && !super::valid_name("a/b") && !super::valid_name(&"x".repeat(65)));
    }

    /// Reads this PC's mixer: `cargo test live_mixer -- --ignored --nocapture`. Changes nothing.
    #[test]
    #[ignore]
    fn live_mixer() {
        for app in super::apps() {
            let reading = super::reading(&app);
            println!("{app}: {:?} muted {:?} at {:?}", reading.level, reading.muted, super::path_of(&app));
        }
        let mic = super::mic_reading();
        println!("mic {:?} muted {:?}", mic.level, mic.muted);
        println!("brightness {:?}", crate::remote::brightness_level());
        println!("dial follows {:?}", super::focused());
        #[cfg(windows)]
        println!("outputs {:?}", super::imp::with_com(super::imp::outputs));
    }
}
