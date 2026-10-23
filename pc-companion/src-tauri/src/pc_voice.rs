//! Voice commands said into the PC's own mic, heard by Windows' speech recognizer (the one Windows dictation
//! uses). What it hears so far shows in the voice island; the sentence then runs like one from the phone.
use crate::island;
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

/// Listens for one sentence and returns it ("" when nothing was said). Blocks, so run it off the async runtime.
pub fn listen_once() -> Result<String, String> {
    if !online_speech_on() {
        return Err("Turn on Online speech recognition in Windows Settings, under Privacy & security, Speech.".into());
    }
    let recognizer = SpeechRecognizer::new().map_err(explain)?;
    if let Ok(timeouts) = recognizer.Timeouts() {
        let _ = timeouts.SetInitialSilenceTimeout(seconds(6.0));
        let _ = timeouts.SetEndSilenceTimeout(seconds(0.9));
    }
    let _ = recognizer.HypothesisGenerated(&TypedEventHandler::new(
        |_: Ref<SpeechRecognizer>, args: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
            if let Ok(text) = args.ok().and_then(|args| args.Hypothesis()).and_then(|hypothesis| hypothesis.Text()) {
                island::show("listening", &text.to_string());
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
