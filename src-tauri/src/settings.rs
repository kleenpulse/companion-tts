use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Keys {
    pub elevenlabs: String,
    pub mistral: String,
}

impl Default for Keys {
    fn default() -> Self {
        Self { elevenlabs: String::new(), mistral: String::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Voices {
    pub elevenlabs: String,
    pub mistral: String,
    /// WinRT voice Id (or DisplayName); empty = system default voice.
    pub windows: String,
    /// Piper voice id (e.g. "en_GB-alba-medium"); empty = none downloaded yet.
    pub piper: String,
}

impl Default for Voices {
    fn default() -> Self {
        Self {
            elevenlabs: "EXAVITQu4vr4xnSDxMaL".into(), // Sarah
            mistral: "gb_jane_neutral".into(),
            windows: String::new(),
            piper: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Features {
    pub prose: bool,
    pub blurbs: bool,
    pub errors: bool,
    pub chime: bool,
    pub attention: bool,
}

impl Default for Features {
    fn default() -> Self {
        Self { prose: true, blurbs: true, errors: true, chime: true, attention: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Follow {
    pub mode: String, // "auto" | "pinned"
    pub pinned_session_id: Option<String>,
}

impl Default for Follow {
    fn default() -> Self {
        Self { mode: "auto".into(), pinned_session_id: None }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FabPos {
    pub x: i32,
    pub y: i32,
}

/// Where the user parked the panel. None = anchor beside the FAB.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shortcuts {
    pub mute: String,
    pub pause_resume: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self { mute: "Ctrl+Alt+M".into(), pause_resume: "Ctrl+Alt+P".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Monthly {
    pub month: String,
    /// Grand total for the month; pre-split installs carry unattributed chars
    /// here that never appear in by_provider (the Footer prices those at the
    /// old ElevenLabs rate, matching what the meter always claimed).
    pub chars: u64,
    /// Same chars attributed per billed provider — lets the UI price
    /// ElevenLabs and Mistral usage separately.
    pub by_provider: std::collections::BTreeMap<String, u64>,
}

impl Default for Monthly {
    fn default() -> Self {
        Self {
            month: String::new(),
            chars: 0,
            by_provider: std::collections::BTreeMap::new(),
        }
    }
}

/// Pure core of the monthly meter: rolls the month over (clearing the
/// attribution map with it) and books `n` chars against `provider`.
pub fn apply_chars(m: &mut Monthly, provider: &str, n: u64, month: &str) {
    if m.month != month {
        m.month = month.to_string();
        m.chars = 0;
        m.by_provider.clear();
    }
    m.chars += n;
    *m.by_provider.entry(provider.to_string()).or_insert(0) += n;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub keys: Keys,
    pub provider_order: Vec<String>,
    pub voices: Voices,
    pub features: Features,
    pub volume: f64,
    pub rate: f64,
    pub follow: Follow,
    pub visualizer: bool,
    pub visualizer_style: String, // "waves" | "strands"
    pub typewriter: bool,         // feed reveals spoken row in sync with playback
    pub replay_mode: String,      // "next" | "interrupt" | "interrupt-clear" | "off"
    /// Grace before a permission alert is *spoken*, ms. The ping is always
    /// instant; this only holds the sentence back, so 0 = speak immediately.
    /// Snapped to `ATTENTION_DELAY_STEPS` (the panel renders one pill each).
    pub attention_delay_ms: u32,
    pub theme: String,            // "dark" | "light" | "system"
    pub last_seen_version: String, // last What's New acknowledged; "" = never seeded
    pub fab_scale: f64,           // 0.75..=3.0, dial + window scale together
    pub hidden_sessions: Vec<String>,
    pub fab_position: Option<FabPos>,
    pub panel_bounds: Option<PanelBounds>,
    pub autostart: bool,
    pub confirm_quit: bool, // panel × asks before exiting
    pub shortcuts: Shortcuts,
    pub monthly: Monthly,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            keys: Keys::default(),
            provider_order: vec![
                "elevenlabs".into(),
                "mistral".into(),
                "piper".into(),
                "windows".into(),
            ],
            voices: Voices::default(),
            features: Features::default(),
            volume: 0.9,
            rate: 1.0,
            follow: Follow::default(),
            visualizer: true,
            visualizer_style: "strands".into(),
            typewriter: false,
            replay_mode: "next".into(),
            attention_delay_ms: 1500,
            theme: "dark".into(),
            last_seen_version: String::new(),
            fab_scale: 1.0,
            hidden_sessions: Vec::new(),
            fab_position: None,
            panel_bounds: None,
            autostart: false,
            confirm_quit: true,
            shortcuts: Shortcuts::default(),
            monthly: Monthly::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvKeys {
    pub elevenlabs: bool,
    pub mistral: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
    pub settings: Settings,
    pub env_keys: EnvKeys,
    /// Head of the synth walk — the provider the next utterance would use.
    /// None when nothing is eligible (non-Windows with nothing configured).
    pub planned_provider: Option<String>,
}

pub struct SettingsState(pub Mutex<Settings>);

static LAST_POS_SAVE_MS: AtomicU64 = AtomicU64::new(0);

fn settings_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("no app data dir");
    dir.join("settings.json")
}

pub fn load(app: &AppHandle) -> Settings {
    let mut settings = read_settings_file(&settings_path(app));
    sanitize(&mut settings);
    settings
}

/// Missing file = quiet first run. A file that exists but won't parse is
/// quarantined to `settings.json.corrupt` before defaults take over — it may
/// hold the only copy of the user's API keys, and the next save would
/// otherwise bury the evidence under a factory-fresh file.
fn read_settings_file(path: &Path) -> Settings {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return Settings::default(),
    };
    // serde_json rejects a UTF-8 BOM outright — and a BOM'd settings.json
    // (hand-edited, PowerShell'd) silently nuking every preference to
    // defaults is far too harsh a punishment. Strip it.
    match serde_json::from_str(raw.trim_start_matches('\u{feff}')) {
        Ok(settings) => settings,
        Err(e) => {
            eprintln!(
                "[settings] settings.json unreadable ({e}) — quarantined to settings.json.corrupt, starting from defaults"
            );
            let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
            Settings::default()
        }
    }
}

/// Every invariant a Settings value must satisfy, enforced at the seam:
/// applied on load and on every set_settings, so no consumer downstream
/// (window sizing, the frontend CSS transform) meets an out-of-range value.
pub fn sanitize(settings: &mut Settings) {
    ensure_local_providers(&mut settings.provider_order);
    // The UI range is L1..L10 = 0.75..=3.0 (format.ts fabLevelToScale).
    // f64::clamp panics on NaN — guard first.
    if !settings.fab_scale.is_finite() {
        settings.fab_scale = 1.0;
    }
    settings.fab_scale = settings.fab_scale.clamp(0.75, 3.0);
    if !matches!(
        settings.replay_mode.as_str(),
        "next" | "interrupt" | "interrupt-clear" | "off"
    ) {
        settings.replay_mode = "next".into();
    }
    settings.attention_delay_ms = snap_attention_delay(settings.attention_delay_ms);
}

/// Selectable grace windows, in ms — one pill each in the panel.
pub const ATTENTION_DELAY_STEPS: [u32; 4] = [0, 1500, 3000, 5000];

/// A hand-edited or future value snaps to the nearest step, so the pill row
/// always has exactly one selection.
fn snap_attention_delay(ms: u32) -> u32 {
    ATTENTION_DELAY_STEPS
        .into_iter()
        .min_by_key(|step| step.abs_diff(ms))
        .unwrap_or(1500)
}

/// Migration: installs predating the local providers gain them without their
/// chosen order being disturbed — "windows" appended as the always-works last
/// resort, "piper" slotted just above it (neural quality outranks robotic).
pub fn ensure_local_providers(order: &mut Vec<String>) {
    if !order.iter().any(|p| p == "windows") {
        order.push("windows".into());
    }
    if !order.iter().any(|p| p == "piper") {
        let windows_at = order.iter().position(|p| p == "windows").unwrap_or(order.len());
        order.insert(windows_at, "piper".into());
    }
}

pub fn save(app: &AppHandle, settings: &Settings) {
    if let Err(e) = write_settings_file(&settings_path(app), settings) {
        eprintln!("[settings] save failed: {e}");
    }
}

/// Write-then-rename, the audio_cache doctrine: settings.json is replaced
/// whole or not at all. A raw overwrite truncates first, and saves come from
/// several threads (window moves, monthly chars, panel edits) — a crash or a
/// racing writer mid-truncate could leave torn JSON that read back as a
/// factory reset. Unique .part suffix keeps concurrent saves off each other's
/// temp file; every rename lands a complete snapshot, last one wins.
fn write_settings_file(path: &Path, settings: &Settings) -> Result<(), String> {
    let parent = path.parent().ok_or("no parent dir")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| format!("serialize: {e}"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let part = path.with_extension(format!("json.part-{nanos}"));
    std::fs::write(&part, raw).map_err(|e| format!("write: {e}"))?;
    // std::fs::rename replaces an existing file on Windows (MOVEFILE_REPLACE_EXISTING).
    std::fs::rename(&part, path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("rename: {e}")
    })
}

/// Overlay env-var keys on top of stored keys (env fills blanks, never overrides).
pub fn merged(settings: &Settings) -> (Settings, EnvKeys) {
    let mut s = settings.clone();
    let mut env_keys = EnvKeys { elevenlabs: false, mistral: false };
    if s.keys.elevenlabs.trim().is_empty() {
        if let Ok(v) = std::env::var("ELEVEN_LABS") {
            if !v.trim().is_empty() {
                s.keys.elevenlabs = v;
                env_keys.elevenlabs = true;
            }
        }
    }
    if s.keys.mistral.trim().is_empty() {
        if let Ok(v) = std::env::var("MISTRAL_API_KEY") {
            if !v.trim().is_empty() {
                s.keys.mistral = v;
                env_keys.mistral = true;
            }
        }
    }
    (s, env_keys)
}

pub fn payload(app: &AppHandle) -> SettingsPayload {
    let state = app.state::<SettingsState>();
    // Snapshot then drop the guard — planned_provider locks SynthState and
    // touches the filesystem (piper voice check); never under this mutex.
    let snapshot = state.0.lock().unwrap().clone();
    payload_from(app, &snapshot)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// In-memory always; disk at most once per second (Moved events fire continuously during drag).
pub fn update_fab_position(app: &AppHandle, x: i32, y: i32) {
    let state = app.state::<SettingsState>();
    let snapshot = {
        let mut guard = state.0.lock().unwrap();
        guard.fab_position = Some(FabPos { x, y });
        guard.clone()
    };
    let now = now_ms();
    let last = LAST_POS_SAVE_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) > 1000 {
        LAST_POS_SAVE_MS.store(now, Ordering::Relaxed);
        save(app, &snapshot);
    }
}

/// User parked the panel somewhere — remember it (throttled like fab position).
pub fn update_panel_bounds(app: &AppHandle, bounds: PanelBounds) {
    let state = app.state::<SettingsState>();
    let snapshot = {
        let mut guard = state.0.lock().unwrap();
        guard.panel_bounds = Some(bounds);
        guard.clone()
    };
    let now = now_ms();
    let last = LAST_POS_SAVE_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) > 1000 {
        LAST_POS_SAVE_MS.store(now, Ordering::Relaxed);
        save(app, &snapshot);
    }
}

/// Moving the FAB re-anchors the panel: forget the parked spot.
pub fn clear_panel_bounds(app: &AppHandle) {
    let state = app.state::<SettingsState>();
    let mut guard = state.0.lock().unwrap();
    guard.panel_bounds = None;
}

/// Dismiss a session from the panel list. Never touches the transcript on disk.
pub fn add_hidden_session(app: &AppHandle, session_id: &str) {
    let state = app.state::<SettingsState>();
    let snapshot = {
        let mut guard = state.0.lock().unwrap();
        if guard.hidden_sessions.iter().any(|s| s == session_id) {
            return;
        }
        guard.hidden_sessions.push(session_id.to_string());
        guard.clone()
    };
    save(app, &snapshot);
}

/// Fresh activity resurrects a dismissed session — hide is a dismissal, not a ban.
pub fn remove_hidden_session(app: &AppHandle, session_id: &str) -> bool {
    let state = app.state::<SettingsState>();
    let snapshot = {
        let mut guard = state.0.lock().unwrap();
        let before = guard.hidden_sessions.len();
        guard.hidden_sessions.retain(|s| s != session_id);
        if guard.hidden_sessions.len() == before {
            return false;
        }
        guard.clone()
    };
    save(app, &snapshot);
    true
}

pub fn is_hidden_session(app: &AppHandle, session_id: &str) -> bool {
    let state = app.state::<SettingsState>();
    let guard = state.0.lock().unwrap();
    guard.hidden_sessions.iter().any(|s| s == session_id)
}

/// First Piper voice downloaded becomes the selection — never overrides a choice.
pub fn set_piper_voice_if_empty(app: &AppHandle, id: &str) {
    let state = app.state::<SettingsState>();
    let snapshot = {
        let mut guard = state.0.lock().unwrap();
        if !guard.voices.piper.trim().is_empty() {
            return;
        }
        guard.voices.piper = id.to_string();
        guard.clone()
    };
    save(app, &snapshot);
    let _ = app.emit("settings-updated", payload_from(app, &snapshot));
}

/// Removing the selected Piper voice clears the selection (provider goes dormant).
pub fn clear_piper_voice_if(app: &AppHandle, id: &str) {
    let state = app.state::<SettingsState>();
    let snapshot = {
        let mut guard = state.0.lock().unwrap();
        if guard.voices.piper != id {
            return;
        }
        guard.voices.piper = String::new();
        guard.clone()
    };
    save(app, &snapshot);
    let _ = app.emit("settings-updated", payload_from(app, &snapshot));
}

/// Auto-switcher: move a proven-working provider to the front of the order so
/// the UI reflects the voice actually speaking. Persists and notifies both windows.
pub fn promote_provider(app: &AppHandle, provider: &str) {
    let state = app.state::<SettingsState>();
    let snapshot = {
        let mut guard = state.0.lock().unwrap();
        if guard.provider_order.first().map(|p| p == provider).unwrap_or(false) {
            return;
        }
        guard.provider_order.retain(|p| p != provider);
        guard.provider_order.insert(0, provider.to_string());
        guard.clone()
    };
    save(app, &snapshot);
    eprintln!("[synth] auto-switched primary voice to {provider}");
    let _ = app.emit("settings-updated", payload_from(app, &snapshot));
}

/// Called by synth after each successful billed synthesis; rolls the month
/// over automatically and attributes the chars to the provider that served.
pub fn add_chars(app: &AppHandle, provider: &str, n: u64) {
    let month = current_month();
    let state = app.state::<SettingsState>();
    let snapshot = {
        let mut guard = state.0.lock().unwrap();
        apply_chars(&mut guard.monthly, provider, n, &month);
        guard.clone()
    };
    save(app, &snapshot);
    let _ = app.emit("settings-updated", payload_from(app, &snapshot));
}

fn current_month() -> String {
    // Days since epoch → (year, month) without a chrono dependency.
    let days = (now_ms() / 86_400_000) as i64;
    let (y, m, _) = civil_from_days(days);
    format!("{y:04}-{m:02}")
}

/// Howard Hinnant's days→civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn payload_from(app: &AppHandle, settings: &Settings) -> SettingsPayload {
    let (merged_settings, env_keys) = merged(settings);
    let planned_provider = crate::synth::planned_provider(app, &merged_settings);
    SettingsPayload { settings: merged_settings, env_keys, planned_provider }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> SettingsPayload {
    payload(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_appends_locals_to_old_orders() {
        let mut order = vec!["mistral".to_string(), "elevenlabs".to_string()];
        ensure_local_providers(&mut order);
        assert_eq!(order, ["mistral", "elevenlabs", "piper", "windows"]);
    }

    #[test]
    fn apply_chars_attributes_per_provider() {
        let mut m = Monthly { month: "2026-08".into(), chars: 10, ..Default::default() };
        apply_chars(&mut m, "elevenlabs", 100, "2026-08");
        apply_chars(&mut m, "mistral", 40, "2026-08");
        apply_chars(&mut m, "mistral", 5, "2026-08");
        // Total keeps the 10 legacy unattributed chars on top of the new 145.
        assert_eq!(m.chars, 155);
        assert_eq!(m.by_provider.get("elevenlabs"), Some(&100));
        assert_eq!(m.by_provider.get("mistral"), Some(&45));
    }

    #[test]
    fn apply_chars_rollover_clears_the_attribution_map() {
        let mut m = Monthly::default();
        apply_chars(&mut m, "elevenlabs", 100, "2026-07");
        apply_chars(&mut m, "mistral", 50, "2026-08");
        assert_eq!(m.month, "2026-08");
        assert_eq!(m.chars, 50);
        assert_eq!(m.by_provider.get("elevenlabs"), None);
        assert_eq!(m.by_provider.get("mistral"), Some(&50));
    }

    #[test]
    fn monthly_without_by_provider_still_deserializes() {
        // A pre-split settings.json has no byProvider key.
        let m: Monthly = serde_json::from_str(r#"{"month":"2026-06","chars":1234}"#).unwrap();
        assert_eq!(m.chars, 1234);
        assert!(m.by_provider.is_empty());
    }

    #[test]
    fn breaker_resets_only_on_key_or_order_change() {
        let prev = Settings::default();

        let mut key_change = prev.clone();
        key_change.keys.elevenlabs = "sk_new".into();
        assert!(breaker_should_reset(&prev, &key_change));

        let mut order_change = prev.clone();
        order_change.provider_order.rotate_left(1);
        assert!(breaker_should_reset(&prev, &order_change));

        let mut unrelated = prev.clone();
        unrelated.fab_scale = 2.0;
        unrelated.theme = "light".into();
        unrelated.voices.piper = "lessac".into();
        assert!(!breaker_should_reset(&prev, &unrelated));
    }

    #[test]
    fn sanitize_clamps_fab_scale_to_ui_range() {
        let mut s = Settings::default();
        s.fab_scale = 12.0;
        sanitize(&mut s);
        assert_eq!(s.fab_scale, 3.0);

        s.fab_scale = 0.1;
        sanitize(&mut s);
        assert_eq!(s.fab_scale, 0.75);

        s.fab_scale = 1.5;
        sanitize(&mut s);
        assert_eq!(s.fab_scale, 1.5);
    }

    #[test]
    fn sanitize_survives_non_finite_fab_scale() {
        let mut s = Settings::default();
        s.fab_scale = f64::NAN;
        sanitize(&mut s);
        assert_eq!(s.fab_scale, 1.0);

        s.fab_scale = f64::INFINITY;
        sanitize(&mut s);
        assert_eq!(s.fab_scale, 1.0);
    }

    #[test]
    fn migration_slots_piper_above_windows() {
        let mut order = vec!["mistral".to_string(), "windows".to_string(), "elevenlabs".to_string()];
        ensure_local_providers(&mut order);
        assert_eq!(order, ["mistral", "piper", "windows", "elevenlabs"]);
    }

    #[test]
    fn migration_is_idempotent() {
        let mut order = vec![
            "windows".to_string(),
            "piper".to_string(),
            "elevenlabs".to_string(),
        ];
        ensure_local_providers(&mut order);
        assert_eq!(order, ["windows", "piper", "elevenlabs"]);
    }

    #[test]
    fn old_settings_json_gains_local_voice_defaults() {
        let raw = r#"{"voices":{"elevenlabs":"x","mistral":"y"}}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.voices.windows, "");
        assert_eq!(s.voices.piper, "");
        assert_eq!(s.voices.elevenlabs, "x");
    }

    #[test]
    fn old_settings_json_lacking_theme_defaults_dark() {
        let raw = r#"{"voices":{"elevenlabs":"x","mistral":"y"}}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.theme, "dark");
    }

    #[test]
    fn old_settings_json_lacking_typewriter_defaults_false() {
        let raw = r#"{"voices":{"elevenlabs":"x","mistral":"y"}}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert!(!s.typewriter);
    }

    #[test]
    fn old_settings_json_lacking_confirm_quit_defaults_true() {
        let raw = r#"{"voices":{"elevenlabs":"x","mistral":"y"}}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert!(s.confirm_quit);
    }

    #[test]
    fn old_settings_json_lacking_replay_mode_defaults_next() {
        let raw = r#"{"voices":{"elevenlabs":"x","mistral":"y"}}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.replay_mode, "next");
    }

    #[test]
    fn sanitize_coerces_unknown_replay_mode_to_next() {
        let mut s = Settings::default();
        s.replay_mode = "yolo".into();
        sanitize(&mut s);
        assert_eq!(s.replay_mode, "next");

        s.replay_mode = "interrupt-clear".into();
        sanitize(&mut s);
        assert_eq!(s.replay_mode, "interrupt-clear");
    }

    #[test]
    fn old_settings_json_lacking_attention_delay_defaults_to_1500() {
        let raw = r#"{"voices":{"elevenlabs":"x","mistral":"y"}}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.attention_delay_ms, 1500);
    }

    #[test]
    fn sanitize_snaps_attention_delay_to_a_step() {
        let mut s = Settings::default();
        for (raw, want) in [(0, 0), (400, 0), (900, 1500), (2000, 1500), (4200, 5000), (99_999, 5000)] {
            s.attention_delay_ms = raw;
            sanitize(&mut s);
            assert_eq!(s.attention_delay_ms, want, "{raw} should snap to {want}");
        }
    }

    #[test]
    fn old_settings_json_lacking_last_seen_version_defaults_empty() {
        let raw = r#"{"voices":{"elevenlabs":"x","mistral":"y"}}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.last_seen_version, "");
    }

    #[test]
    fn settings_file_roundtrip_and_atomic_replace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        let mut s = Settings::default();
        s.keys.elevenlabs = "sk-live".into();
        s.fab_scale = 2.0;
        write_settings_file(&path, &s).unwrap();
        let back = read_settings_file(&path);
        assert_eq!(back.keys.elevenlabs, "sk-live");
        assert_eq!(back.fab_scale, 2.0);

        // A second save replaces the file whole and leaves no .part litter.
        s.fab_scale = 1.25;
        write_settings_file(&path, &s).unwrap();
        assert_eq!(read_settings_file(&path).fab_scale, 1.25);
        let strays: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".part"))
            .collect();
        assert!(strays.is_empty());
    }

    #[test]
    fn corrupt_settings_file_is_quarantined_not_defaulted_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // A torn write: valid JSON prefix, truncated mid-key.
        std::fs::write(&path, r#"{"keys":{"elevenlabs":"sk-precious","mist"#).unwrap();

        let s = read_settings_file(&path);
        assert_eq!(s.keys.elevenlabs, ""); // boots on defaults…

        // …but the original bytes survive for recovery, out of save()'s path.
        let quarantined = dir.path().join("settings.json.corrupt");
        assert!(quarantined.exists());
        assert!(std::fs::read_to_string(&quarantined).unwrap().contains("sk-precious"));
        assert!(!path.exists());

        // The next save starts a fresh file and leaves the quarantine alone.
        write_settings_file(&path, &Settings::default()).unwrap();
        assert!(path.exists());
        assert!(quarantined.exists());
    }

    #[test]
    fn missing_settings_file_is_a_quiet_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let s = read_settings_file(&path);
        assert_eq!(s.fab_scale, 1.0);
        assert!(!dir.path().join("settings.json.corrupt").exists());
    }

    #[test]
    fn bom_prefixed_settings_still_parse_and_are_not_quarantined() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "\u{feff}{\"volume\":0.3}").unwrap();
        let s = read_settings_file(&path);
        assert!((s.volume - 0.3).abs() < 1e-9);
        assert!(path.exists());
        assert!(!dir.path().join("settings.json.corrupt").exists());
    }
}

/// A tripped breaker should only be reopened when the user pulls one of the
/// deliberate retry levers: a key change or a provider re-order. Pure for tests.
fn breaker_should_reset(prev: &Settings, next: &Settings) -> bool {
    prev.keys.elevenlabs != next.keys.elevenlabs
        || prev.keys.mistral != next.keys.mistral
        || prev.provider_order != next.provider_order
}

#[tauri::command]
pub fn set_settings(app: AppHandle, mut settings: Settings) -> Result<SettingsPayload, String> {
    // Never persist a key that only exists because the env supplied it.
    if let Ok(v) = std::env::var("ELEVEN_LABS") {
        if settings.keys.elevenlabs == v {
            settings.keys.elevenlabs = String::new();
        }
    }
    if let Ok(v) = std::env::var("MISTRAL_API_KEY") {
        if settings.keys.mistral == v {
            settings.keys.mistral = String::new();
        }
    }

    // A stale frontend echo must never drop the keyless fallbacks or smuggle
    // an out-of-range fab scale to disk.
    sanitize(&mut settings);

    let state = app.state::<SettingsState>();
    let prev = {
        let mut guard = state.0.lock().unwrap();
        let prev = guard.clone();
        // Monthly counter is Rust-owned; ignore whatever the frontend echoes back.
        settings.monthly = guard.monthly.clone();
        // Window geometry is owned by the Moved/Resized handlers.
        settings.fab_position = guard.fab_position;
        settings.panel_bounds = guard.panel_bounds;
        // Hidden sessions are owned by the hide_session command.
        settings.hidden_sessions = guard.hidden_sessions.clone();
        *guard = settings.clone();
        prev
    };
    save(&app, &settings);

    crate::shortcuts::apply(&app, &settings);
    crate::windows::apply_autostart(&app, settings.autostart);
    crate::windows::apply_fab_scale(&app, settings.fab_scale);
    // Turning attention alerts on (re)installs the Notification hook.
    if settings.features.attention {
        if let Err(e) = crate::attention::ensure_hook(&app) {
            eprintln!("[attention] hook install failed: {e}");
        }
    }
    // Fresh keys (or a re-picked primary — the deliberate retry lever) deserve
    // a fresh breaker. Unrelated saves (fabScale drag, theme…) must NOT
    // resurrect a tripped provider — that would announce + fail on every save.
    if breaker_should_reset(&prev, &settings) {
        crate::synth::reset_breaker(&app.state::<crate::synth::SynthState>());
    }

    let p = payload_from(&app, &settings);
    let _ = app.emit("settings-updated", p.clone());
    Ok(p)
}
