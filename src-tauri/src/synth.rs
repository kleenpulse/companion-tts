use base64::Engine as _;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const ELEVEN_MODEL: &str = "eleven_flash_v2_5";
const ELEVEN_FORMAT: &str = "mp3_44100_128";
const MISTRAL_MODEL: &str = "voxtral-mini-tts-2603";
const MISTRAL_FORMAT: &str = "mp3";
const TIMEOUT: Duration = Duration::from_secs(20);
/// This many consecutive primary failures (with the fallback succeeding)
/// promotes the fallback to primary — the UI then tells the truth.
const AUTO_SWITCH_AFTER: u32 = 3;

pub struct SynthState {
    /// 401/403 = key is wrong; retrying burns nothing but never succeeds.
    /// Cleared only by a settings change or restart (ported from ellum-ai_v2).
    pub permanently_failed: Mutex<HashSet<String>>,
    /// Consecutive transient failures per provider — feeds the auto-switcher.
    pub consecutive_failures: Mutex<HashMap<String, u32>>,
    pub client: reqwest::Client,
}

impl Default for SynthState {
    fn default() -> Self {
        Self {
            permanently_failed: Mutex::new(HashSet::new()),
            consecutive_failures: Mutex::new(HashMap::new()),
            client: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .expect("reqwest client"),
        }
    }
}

enum SynthError {
    /// HTTP 401/403 — provider skipped for process lifetime.
    Auth(String),
    /// Everything else — fall through to the next provider.
    Transient(String),
}

async fn synth_elevenlabs(
    client: &reqwest::Client,
    key: &str,
    voice: &str,
    text: &str,
) -> Result<Vec<u8>, SynthError> {
    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format={ELEVEN_FORMAT}"
    );
    let res = client
        .post(&url)
        .header("xi-api-key", key)
        .json(&serde_json::json!({ "text": text, "model_id": ELEVEN_MODEL }))
        .send()
        .await
        .map_err(|e| SynthError::Transient(format!("elevenlabs network: {e}")))?;

    let status = res.status();
    if status == 401 || status == 403 {
        return Err(SynthError::Auth(format!("elevenlabs auth {status}")));
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(SynthError::Transient(format!(
            "elevenlabs {status}: {}",
            body.chars().take(200).collect::<String>()
        )));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| SynthError::Transient(format!("elevenlabs body: {e}")))?;
    Ok(bytes.to_vec())
}

async fn synth_mistral(
    client: &reqwest::Client,
    key: &str,
    voice: &str,
    text: &str,
) -> Result<Vec<u8>, SynthError> {
    let res = client
        .post("https://api.mistral.ai/v1/audio/speech")
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": MISTRAL_MODEL,
            "input": text,
            "voice_id": voice,
            "response_format": MISTRAL_FORMAT,
            "stream": false
        }))
        .send()
        .await
        .map_err(|e| SynthError::Transient(format!("mistral network: {e}")))?;

    let status = res.status();
    if status == 401 || status == 403 {
        return Err(SynthError::Auth(format!("mistral auth {status}")));
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(SynthError::Transient(format!(
            "mistral {status}: {}",
            body.chars().take(200).collect::<String>()
        )));
    }

    // Response shape is undocumented-ambiguous: sniff Content-Type.
    // audio/* → raw bytes; JSON → base64 in audio_data/audioData.
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| SynthError::Transient(format!("mistral body: {e}")))?;

    if content_type.starts_with("application/json") {
        let v: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| SynthError::Transient(format!("mistral json: {e}")))?;
        let b64 = v["audio_data"]
            .as_str()
            .or_else(|| v["audioData"].as_str())
            .ok_or_else(|| SynthError::Transient("mistral json missing audio_data".into()))?;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| SynthError::Transient(format!("mistral base64: {e}")))
    } else {
        Ok(bytes.to_vec())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub permanently_failed: bool,
    pub has_key: bool,
}

#[tauri::command]
pub fn provider_status(app: AppHandle, state: State<'_, SynthState>) -> Vec<ProviderStatus> {
    let payload = crate::settings::payload(&app);
    let failed = state.permanently_failed.lock().unwrap();
    ["elevenlabs", "mistral", "piper", "windows"]
        .into_iter()
        .map(|id| ProviderStatus {
            id: id.to_string(),
            permanently_failed: failed.contains(id),
            has_key: match id {
                "elevenlabs" => !payload.settings.keys.elevenlabs.trim().is_empty(),
                "mistral" => !payload.settings.keys.mistral.trim().is_empty(),
                // "configured" for piper = a voice model is downloaded.
                "piper" => crate::piper_tts::voice_ready(&app, &payload.settings.voices.piper),
                // On-device needs no key — always eligible.
                _ => true,
            },
        })
        .collect()
}

/// Can this provider synthesize at all right now? Cloud = has a key;
/// piper = has a downloaded voice; windows = always.
fn eligible(app: &AppHandle, s: &crate::settings::Settings, provider: &str) -> bool {
    match provider {
        "elevenlabs" => !s.keys.elevenlabs.trim().is_empty(),
        "mistral" => !s.keys.mistral.trim().is_empty(),
        "piper" => crate::piper_tts::voice_ready(app, &s.voices.piper),
        "windows" => true,
        _ => false,
    }
}

/// New keys deserve a clean slate — called by set_settings.
pub fn reset_breaker(state: &SynthState) {
    state.permanently_failed.lock().unwrap().clear();
    state.consecutive_failures.lock().unwrap().clear();
}

/// The (model, voice) pair that shapes a provider's audio output — the
/// cache-key components beyond the text itself. Must change whenever the
/// bytes a provider would produce change.
fn cache_inputs<'a>(provider: &str, s: &'a crate::settings::Settings) -> (String, &'a str) {
    match provider {
        "elevenlabs" => (
            format!("{ELEVEN_MODEL}/{ELEVEN_FORMAT}"),
            s.voices.elevenlabs.as_str(),
        ),
        "mistral" => (
            format!("{MISTRAL_MODEL}/{MISTRAL_FORMAT}"),
            s.voices.mistral.as_str(),
        ),
        // Piper voice ids encode model+quality; windows "" = OS default voice.
        "piper" => (String::new(), s.voices.piper.as_str()),
        _ => (String::new(), s.voices.windows.as_str()),
    }
}

#[tauri::command]
pub async fn synthesize(
    app: AppHandle,
    state: State<'_, SynthState>,
    text: String,
    scope: String,
) -> Result<tauri::ipc::Response, String> {
    if text.trim().is_empty() {
        return Err("empty-text".into());
    }
    let payload = crate::settings::payload(&app);
    let s = &payload.settings;
    let primary = s.provider_order.first().cloned().unwrap_or_default();
    let mut last_err = String::from("no provider configured");
    let scope = crate::audio_cache::sanitize_scope(&scope);

    // Cache check against the FIRST usable provider only — checking every
    // fallback rung would happily replay a stale fallback voice while the
    // primary is healthy. A hit skips add_chars (no paid call happened) but
    // still names the voice for the panel's VOICE indicator.
    let first_usable = s
        .provider_order
        .iter()
        .find(|p| !state.permanently_failed.lock().unwrap().contains(*p) && eligible(&app, s, p));
    if let Some(provider) = first_usable {
        let (model, voice) = cache_inputs(provider, s);
        let key = crate::audio_cache::cache_key(provider, &model, voice, &text);
        if let Some(bytes) = crate::audio_cache::lookup(&app, &scope, &key) {
            let _ = app.emit("synth-used", provider.clone());
            return Ok(tauri::ipc::Response::new(bytes));
        }
    }

    for provider in &s.provider_order {
        if state.permanently_failed.lock().unwrap().contains(provider) {
            continue;
        }
        if !eligible(&app, s, provider) {
            continue;
        }
        let (key, voice) = match provider.as_str() {
            "elevenlabs" => (s.keys.elevenlabs.clone(), s.voices.elevenlabs.clone()),
            "mistral" => (s.keys.mistral.clone(), s.voices.mistral.clone()),
            // Local providers: keyless (eligibility handled above).
            "piper" => (String::new(), s.voices.piper.clone()),
            "windows" => (String::new(), s.voices.windows.clone()),
            _ => continue,
        };

        let result = match provider.as_str() {
            "elevenlabs" => synth_elevenlabs(&state.client, &key, &voice, &text).await,
            "piper" => {
                // Blocks on the piper inference thread — off the async runtime.
                let t = text.clone();
                let handle = app.clone();
                match tauri::async_runtime::spawn_blocking(move || {
                    crate::piper_tts::synthesize(&handle, &voice, &t)
                })
                .await
                {
                    Ok(Ok(bytes)) => Ok(bytes),
                    Ok(Err(e)) => Err(SynthError::Transient(format!("piper tts: {e}"))),
                    Err(e) => Err(SynthError::Transient(format!("piper tts join: {e}"))),
                }
            }
            "windows" => {
                // WinRT .get() blocks — keep it off the async runtime.
                let t = text.clone();
                match tauri::async_runtime::spawn_blocking(move || {
                    crate::local_tts::synthesize(&voice, &t)
                })
                .await
                {
                    Ok(Ok(bytes)) => Ok(bytes),
                    Ok(Err(e)) => Err(SynthError::Transient(format!("windows tts: {e}"))),
                    Err(e) => Err(SynthError::Transient(format!("windows tts join: {e}"))),
                }
            }
            _ => synth_mistral(&state.client, &key, &voice, &text).await,
        };

        match result {
            Ok(bytes) => {
                state.consecutive_failures.lock().unwrap().remove(provider.as_str());
                // Tell the UI which voice actually spoke.
                let _ = app.emit("synth-used", provider.clone());

                // Auto-switcher: fallback succeeded while the primary is
                // unconfigured (no key / no voice — silently skipped forever),
                // dead (breaker), or persistently failing — promote the
                // fallback so the VOICE header tells the truth.
                if *provider != primary && !primary.is_empty() {
                    let promote = !eligible(&app, s, &primary)
                        || state.permanently_failed.lock().unwrap().contains(&primary)
                        || state
                            .consecutive_failures
                            .lock()
                            .unwrap()
                            .get(&primary)
                            .copied()
                            .unwrap_or(0)
                            >= AUTO_SWITCH_AFTER;
                    if promote {
                        crate::settings::promote_provider(&app, provider);
                    }
                }

                // Monthly chars is a paid-usage proxy — local providers are free.
                if !matches!(provider.as_str(), "piper" | "windows") {
                    crate::settings::add_chars(&app, text.chars().count() as u64);
                }
                // Store under the provider that ACTUALLY served (fallback may
                // differ from the looked-up primary) so a later hit replays
                // exactly this voice.
                let (model, voice) = cache_inputs(provider, s);
                let key = crate::audio_cache::cache_key(provider, &model, voice, &text);
                crate::audio_cache::store(&app, &scope, &key, &bytes);
                return Ok(tauri::ipc::Response::new(bytes));
            }
            Err(SynthError::Auth(msg)) => {
                eprintln!("[synth] {provider} permanently failed: {msg}");
                state
                    .permanently_failed
                    .lock()
                    .unwrap()
                    .insert(provider.clone());
                last_err = msg;
            }
            Err(SynthError::Transient(msg)) => {
                eprintln!("[synth] {provider} transient: {msg}");
                *state
                    .consecutive_failures
                    .lock()
                    .unwrap()
                    .entry(provider.clone())
                    .or_insert(0) += 1;
                last_err = msg;
            }
        }
    }
    Err(format!("all-providers-failed: {last_err}"))
}
