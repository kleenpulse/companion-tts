use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use crate::parser;
use crate::tail::TailCursor;

const UUID_LRU_CAP: usize = 512;

pub struct TailState {
    pub cursor: TailCursor,
    pub session_id: String,
    uuid_order: VecDeque<String>,
    uuid_set: HashSet<String>,
}

impl TailState {
    pub fn new(offset: u64, session_id: String) -> Self {
        Self {
            cursor: TailCursor { offset },
            session_id,
            uuid_order: VecDeque::new(),
            uuid_set: HashSet::new(),
        }
    }

    /// Returns true if the uuid was fresh (and records it).
    fn note_uuid(&mut self, uuid: &str) -> bool {
        if self.uuid_set.contains(uuid) {
            return false;
        }
        self.uuid_set.insert(uuid.to_string());
        self.uuid_order.push_back(uuid.to_string());
        if self.uuid_order.len() > UUID_LRU_CAP {
            if let Some(old) = self.uuid_order.pop_front() {
                self.uuid_set.remove(&old);
            }
        }
        true
    }
}

pub fn session_id_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Read and emit everything new on `path`. All TailState mutation happens on the
/// single watcher thread — no locks anywhere near the hot path.
pub fn process_path(app: &AppHandle, tails: &mut HashMap<PathBuf, TailState>, path: &Path) {
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => {
            tails.remove(path); // deleted/rotated away
            return;
        }
    };

    let state = tails.entry(path.to_path_buf()).or_insert_with(|| {
        // First sighting after launch = file born while we run → narrate from byte 0.
        // (Files that predate launch were primed at offset=len by the watcher.)
        TailState::new(0, session_id_of(path))
    });

    if len == state.cursor.offset {
        return; // fast path: nothing new, don't even open the file
    }
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let Ok(lines) = state.cursor.drain(&mut file, len) else {
        return;
    };

    let session_id = state.session_id.clone();
    let mut any = false;

    for line in &lines {
        if line.trim().is_empty() {
            continue;
        }
        let Some(ev) = parser::classify(line, &session_id) else {
            continue;
        };
        if let Some(uuid) = ev.uuid() {
            let uuid = uuid.to_string();
            if !state.note_uuid(&uuid) {
                continue;
            }
        }
        if let parser::SessionEvent::Title { ref title, .. } = ev {
            crate::sessions::set_title(app, &session_id, title);
        }
        let _ = app.emit("session-event", &ev);
        any = true;
    }

    if any {
        crate::sessions::note_activity(app, &session_id, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The offset machine itself is tested in tail.rs; here only the LRU.
    #[test]
    fn uuid_lru_dedupes() {
        let mut st = TailState::new(0, "s".into());
        assert!(st.note_uuid("a"));
        assert!(!st.note_uuid("a"));
        for i in 0..UUID_LRU_CAP {
            st.note_uuid(&format!("fill-{i}"));
        }
        // "a" evicted by cap; re-noting succeeds (harmless — file order makes true replays adjacent)
        assert!(st.note_uuid("a"));
    }
}
