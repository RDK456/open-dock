//! Voice commands said into the PC's own mic. With Windows' "Online speech recognition" on, the recognizer Windows
//! dictation uses hears them; with it off, the older desktop recognizer (SAPI), which runs on this PC. What it hears
//! so far shows in the voice island; the sentence then runs like one from the phone.
use crate::island;
use std::time::{Duration, Instant};
use windows::core::Ref;
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::SpeechRecognition::{
    SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus, SpeechRecognizer,
};

// Windows' speech recognizer is off until "Online speech recognition" is on; it answers with this.
const PRIVACY_POLICY_NOT_ACCEPTED: i32 = 0x80045509_u32 as i32;
const ACCESS_DENIED: i32 = 0x80070005_u32 as i32;

const fn seconds(value: f64) -> TimeSpan {
    TimeSpan { Duration: (value * 10_000_000.0) as i64 }
}

fn explain(error: windows::core::Error) -> String {
    match error.code().0 {
        PRIVACY_POLICY_NOT_ACCEPTED => "Turn on Online speech recognition in Windows Settings, under Privacy & security, Speech.".into(),
        ACCESS_DENIED => "Let desktop apps use the microphone in Windows Settings, under Privacy & security, Microphone.".into(),
        _ => format!("Windows could not listen ({})", error.message()),
    }
}

/// Whether "Online speech recognition" is on: without it Windows' dictation fails with only "Internal Speech Error".
fn online_speech_on() -> bool {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let read = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, w!("Software\\Microsoft\\Speech_OneCore\\Settings\\OnlineSpeechPrivacy"), w!("HasAccepted"), RRF_RT_REG_DWORD, None, Some((&mut value as *mut u32).cast()), Some(&mut size))
    };
    read.is_ok() && value == 1
}

/// What the island shows of words still being heard: all of them, or, listening for `wake`, only once it was said.
fn follow(wake: Option<&str>, text: &str) {
    match wake {
        None => island::show("listening", text),
        Some(phrase) => {
            if let Some(rest) = crate::voice::after_wake_phrase(text, phrase) {
                island::show("listening", &rest);
            }
        }
    }
}

/// Listens for one sentence and returns it ("" when nothing was said). Blocks, so run it off the async runtime.
pub fn listen_once(wake: Option<String>) -> Result<String, String> {
    // Windows' dictation also refuses elevated apps (like this one) with "Internal Speech Error", so fall back then too.
    if online_speech_on() { listen_online(wake.clone()).or_else(|_| listen_offline(wake)) } else { listen_offline(wake) }
}

fn listen_online(wake: Option<String>) -> Result<String, String> {
    let recognizer = SpeechRecognizer::new().map_err(explain)?;
    if let Ok(timeouts) = recognizer.Timeouts() {
        let _ = timeouts.SetInitialSilenceTimeout(seconds(6.0));
        let _ = timeouts.SetEndSilenceTimeout(seconds(0.9));
    }
    let _ = recognizer.HypothesisGenerated(&TypedEventHandler::new(
        move |_: Ref<SpeechRecognizer>, args: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
            if let Ok(text) = args.ok().and_then(|args| args.Hypothesis()).and_then(|hypothesis| hypothesis.Text()) {
                follow(wake.as_deref(), &text.to_string());
            }
            Ok(())
        },
    ));
    let compiled = recognizer.CompileConstraintsAsync().map_err(explain)?.join().map_err(explain)?;
    if compiled.Status().map_err(explain)? != SpeechRecognitionResultStatus::Success {
        return Err("Windows speech recognition is not set up for this language.".into());
    }
    let result = recognizer.RecognizeAsync().map_err(explain)?.join().map_err(explain)?;
    match result.Status().map_err(explain)? {
        SpeechRecognitionResultStatus::Success => Ok(result.Text().map_err(explain)?.to_string()),
        SpeechRecognitionResultStatus::TimeoutExceeded | SpeechRecognitionResultStatus::UserCanceled => Ok(String::new()),
        SpeechRecognitionResultStatus::MicrophoneUnavailable => Err("No microphone found on this PC.".into()),
        _ => Err("Windows could not understand that. Try again.".into()),
    }
}

/// The desktop recognizer: it hears less well than the online one, but needs no setting and nothing leaves this PC.
fn listen_offline(wake: Option<String>) -> Result<String, String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Media::Speech::{
        ISpObjectToken, ISpObjectTokenCategory, ISpRecoResult, ISpRecognizer, SpInprocRecognizer, SpObjectToken, SpObjectTokenCategory,
        SPCAT_AUDIOIN, SPEI_FALSE_RECOGNITION, SPEI_HYPOTHESIS, SPEI_RECOGNITION, SPEI_RESERVED1, SPEI_RESERVED2, SPEVENT, SPLO_STATIC, SPRS_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
    let fail = |error: windows::core::Error| format!("Windows could not listen ({})", error.message());
    unsafe {
        // ponytail: COM stays initialised on this pooled thread; the next listen reuses it.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let recognizer: ISpRecognizer = CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL)
            .map_err(|_| "Windows speech recognition is not installed. Turn on Online speech recognition in Windows Settings, under Privacy & security, Speech.".to_owned())?;
        let category: ISpObjectTokenCategory = CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL).map_err(fail)?;
        category.SetId(SPCAT_AUDIOIN, false).map_err(fail)?;
        let mic_id = category.GetDefaultTokenId().map_err(|_| "No microphone found on this PC.".to_owned())?;
        let mic: ISpObjectToken = CoCreateInstance(&SpObjectToken, None, CLSCTX_ALL).map_err(fail)?;
        let set = mic.SetId(PCWSTR::null(), PCWSTR(mic_id.0), false);
        CoTaskMemFree(Some(mic_id.0 as _));
        set.map_err(fail)?;
        recognizer.SetInput(&mic, true).map_err(explain)?;
        let context = recognizer.CreateRecoContext().map_err(fail)?;
        context.SetNotifyWin32Event().map_err(fail)?;
        // SAPI rejects an interest without its two reserved "flag check" events (SPFEI_FLAGCHECK).
        let interest = [SPEI_RECOGNITION, SPEI_FALSE_RECOGNITION, SPEI_HYPOTHESIS, SPEI_RESERVED1, SPEI_RESERVED2].iter().fold(0u64, |bits, event| bits | 1 << event.0);
        context.SetInterest(interest, interest).map_err(fail)?;
        let grammar = context.CreateGrammar(0).map_err(fail)?;
        grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC).map_err(fail)?;
        grammar.SetDictationState(SPRS_ACTIVE).map_err(fail)?;

        let started = Instant::now();
        let mut speaking = false;
        loop {
            let _ = context.WaitForNotifyEvent(200);
            let mut event = SPEVENT::default();
            let mut fetched = 0u32;
            while context.GetEvents(1, &mut event, &mut fetched).is_ok() && fetched == 1 {
                if event.lParam.0 == 0 {
                    continue;
                }
                // Each of these events carries a result object that is now ours to release.
                let result = ISpRecoResult::from_raw(event.lParam.0 as *mut _);
                let mut text = windows::core::PWSTR::null();
                let said = if result.GetText(u32::MAX, u32::MAX, true, &mut text, None).is_ok() && !text.is_null() {
                    let said = text.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(text.0 as _));
                    said
                } else {
                    String::new()
                };
                match event._bitfield & 0xffff {
                    id if id == SPEI_HYPOTHESIS.0 => {
                        speaking = true;
                        follow(wake.as_deref(), &said);
                    }
                    id if id == SPEI_RECOGNITION.0 => return Ok(said),
                    // Noise it could not make words of.
                    _ => return Ok(String::new()),
                }
            }
            let waited = started.elapsed();
            if (!speaking && waited > Duration::from_secs(6)) || waited > Duration::from_secs(20) {
                return Ok(String::new());
            }
        }
    }
}
