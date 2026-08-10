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

/// Cloud providers speak reqwest on the async runtime; locals block, so they
/// run under spawn_blocking. Auth breaker trips only ever come from Cloud —
/// locals have no key to reject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderKind {
    Cloud,
    Local,
}

/// Everything the eligibility predicates need, snapshotted once per call so
/// the predicates stay pure (no AppHandle, no filesystem — testable).
struct EligibilityCtx {
    has_elevenlabs_key: bool,
    has_mistral_key: bool,
    /// "Configured" for piper = a voice model is downloaded.
    piper_voice_ready: bool,
}

fn eligibility_ctx(app: &AppHandle, s: &crate::settings::Settings) -> EligibilityCtx {
    EligibilityCtx {
        has_elevenlabs_key: !s.keys.elevenlabs.trim().is_empty(),
        has_mistral_key: !s.keys.mistral.trim().is_empty(),
        piper_voice_ready: crate::piper_tts::voice_ready(app, &s.voices.piper),
    }
}

/// One TTS provider, described once — status, eligibility, dispatch, billing
/// and cache keys all derive from this table instead of scattered matches.
struct Provider {
    id: &'static str,
    kind: ProviderKind,
    /// Counts toward monthly chars (paid-usage proxy) — locals are free.
    billed: bool,
    /// Can this provider synthesize at all right now? Cloud = has a key;
    /// piper = has a downloaded voice; windows = always.
    eligible: fn(&EligibilityCtx) -> bool,
    /// The (model, voice) pair that shapes this provider's audio output — the
    /// cache-key components beyond the text itself. Must change whenever the
    /// bytes the provider would produce change.
    cache_inputs: fn(&crate::settings::Settings) -> (String, String),
}

/// Order = the canonical id list (also the provider_status display order).
static PROVIDERS: [Provider; 4] = [
    Provider {
        id: "elevenlabs",
        kind: ProviderKind::Cloud,
        billed: true,
        eligible: |ctx| ctx.has_elevenlabs_key,
        cache_inputs: |s| {
            (
                format!("{ELEVEN_MODEL}/{ELEVEN_FORMAT}"),
                s.voices.elevenlabs.clone(),
            )
        },
    },
    Provider {
        id: "mistral",
        kind: ProviderKind::Cloud,
        billed: true,
        eligible: |ctx| ctx.has_mistral_key,
        cache_inputs: |s| {
            (
                format!("{MISTRAL_MODEL}/{MISTRAL_FORMAT}"),
                s.voices.mistral.clone(),
            )
        },
    },
    // Piper voice ids encode model+quality; windows "" = OS default voice.
    Provider {
        id: "piper",
        kind: ProviderKind::Local,
        billed: false,
        eligible: |ctx| ctx.piper_voice_ready,
        cache_inputs: |s| (String::new(), s.voices.piper.clone()),
    },
    Provider {
        id: "windows",
        kind: ProviderKind::Local,
        billed: false,
        // On-device needs no key — always eligible.
        eligible: |_| true,
        cache_inputs: |s| (String::new(), s.voices.windows.clone()),
    },
];

fn provider_by_id(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// The fallback walk, planned up front: providers from `order` that are known,
/// eligible, and not tripped — in order. Unknown ids simply drop out (they
/// could never have synthesized anyway). Pure; testable without HTTP.
fn plan(
    order: &[String],
    permanently_failed: &HashSet<String>,
    ctx: &EligibilityCtx,
) -> Vec<&'static Provider> {
    order
        .iter()
        .filter(|id| !permanently_failed.contains(id.as_str()))
        .filter_map(|id| provider_by_id(id))
        .filter(|p| (p.eligible)(ctx))
        .collect()
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
    let ctx = eligibility_ctx(&app, &payload.settings);
    let failed = state.permanently_failed.lock().unwrap();
    PROVIDERS
        .iter()
        .map(|p| ProviderStatus {
            id: p.id.to_string(),
            permanently_failed: failed.contains(p.id),
            // Same predicate the synthesize walk uses — the UI can't drift.
            has_key: (p.eligible)(&ctx),
        })
        .collect()
}

/// New keys deserve a clean slate — called by set_settings.
pub fn reset_breaker(state: &SynthState) {
    state.permanently_failed.lock().unwrap().clear();
    state.consecutive_failures.lock().unwrap().clear();
}

/// The ONLY match on provider ids. `provider` always comes out of PROVIDERS
/// (via plan), so the unreachable arms really are — the old `_ => mistral`
/// catch-all only ever served "mistral" itself, because eligible() already
/// gated unknown ids out of the walk.
async fn dispatch(
    app: &AppHandle,
    client: &reqwest::Client,
    provider: &'static Provider,
    s: &crate::settings::Settings,
    text: &str,
) -> Result<Vec<u8>, SynthError> {
    match provider.kind {
        ProviderKind::Cloud => match provider.id {
            "elevenlabs" => {
                synth_elevenlabs(client, &s.keys.elevenlabs, &s.voices.elevenlabs, text).await
            }
            "mistral" => synth_mistral(client, &s.keys.mistral, &s.voices.mistral, text).await,
            other => unreachable!("unknown cloud provider {other}"),
        },
        ProviderKind::Local => match provider.id {
            "piper" => {
                // Blocks on the piper inference thread — off the async runtime.
                let t = text.to_string();
                let voice = s.voices.piper.clone();
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
                let t = text.to_string();
                let voice = s.voices.windows.clone();
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
            other => unreachable!("unknown local provider {other}"),
        },
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

    let ctx = eligibility_ctx(&app, s);
    let walk = {
        let failed = state.permanently_failed.lock().unwrap();
        plan(&s.provider_order, &failed, &ctx)
    };

    // Cache check against the FIRST usable provider only — checking every
    // fallback rung would happily replay a stale fallback voice while the
    // primary is healthy. A hit skips add_chars (no paid call happened) but
    // still names the voice for the panel's VOICE indicator.
    if let Some(provider) = walk.first() {
        let (model, voice) = (provider.cache_inputs)(s);
        let key = crate::audio_cache::cache_key(provider.id, &model, &voice, &text);
        if let Some(bytes) = crate::audio_cache::lookup(&app, &scope, &key) {
            let _ = app.emit("synth-used", provider.id);
            return Ok(tauri::ipc::Response::new(bytes));
        }
    }

    for provider in walk {
        // Re-check the breaker: an auth trip earlier in THIS walk must keep
        // skipping the same id if it somehow appears again in the order.
        if state.permanently_failed.lock().unwrap().contains(provider.id) {
            continue;
        }

        match dispatch(&app, &state.client, provider, s, &text).await {
            Ok(bytes) => {
                state.consecutive_failures.lock().unwrap().remove(provider.id);
                // Tell the UI which voice actually spoke.
                let _ = app.emit("synth-used", provider.id);

                // Auto-switcher: fallback succeeded while the primary is
                // unconfigured (no key / no voice — silently skipped forever),
                // dead (breaker), or persistently failing — promote the
                // fallback so the VOICE header tells the truth.
                if provider.id != primary && !primary.is_empty() {
                    let primary_eligible = provider_by_id(&primary)
                        .map(|p| (p.eligible)(&ctx))
                        .unwrap_or(false);
                    let promote = !primary_eligible
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
                        crate::settings::promote_provider(&app, provider.id);
                    }
                }

                // Monthly chars is a paid-usage proxy — local providers are free.
                if provider.billed {
                    crate::settings::add_chars(&app, text.chars().count() as u64);
                }
                // Store under the provider that ACTUALLY served (fallback may
                // differ from the looked-up primary) so a later hit replays
                // exactly this voice.
                let (model, voice) = (provider.cache_inputs)(s);
                let key = crate::audio_cache::cache_key(provider.id, &model, &voice, &text);
                crate::audio_cache::store(&app, &scope, &key, &bytes);
                return Ok(tauri::ipc::Response::new(bytes));
            }
            Err(SynthError::Auth(msg)) => {
                eprintln!("[synth] {} permanently failed: {msg}", provider.id);
                state
                    .permanently_failed
                    .lock()
                    .unwrap()
                    .insert(provider.id.to_string());
                last_err = msg;
            }
            Err(SynthError::Transient(msg)) => {
                eprintln!("[synth] {} transient: {msg}", provider.id);
                *state
                    .consecutive_failures
                    .lock()
                    .unwrap()
                    .entry(provider.id.to_string())
                    .or_insert(0) += 1;
                last_err = msg;
            }
        }
    }
    Err(format!("all-providers-failed: {last_err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(el: bool, mi: bool, piper: bool) -> EligibilityCtx {
        EligibilityCtx {
            has_elevenlabs_key: el,
            has_mistral_key: mi,
            piper_voice_ready: piper,
        }
    }

    fn order(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn ids(walk: &[&'static Provider]) -> Vec<&'static str> {
        walk.iter().map(|p| p.id).collect()
    }

    fn test_settings() -> crate::settings::Settings {
        let mut s = crate::settings::Settings::default();
        s.voices.elevenlabs = "voice-el".into();
        s.voices.mistral = "voice-mi".into();
        s.voices.piper = "en_GB-alba-medium".into();
        s.voices.windows = "win-voice".into();
        s
    }

    #[test]
    fn plan_respects_order_and_skips_ineligible_and_failed() {
        let all = ctx(true, true, true);
        let none_failed = HashSet::new();

        // Full house, custom order: plan mirrors the order.
        let o = order(&["mistral", "elevenlabs", "piper", "windows"]);
        assert_eq!(
            ids(&plan(&o, &none_failed, &all)),
            ["mistral", "elevenlabs", "piper", "windows"]
        );

        // No keys, no piper voice: only the on-device fallback survives.
        let o = order(&["elevenlabs", "mistral", "piper", "windows"]);
        assert_eq!(
            ids(&plan(&o, &none_failed, &ctx(false, false, false))),
            ["windows"]
        );

        // Breaker-tripped primary is skipped even with its key present.
        let failed: HashSet<String> = ["elevenlabs".to_string()].into();
        assert_eq!(
            ids(&plan(&o, &failed, &all)),
            ["mistral", "piper", "windows"]
        );
    }

    #[test]
    fn plan_excludes_unknown_provider_ids() {
        let o = order(&["polly", "elevenlabs", "windows"]);
        assert_eq!(
            ids(&plan(&o, &HashSet::new(), &ctx(true, true, true))),
            ["elevenlabs", "windows"]
        );
    }

    #[test]
    fn eligibility_per_descriptor() {
        let by = |id: &str| provider_by_id(id).unwrap();
        // Cloud rungs need their key; nothing else moves them.
        assert!((by("elevenlabs").eligible)(&ctx(true, false, false)));
        assert!(!(by("elevenlabs").eligible)(&ctx(false, true, true)));
        assert!((by("mistral").eligible)(&ctx(false, true, false)));
        assert!(!(by("mistral").eligible)(&ctx(true, false, true)));
        // Piper needs a downloaded voice.
        assert!((by("piper").eligible)(&ctx(false, false, true)));
        assert!(!(by("piper").eligible)(&ctx(true, true, false)));
        // Windows works in every permutation.
        for el in [false, true] {
            for mi in [false, true] {
                for pi in [false, true] {
                    assert!((by("windows").eligible)(&ctx(el, mi, pi)));
                }
            }
        }
        assert!(provider_by_id("polly").is_none());
    }

    #[test]
    fn billed_flags_exclude_locals() {
        assert!(provider_by_id("elevenlabs").unwrap().billed);
        assert!(provider_by_id("mistral").unwrap().billed);
        assert!(!provider_by_id("piper").unwrap().billed);
        assert!(!provider_by_id("windows").unwrap().billed);
    }

    #[test]
    fn cloud_local_split_matches_ids() {
        assert_eq!(provider_by_id("elevenlabs").unwrap().kind, ProviderKind::Cloud);
        assert_eq!(provider_by_id("mistral").unwrap().kind, ProviderKind::Cloud);
        assert_eq!(provider_by_id("piper").unwrap().kind, ProviderKind::Local);
        assert_eq!(provider_by_id("windows").unwrap().kind, ProviderKind::Local);
    }

    /// Golden values transcribed from the pre-table cache_inputs() — the cache
    /// key components must survive the refactor byte-for-byte or every cached
    /// utterance goes stale.
    #[test]
    fn cache_inputs_match_pre_refactor_values() {
        let s = test_settings();
        assert_eq!(
            (provider_by_id("elevenlabs").unwrap().cache_inputs)(&s),
            ("eleven_flash_v2_5/mp3_44100_128".to_string(), "voice-el".to_string())
        );
        assert_eq!(
            (provider_by_id("mistral").unwrap().cache_inputs)(&s),
            ("voxtral-mini-tts-2603/mp3".to_string(), "voice-mi".to_string())
        );
        assert_eq!(
            (provider_by_id("piper").unwrap().cache_inputs)(&s),
            (String::new(), "en_GB-alba-medium".to_string())
        );
        assert_eq!(
            (provider_by_id("windows").unwrap().cache_inputs)(&s),
            (String::new(), "win-voice".to_string())
        );
    }

    #[test]
    fn canonical_id_list_is_stable() {
        assert_eq!(
            PROVIDERS.iter().map(|p| p.id).collect::<Vec<_>>(),
            ["elevenlabs", "mistral", "piper", "windows"]
        );
    }
}
