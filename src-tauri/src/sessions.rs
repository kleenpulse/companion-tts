use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::parser::{self, SessionEvent};

const TITLE_SCAN_BYTES: u64 = 64 * 1024;
const BACKFILL_BYTES: u64 = 64 * 1024;
const RECENT_WINDOW_MS: u64 = 48 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    pub project_slug: String,
    pub path: String,
    pub title: Option<String>,
    pub last_activity: u64,
}

#[derive(Default)]
pub struct SessionsState(pub Mutex<HashMap<String, SessionMeta>>);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn project_slug_of(path: &Path) -> String {
    path.parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn scan_title(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; TITLE_SCAN_BYTES as usize];
    let n = file.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    for line in text.lines() {
        if !line.contains("\"ai-title\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v["type"].as_str() == Some("ai-title") {
                if let Some(t) = v["aiTitle"].as_str() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

fn emit_list(app: &AppHandle) {
    let state: State<SessionsState> = app.state();
    let mut list: Vec<SessionMeta> = state.0.lock().unwrap().values().cloned().collect();
    list.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    let _ = app.emit("sessions-updated", list);
}

/// Register recently-touched sessions at startup so the panel list isn't empty.
pub fn initial_scan(app: &AppHandle, root: &Path) {
    let cutoff = now_ms().saturating_sub(RECENT_WINDOW_MS);
    let state: State<SessionsState> = app.state();
    {
        let mut map = state.0.lock().unwrap();
        let Ok(projects) = std::fs::read_dir(root) else {
            return;
        };
        for project in projects.flatten() {
            let Ok(files) = std::fs::read_dir(project.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                    continue;
                }
                let Ok(meta) = std::fs::metadata(&path) else {
                    continue;
                };
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                if mtime < cutoff {
                    continue;
                }
                let session_id = crate::tailer::session_id_of(&path);
                if crate::settings::is_hidden_session(app, &session_id) {
                    continue;
                }
                map.insert(
                    session_id.clone(),
                    SessionMeta {
                        session_id,
                        project_slug: project_slug_of(&path),
                        path: path.to_string_lossy().to_string(),
                        title: scan_title(&path),
                        last_activity: mtime,
                    },
                );
            }
        }
    }
    emit_list(app);
}

/// Called by the tailer whenever speakable events flowed from a file.
pub fn note_activity(app: &AppHandle, session_id: &str, path: &Path) {
    // A dismissed session that speaks again earns its way back onto the list.
    crate::settings::remove_hidden_session(app, session_id);
    let state: State<SessionsState> = app.state();
    let is_new = {
        let mut map = state.0.lock().unwrap();
        match map.get_mut(session_id) {
            Some(meta) => {
                meta.last_activity = now_ms();
                false
            }
            None => {
                map.insert(
                    session_id.to_string(),
                    SessionMeta {
                        session_id: session_id.to_string(),
                        project_slug: project_slug_of(path),
                        path: path.to_string_lossy().to_string(),
                        title: scan_title(path),
                        last_activity: now_ms(),
                    },
                );
                true
            }
        }
    };
    // Membership changes always emit; pure activity bumps are carried by the
    // session-event stream itself, but a periodic list refresh keeps ordering honest.
    if is_new {
        emit_list(app);
    }
}

pub fn set_title(app: &AppHandle, session_id: &str, title: &str) {
    let state: State<SessionsState> = app.state();
    let changed = {
        let mut map = state.0.lock().unwrap();
        match map.get_mut(session_id) {
            Some(meta) if meta.title.as_deref() != Some(title) => {
                meta.title = Some(title.to_string());
                true
            }
            _ => false,
        }
    };
    if changed {
        emit_list(app);
    }
}

#[tauri::command]
pub fn list_sessions(app: AppHandle) -> Vec<SessionMeta> {
    let state: State<SessionsState> = app.state();
    let mut list: Vec<SessionMeta> = state.0.lock().unwrap().values().cloned().collect();
    list.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    list
}

/// Dismiss a session from the list. The transcript file on disk is NEVER
/// touched — only the session's cached audio goes with it.
#[tauri::command]
pub fn hide_session(app: AppHandle, session_id: String) {
    crate::settings::add_hidden_session(&app, &session_id);
    crate::audio_cache::purge_session(&app, &session_id);
    let state: State<SessionsState> = app.state();
    state.0.lock().unwrap().remove(&session_id);
    emit_list(&app);
}

/// Trailing speakable events for the panel's grayed history feed — never spoken.
#[tauri::command]
pub fn tail_backfill(app: AppHandle, session_id: String, max_events: usize) -> Vec<SessionEvent> {
    let state: State<SessionsState> = app.state();
    let path = match state.0.lock().unwrap().get(&session_id) {
        Some(meta) => std::path::PathBuf::from(&meta.path),
        None => return vec![],
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        return vec![];
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(BACKFILL_BYTES);
    let Ok(lines) = crate::tail::read_window_lines(&mut file, start) else {
        return vec![];
    };
    let mut events: Vec<SessionEvent> = lines
        .iter()
        .filter_map(|l| parser::classify(l, &session_id))
        .filter(|e| matches!(e, SessionEvent::Text { .. } | SessionEvent::Tool { .. }))
        .collect();
    if events.len() > max_events {
        events.drain(..events.len() - max_events);
    }
    events
}
