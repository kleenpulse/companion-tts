//! On-device synthesis via WinRT `Windows.Media.SpeechSynthesis` — the keyless
//! provider ("windows"). No network, no cost, always available. Voices are the
//! classic SAPI set installed on the machine; output is a WAV container.
//!
//! Everything here BLOCKS on WinRT async operations — callers must wrap in
//! `spawn_blocking`, never run this on the async runtime.
//!
//! On non-Windows targets the module compiles to stubs (empty voice list,
//! erroring synthesize) so the command surface and dispatch arm stay uniform;
//! the provider table's `cfg!(windows)` eligibility keeps the stubs unreached.

use serde::Serialize;
#[cfg(windows)]
use windows::core::HSTRING;
#[cfg(windows)]
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
#[cfg(windows)]
use windows::Storage::Streams::DataReader;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsVoice {
    pub id: String,
    pub name: String,
    pub language: String,
}

/// Installed voices, for the panel's voice dropdown.
#[cfg(windows)]
#[tauri::command]
pub fn list_windows_voices() -> Vec<WindowsVoice> {
    let Ok(voices) = SpeechSynthesizer::AllVoices() else {
        return Vec::new();
    };
    let len = voices.Size().unwrap_or(0);
    (0..len)
        .filter_map(|i| voices.GetAt(i).ok())
        .map(|v| WindowsVoice {
            id: v.Id().map(|h| h.to_string()).unwrap_or_default(),
            name: v.DisplayName().map(|h| h.to_string()).unwrap_or_default(),
            language: v.Language().map(|h| h.to_string()).unwrap_or_default(),
        })
        .collect()
}

/// Synthesize `text` to WAV bytes. Empty `voice_id` = system default voice;
/// otherwise matched against installed voices by Id, then DisplayName.
#[cfg(windows)]
pub fn synthesize(voice_id: &str, text: &str) -> Result<Vec<u8>, String> {
    let synth = SpeechSynthesizer::new().map_err(|e| format!("init: {e}"))?;

    if !voice_id.trim().is_empty() {
        let voices = SpeechSynthesizer::AllVoices().map_err(|e| format!("voices: {e}"))?;
        let len = voices.Size().unwrap_or(0);
        for i in 0..len {
            let Ok(v) = voices.GetAt(i) else { continue };
            let id = v.Id().map(|h| h.to_string()).unwrap_or_default();
            let name = v.DisplayName().map(|h| h.to_string()).unwrap_or_default();
            if id == voice_id || name == voice_id {
                synth.SetVoice(&v).map_err(|e| format!("set voice: {e}"))?;
                break;
            }
        }
    }

    let stream = synth
        .SynthesizeTextToStreamAsync(&HSTRING::from(text))
        .map_err(|e| format!("synthesize: {e}"))?
        .get()
        .map_err(|e| format!("synthesize wait: {e}"))?;

    let size = stream.Size().map_err(|e| format!("stream size: {e}"))? as u32;
    let input = stream
        .GetInputStreamAt(0)
        .map_err(|e| format!("stream seek: {e}"))?;
    let reader = DataReader::CreateDataReader(&input).map_err(|e| format!("reader: {e}"))?;
    reader
        .LoadAsync(size)
        .map_err(|e| format!("load: {e}"))?
        .get()
        .map_err(|e| format!("load wait: {e}"))?;

    let mut buf = vec![0u8; size as usize];
    reader
        .ReadBytes(&mut buf)
        .map_err(|e| format!("read: {e}"))?;
    Ok(buf)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn list_windows_voices() -> Vec<WindowsVoice> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn synthesize(_voice_id: &str, _text: &str) -> Result<Vec<u8>, String> {
    Err("on-device voice is Windows-only".into())
}

#[cfg(all(test, windows))]
mod tests {
    // Real WinRT synthesis — offline, fast, and the only proof the engine works.
    #[test]
    fn synthesizes_wav_with_default_voice() {
        let bytes = super::synthesize("", "on device voice online").expect("synthesis");
        assert!(bytes.len() > 44, "wav should be more than a header");
        assert_eq!(&bytes[..4], b"RIFF");
    }

    #[test]
    fn lists_at_least_one_installed_voice() {
        assert!(!super::list_windows_voices().is_empty());
    }
}
