use notify::{RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::tailer::{self, TailState};

pub fn projects_root() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".claude").join("projects")
}

/// Top-level session files only: `<root>\<project-slug>\<session>.jsonl`.
/// Anything deeper (subagent sidechains live at `<slug>\<uuid>\subagents\*.jsonl`) is excluded.
fn is_session_file(root: &Path, path: &Path) -> bool {
    if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
        return false;
    }
    match path.strip_prefix(root) {
        Ok(rel) => rel.components().count() == 2,
        Err(_) => false,
    }
}

/// Prime every pre-existing session file at its current EOF: history is never
/// narrated; everything appended after launch is eligible.
fn prime(root: &Path) -> HashMap<PathBuf, TailState> {
    let mut tails = HashMap::new();
    let Ok(projects) = std::fs::read_dir(root) else {
        return tails;
    };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if is_session_file(root, &path) {
                if let Ok(meta) = std::fs::metadata(&path) {
                    tails.insert(
                        path.clone(),
                        TailState::new(meta.len(), tailer::session_id_of(&path)),
                    );
                }
            }
        }
    }
    tails
}

pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("companion-watcher".into())
        .spawn(move || {
            if let Err(e) = run(&app) {
                eprintln!("[watcher] died: {e}");
                let _ = app.emit("watcher-status", "dead");
            }
        })
        .expect("failed to spawn watcher thread");
}

fn run(app: &AppHandle) -> notify::Result<()> {
    let root = projects_root();
    std::fs::create_dir_all(&root).ok();

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    let mut tails = prime(&root);
    crate::sessions::initial_scan(app, &root);
    let _ = app.emit("watcher-status", "watching");

    loop {
        let mut dirty: HashSet<PathBuf> = HashSet::new();
        if !recv_burst(&rx, |ev| collect(ev, &root, &mut dirty)) {
            break; // channel closed — app shutting down
        }
        for path in dirty {
            tailer::process_path(app, &mut tails, &path);
        }
    }
    Ok(())
}

/// Block for one channel item, then keep feeding `each` with everything that
/// lands within the next 40ms. Coalesces the burst: Claude Code writes several
/// lines per turn boundary, and Windows fires multiple Modify events per
/// logical write. Returns false once the channel closes before anything
/// arrives. Shared with the attention notifications tail.
pub fn recv_burst<T>(rx: &mpsc::Receiver<T>, mut each: impl FnMut(T)) -> bool {
    let first = match rx.recv() {
        Ok(item) => item,
        Err(_) => return false,
    };
    each(first);
    let deadline = Instant::now() + Duration::from_millis(40);
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(remaining) {
            Ok(item) => each(item),
            Err(_) => break,
        }
    }
    true
}

fn collect(ev: notify::Result<notify::Event>, root: &Path, dirty: &mut HashSet<PathBuf>) {
    // Treat every event kind as "check the offset" — Windows event semantics are
    // too coarse to trust more precisely than that.
    if let Ok(event) = ev {
        for path in event.paths {
            if is_session_file(root, &path) {
                dirty.insert(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_file_filter() {
        let root = PathBuf::from("C:\\u\\.claude\\projects");
        assert!(is_session_file(&root, &root.join("d--x").join("abc.jsonl")));
        assert!(!is_session_file(&root, &root.join("d--x").join("abc.json")));
        assert!(!is_session_file(
            &root,
            &root.join("d--x").join("abc").join("subagents").join("agent-1.jsonl")
        ));
        assert!(!is_session_file(&root, &root.join("stray.jsonl")));
        assert!(!is_session_file(&root, &PathBuf::from("D:\\elsewhere\\x.jsonl")));
    }
}
