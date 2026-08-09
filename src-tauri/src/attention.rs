//! "Claude needs you" alerts. The transcript goes silent while Claude Code
//! waits on a permission prompt, so stall-guessing would false-alarm on every
//! slow command. Claude Code's Notification hook is the ground truth: it fires
//! exactly when permission is needed or Claude idles awaiting input. We install
//! a tiny hook that appends those notifications to a file in our app-data dir,
//! and tail that file the same way we tail transcripts (EOF-primed — history
//! is never re-announced).

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::mpsc;
use tauri::{AppHandle, Emitter, Manager};

const NOTIFICATIONS_FILE: &str = "notifications.jsonl";
const HOOK_SCRIPT: &str = "notification-hook.ps1";
/// Marker used to recognize our hook entry inside ~/.claude/settings.json.
const HOOK_MARKER: &str = "com.vxrcel.companion-tts";

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

/// The hook body: normalize stdin JSON to one line and append it.
fn hook_script_body(data_dir: &std::path::Path) -> String {
    let file = data_dir.join(NOTIFICATIONS_FILE);
    format!(
        "$payload = [Console]::In.ReadToEnd()\r\n\
         $payload = ($payload -replace \"[\\r\\n]+\", \" \").Trim()\r\n\
         if ($payload) {{ Add-Content -LiteralPath '{}' -Value $payload -Encoding UTF8 }}\r\n",
        file.to_string_lossy()
    )
}

/// Idempotently install the Notification hook: write the .ps1 helper and add
/// an entry to ~/.claude/settings.json (original backed up once). Returns true
/// if the hook is present when we're done.
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

    let hooks = root
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        return Err("settings.json 'hooks' is not an object".into());
    }
    let notification = hooks
        .as_object_mut()
        .unwrap()
        .entry("Notification")
        .or_insert_with(|| serde_json::json!([]));
    let Some(entries) = notification.as_array_mut() else {
        return Err("settings.json hooks.Notification is not an array".into());
    };

    if entries.iter().any(|e| e.to_string().contains(HOOK_MARKER)) {
        return Ok(true); // already installed
    }

    // First write into a foreign config: keep a one-time backup beside it.
    let backup = settings_path.with_extension("json.companion-bak");
    if !backup.exists() {
        if let Ok(original) = std::fs::read(&settings_path) {
            let _ = std::fs::write(&backup, original);
        }
    }

    let command = format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        script_path.to_string_lossy()
    );
    entries.push(serde_json::json!({
        "matcher": "",
        "hooks": [{ "type": "command", "command": command }]
    }));

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, pretty).map_err(|e| e.to_string())?;
    eprintln!("[attention] Notification hook installed into {}", settings_path.display());
    Ok(true)
}

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
    root["hooks"]["Notification"]
        .as_array()
        .map(|a| a.iter().any(|e| e.to_string().contains(HOOK_MARKER)))
        .unwrap_or(false)
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
        let mut offset: u64 = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);

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

        while rx.recv().is_ok() {
            // Coalesce bursts, then drain new complete lines.
            std::thread::sleep(std::time::Duration::from_millis(40));
            while rx.try_recv().is_ok() {}

            let Ok(mut file) = std::fs::File::open(&file_path) else {
                continue;
            };
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            if len < offset {
                offset = len; // truncated/rotated: never replay
                continue;
            }
            if len == offset {
                continue;
            }
            if file.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut buf = Vec::new();
            if file.read_to_end(&mut buf).is_err() {
                continue;
            }
            // Only consume up to the last complete newline.
            let consumed = match buf.iter().rposition(|&b| b == b'\n') {
                Some(pos) => pos + 1,
                None => continue,
            };
            let text = String::from_utf8_lossy(&buf[..consumed]).to_string();
            offset += consumed as u64;

            for line in text.lines() {
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
