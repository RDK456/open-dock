//! Per-app volume (the Windows volume mixer): each app is named by its program file without ".exe",
//! lower case ("spotify", "chrome"), and every audio session of that program moves together.
#[cfg(windows)]
mod imp {
    use windows::core::{Interface, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    fn program(pid: u32) -> Option<String> {
        // SAFETY: the handle is closed below; the buffer outlives the call and its length is passed with it.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buffer = [0u16; 1024];
            let mut len = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(process);
            ok.then(|| String::from_utf16_lossy(&buffer[..len as usize]))
                .and_then(|path| std::path::Path::new(&path).file_stem().map(|stem| stem.to_string_lossy().to_lowercase()))
        }
    }

    /// Every app with an audio session on the default speakers, with its volume.
    pub fn sessions() -> Vec<(String, ISimpleAudioVolume)> {
        // SAFETY: plain COM calls on interfaces this function owns.
        unsafe {
            let result = (|| -> windows::core::Result<Vec<(String, ISimpleAudioVolume)>> {
                let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let manager: IAudioSessionManager2 = devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)?;
                let list = manager.GetSessionEnumerator()?;
                let mut out = Vec::new();
                for index in 0..list.GetCount()? {
                    let control = list.GetSession(index)?;
                    let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
                    let Ok(pid) = control2.GetProcessId() else { continue };
                    let (Some(name), Ok(volume)) = (program(pid), control.cast::<ISimpleAudioVolume>()) else { continue };
                    out.push((name, volume));
                }
                Ok(out)
            })();
            result.unwrap_or_default()
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

/// Apps playing sound right now, by name, each once.
pub(super) fn apps() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut names: Vec<String> = imp::with_com(|| imp::sessions().into_iter().map(|(name, _)| name).collect());
        names.sort();
        names.dedup();
        names
    }
    #[cfg(not(windows))]
    Vec::new()
}

/// The app's volume 0 to 100, or None when it has no audio session.
pub(super) fn level(app: &str) -> Option<u8> {
    #[cfg(windows)]
    {
        imp::with_com(|| {
            imp::sessions().into_iter().find(|(name, _)| name == app)
                // SAFETY: a COM call on a live interface.
                .and_then(|(_, volume)| unsafe { volume.GetMasterVolume() }.ok())
                .map(|scalar| (scalar * 100.0).round().clamp(0.0, 100.0) as u8)
        })
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        None
    }
}

pub(super) fn set(app: &str, percent: u8) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::with_com(|| {
            let mut found = false;
            for (_, volume) in imp::sessions().into_iter().filter(|(name, _)| name == app) {
                // SAFETY: a COM call on a live interface.
                found |= unsafe { volume.SetMasterVolume(percent.min(100) as f32 / 100.0, std::ptr::null()) }.is_ok();
            }
            if found { Ok(()) } else { Err(format!("{app} isn't playing sound")) }
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, percent);
        Err("Per-app volume is only on Windows".into())
    }
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

    /// Reads this PC's mixer: `cargo test live_mixer -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_mixer() {
        for app in super::apps() {
            println!("{app}: {:?}", super::level(&app));
        }
        println!("brightness {:?}", crate::remote::brightness_level());
    }
}
