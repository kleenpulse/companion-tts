use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use crate::parser;

const UUID_LRU_CAP: usize = 512;

pub struct TailState {
    pub offset: u64,
    pub session_id: String,
    uuid_order: VecDeque<String>,
    uuid_set: HashSet<String>,
}

impl TailState {
    pub fn new(offset: u64, session_id: String) -> Self {
        Self {
            offset,
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

    if len < state.offset {
        // Truncated/rewritten: a rewrite means history, and history is never spoken.
        state.offset = len;
        return;
    }
    if len == state.offset {
        return;
    }

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    if file.seek(SeekFrom::Start(state.offset)).is_err() {
        return;
    }
    let mut buf = Vec::with_capacity((len - state.offset) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return;
    }

    // Consume only up to the last complete line; a partial tail stays on disk
    // and is re-read on the next event. No dangling buffer state to corrupt.
    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
        return;
    };
    let consumed = &buf[..=last_nl];
    state.offset += (last_nl + 1) as u64;

    let text = String::from_utf8_lossy(consumed);
    let session_id = state.session_id.clone();
    let mut any = false;

    for line in text.lines() {
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
    use std::io::Write;

    fn assistant_line(uuid: &str, text: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"{uuid}","timestamp":"t","message":{{"id":"m1","model":"claude-fable-5","stop_reason":null,"content":[{{"type":"text","text":"{text}"}}]}}}}"#
        )
    }

    /// Drives the offset machine without an AppHandle: returns fresh complete lines.
    fn consume(state: &mut TailState, path: &Path) -> Vec<String> {
        let len = std::fs::metadata(path).unwrap().len();
        if len < state.offset {
            state.offset = len;
            return vec![];
        }
        if len == state.offset {
            return vec![];
        }
        let mut f = std::fs::File::open(path).unwrap();
        f.seek(SeekFrom::Start(state.offset)).unwrap();
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).unwrap();
        let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
            return vec![];
        };
        let consumed = buf[..=last_nl].to_vec();
        state.offset += (last_nl + 1) as u64;
        String::from_utf8_lossy(&consumed)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect()
    }

    #[test]
    fn partial_line_not_consumed_until_complete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        let full = assistant_line("u1", "first");
        let (a, b) = full.split_at(30);

        f.write_all(a.as_bytes()).unwrap();
        f.flush().unwrap();
        let mut st = TailState::new(0, "s1".into());
        assert!(consume(&mut st, &path).is_empty(), "half a line must not be consumed");
        assert_eq!(st.offset, 0);

        f.write_all(b.as_bytes()).unwrap();
        f.write_all(b"\n").unwrap();
        f.flush().unwrap();
        let lines = consume(&mut st, &path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], full);
    }

    #[test]
    fn truncation_resets_to_eof_not_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s2.jsonl");
        std::fs::write(&path, format!("{}\n{}\n", assistant_line("u1", "a"), assistant_line("u2", "b"))).unwrap();
        let mut st = TailState::new(std::fs::metadata(&path).unwrap().len(), "s2".into());

        // Rewrite shorter — history rewritten, nothing re-narrated.
        std::fs::write(&path, format!("{}\n", assistant_line("u3", "c"))).unwrap();
        assert!(consume(&mut st, &path).is_empty());
        assert_eq!(st.offset, std::fs::metadata(&path).unwrap().len());

        // New growth after the reset IS consumed.
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(format!("{}\n", assistant_line("u4", "d")).as_bytes()).unwrap();
        let lines = consume(&mut st, &path);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("u4"));
    }

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
