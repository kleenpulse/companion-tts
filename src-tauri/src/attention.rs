//! "Claude needs you" alerts. The transcript goes silent while Claude Code
//! waits on a permission prompt, so stall-guessing would false-alarm on every
//! slow command. Claude Code's hooks are the ground truth, so we install two
//! and tail their output the same way we tail transcripts (EOF-primed —
//! history is never re-announced):
//!
//! - `PermissionRequest` — runs immediately before a permission prompt renders.
//!   This is the load-bearing one. Payload carries `tool_name`, not `message`.
//! - `Notification` — permission + the 60s-idle "waiting for your input" notice.
//!   Claude Code gates it behind a *presence check*: if you're at the keyboard
//!   it decides you already saw the prompt and never sends it, which is exactly
//!   backwards for a companion whose job is "look over here". Kept only for the
//!   idle case; `PermissionRequest` carries permission alerts.
//!
//! One helper script serves both — it normalizes either payload down to
//! `{session_id, message}` so nothing downstream needs to know which hook fired.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc;
use tauri::{AppHandle, Emitter, Manager};

use crate::tail::TailCursor;

const NOTIFICATIONS_FILE: &str = "notifications.jsonl";
const HOOK_SCRIPT: &str = "notification-hook.ps1";
/// Marker used to recognize our hook entry inside ~/.claude/settings.json.
const HOOK_MARKER: &str = "com.vxrcel.companion-tts";
/// Hook events we install, both pointed at the same helper script.
const HOOK_EVENTS: [&str; 2] = ["PermissionRequest", "Notification"];
/// Seconds. `PermissionRequest` runs *before* the prompt renders, so a wedged
/// helper would stall the prompt itself. Cap it well under Claude Code's default.
const HOOK_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionEvent {
    pub session_id: String,
    pub message: String,
}

fn app_data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn claude_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().home_dir().ok().map(|h| h.join(".claude").join("settings.json"))
}

/// The hook body, shared by both events: normalize stdin JSON down to one
/// `{session_id, message}` line and append it. `Notification` payloads carry
/// `message`; `PermissionRequest` payloads carry `tool_name`, which we phrase
/// into the same sentence Claude Code would have sent — so the Rust tailer and
/// `speech/attention.ts` stay blind to which hook fired.
///
/// Emits nothing on stdout: a `PermissionRequest` hook that printed JSON could
/// steer the permission decision, and this one must never have an opinion.
fn hook_script_body(data_dir: &std::path::Path) -> String {
    let file = data_dir.join(NOTIFICATIONS_FILE);
    const BODY: &str = concat!(
        "$ErrorActionPreference = 'SilentlyContinue'\r\n",
        "$raw = [Console]::In.ReadToEnd()\r\n",
        "if (-not $raw) { exit 0 }\r\n",
        "try { $p = ConvertFrom-Json $raw -ErrorAction Stop } catch { exit 0 }\r\n",
        "if (-not $p) { exit 0 }\r\n",
        "$msg = [string]$p.message\r\n",
        "if (-not $msg -and $p.tool_name) {\r\n",
        "  $msg = 'Claude needs your permission to use ' + [string]$p.tool_name\r\n",
        "}\r\n",
        "if (-not $msg) { exit 0 }\r\n",
        "$line = @{ session_id = [string]$p.session_id; message = $msg } | ConvertTo-Json -Compress\r\n",
        "Add-Content -LiteralPath '@@FILE@@' -Value $line -Encoding UTF8\r\n",
    );
    BODY.replace("@@FILE@@", &file.to_string_lossy())
}

/// Add our entry to `hooks.<event>` unless the marker is already there.
/// Returns true when the settings object was modified. Pure — the caller owns
/// reading, backing up, and writing the file.
fn ensure_hook_entry(
    root: &mut serde_json::Value,
    event: &str,
    command: &str,
) -> Result<bool, String> {
    let hooks = root
        .as_object_mut()
        .ok_or("~/.claude/settings.json is not a JSON object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let entries = hooks
        .as_object_mut()
        .ok_or("settings.json 'hooks' is not an object")?
        .entry(event)
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("settings.json hooks.{event} is not an array"))?;

    if entries.iter().any(|e| e.to_string().contains(HOOK_MARKER)) {
        return Ok(false); // already installed
    }
    entries.push(serde_json::json!({
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": command,
            "timeout": HOOK_TIMEOUT_SECS,
        }]
    }));
    Ok(true)
}

/// Idempotently install both hooks: write the .ps1 helper and add an entry per
/// event to ~/.claude/settings.json (original backed up once). Returns true if
/// the hooks are present when we're done. Existing installs pick up the new
/// `PermissionRequest` entry on the next boot — `lib.rs` calls this at startup.
pub fn ensure_hook(app: &AppHandle) -> Result<bool, String> {
    let data_dir = app_data_dir(app).ok_or("no app data dir")?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    // Helper script is ours — always rewrite so path/content stay current.
    let script_path = data_dir.join(HOOK_SCRIPT);
    std::fs::write(&script_path, hook_script_body(&data_dir)).map_err(|e| e.to_string())?;

    let settings_path = claude_settings_path(app).ok_or("no home dir")?;
    let mut root: serde_json::Value = match std::fs::read_to_string(&settings_path) {
        Ok(raw) => serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .map_err(|e| format!("~/.claude/settings.json is not valid JSON: {e}"))?,
        Err(_) => serde_json::json!({}),
    };
    if !root.is_object() {
        return Err("~/.claude/settings.json is not a JSON object".into());
    }

    let command = format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        script_path.to_string_lossy()
    );
    let mut added: Vec<&str> = Vec::new();
    for event in HOOK_EVENTS {
        if ensure_hook_entry(&mut root, event, &command)? {
            added.push(event);
        }
    }
    if added.is_empty() {
        return Ok(true);
    }

    // First write into a foreign config: keep a one-time backup beside it.
    let backup = settings_path.with_extension("json.companion-bak");
    if !backup.exists() {
        if let Ok(original) = std::fs::read(&settings_path) {
            let _ = std::fs::write(&backup, original);
        }
    }

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, pretty).map_err(|e| e.to_string())?;
    eprintln!(
        "[attention] {} hook(s) installed into {}",
        added.join(" + "),
        settings_path.display()
    );
    Ok(true)
}

/// True only when EVERY event we need carries the marker — a pre-PermissionRequest
/// install reads as not-installed so the panel offers the upgrade.
fn hook_installed(app: &AppHandle) -> bool {
    let Some(path) = claude_settings_path(app) else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}'))
    else {
        return false;
    };
    HOOK_EVENTS.iter().all(|event| {
        root["hooks"][event]
            .as_array()
            .map(|a| a.iter().any(|e| e.to_string().contains(HOOK_MARKER)))
            .unwrap_or(false)
    })
}

#[tauri::command]
pub fn attention_hook_status(app: AppHandle) -> bool {
    hook_installed(&app)
}

#[tauri::command]
pub fn install_attention_hook(app: AppHandle) -> Result<bool, String> {
    ensure_hook(&app)
}

/// Tail notifications.jsonl (EOF-primed) and emit attention events.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(data_dir) = app_data_dir(&app) else {
            return;
        };
        let _ = std::fs::create_dir_all(&data_dir);
        let file_path = data_dir.join(NOTIFICATIONS_FILE);

        // Prime at current EOF — old notifications are history, never spoken.
        let mut cursor =
            TailCursor::primed_at_eof(std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0));

        let (tx, rx) = mpsc::channel::<()>();
        use notify::Watcher;
        let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                let hit = ev
                    .paths
                    .iter()
                    .any(|p| p.file_name().map(|n| n == NOTIFICATIONS_FILE).unwrap_or(false));
                if hit {
                    let _ = tx.send(());
                }
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[attention] watcher failed: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&data_dir, notify::RecursiveMode::NonRecursive) {
            eprintln!("[attention] watch failed: {e}");
            return;
        }

        // Coalesce bursts (shared 40ms window), then drain new complete lines.
        while crate::watcher::recv_burst(&rx, |_| {}) {
            let Ok(mut file) = std::fs::File::open(&file_path) else {
                continue;
            };
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            let Ok(lines) = cursor.drain(&mut file, len) else {
                continue;
            };

            for line in &lines {
                let line = line.trim_start_matches('\u{feff}').trim();
                if line.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                let message = v["message"].as_str().unwrap_or_default().to_string();
                if message.is_empty() {
                    continue;
                }
                let session_id = v["session_id"].as_str().unwrap_or_default().to_string();
                let _ = app.emit("attention-event", AttentionEvent { session_id, message });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CMD: &str = "powershell -File \"C:\\x\\com.vxrcel.companion-tts\\notification-hook.ps1\"";

    fn install_all(root: &mut serde_json::Value) -> Vec<&'static str> {
        HOOK_EVENTS
            .into_iter()
            .filter(|e| ensure_hook_entry(root, e, CMD).unwrap())
            .collect()
    }

    #[test]
    fn installs_both_events_then_goes_quiet() {
        let mut root = json!({});
        assert_eq!(install_all(&mut root), vec!["PermissionRequest", "Notification"]);
        assert!(install_all(&mut root).is_empty(), "second run must be a no-op");
        for event in HOOK_EVENTS {
            let entries = root["hooks"][event].as_array().unwrap();
            assert_eq!(entries.len(), 1, "{event} got duplicated");
            assert_eq!(entries[0]["hooks"][0]["timeout"], HOOK_TIMEOUT_SECS);
        }
    }

    #[test]
    fn upgrades_a_notification_only_install() {
        // What v0.5.x wrote: Notification alone, no timeout field.
        let mut root = json!({
            "hooks": { "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": CMD }] }] }
        });
        assert_eq!(install_all(&mut root), vec!["PermissionRequest"]);
        assert_eq!(root["hooks"]["Notification"].as_array().unwrap().len(), 1);
        assert_eq!(root["hooks"]["PermissionRequest"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn preserves_foreign_hooks_and_settings() {
        let mut root = json!({
            "model": "opus",
            "hooks": {
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "node caveman.js" }] }],
                "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "someone-elses.exe" }] }]
            }
        });
        install_all(&mut root);
        assert_eq!(root["model"], "opus");
        assert_eq!(root["hooks"]["SessionStart"][0]["hooks"][0]["command"], "node caveman.js");
        let notif = root["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2, "foreign Notification hook must survive");
        assert_eq!(notif[0]["hooks"][0]["command"], "someone-elses.exe");
    }

    #[test]
    fn rejects_malformed_hook_shapes() {
        let mut root = json!({ "hooks": { "PermissionRequest": "nope" } });
        assert!(ensure_hook_entry(&mut root, "PermissionRequest", CMD).is_err());
        let mut root = json!({ "hooks": [] });
        assert!(ensure_hook_entry(&mut root, "Notification", CMD).is_err());
    }

    #[test]
    fn script_handles_both_payload_shapes() {
        let body = hook_script_body(std::path::Path::new("C:\\data"));
        assert!(body.contains("C:\\data\\notifications.jsonl"));
        assert!(body.contains("$p.message"), "Notification payload");
        assert!(body.contains("Claude needs your permission to use "), "PermissionRequest payload");
        assert!(!body.contains("@@FILE@@"), "placeholder left unsubstituted");
        // Anything on stdout could steer the permission decision.
        assert!(!body.contains("Write-Output") && !body.contains("Write-Host"));
    }
}
