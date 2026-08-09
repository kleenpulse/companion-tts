//! Persistent synthesized-audio cache: repeated text never re-hits a paid API.
//!
//! Layout: `app-data\audio-cache\<scope>\<sha256-hex>.bin`. Scope is chosen by
//! the frontend — `_shared` for app-generated vocabulary (blurbs, attention
//! phrases, which recur across every session and are never purged) and the
//! session id for prose (purged when the session is hidden). Bytes are stored
//! verbatim; the frontend mime-sniffs them, so MP3 and WAV coexist untouched.
//!
//! Keys hash provider + model + voice + text, so any voice/model change is a
//! clean miss. Known accepted staleness: the windows provider with voice `""`
//! (system default) keeps old audio if the OS default voice changes, and a
//! re-downloaded piper voice id reuses audio from the previous model files.
//!
//! Every fs error here is swallowed — a broken cache must never break speech.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Lowercase sha256 hex over provider/model/voice/text joined with 0x1F
/// (unit separator — can't appear in ids or sane text, kills concat
/// ambiguity). Hashed as UTF-8 bytes, so any transcript text is fair game.
pub fn cache_key(provider: &str, model: &str, voice: &str, text: &str) -> String {
    let mut hasher = Sha256::new();
    for (i, part) in [provider, model, voice, text].iter().enumerate() {
        if i > 0 {
            hasher.update([0x1f]);
        }
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

/// Scope strings come from the frontend — flatten them into a safe dir name.
/// No dots survive (session ids are hex-and-dash, `_shared` is underscore),
/// so `.`/`..`/hidden-file shapes can't exist by construction.
pub fn sanitize_scope(scope: &str) -> String {
    let cleaned: String = scope
        .chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "misc".into()
    } else {
        cleaned
    }
}

fn root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("no app data dir")
        .join("audio-cache")
}

pub fn lookup_in(root: &Path, scope: &str, key: &str) -> Option<Vec<u8>> {
    std::fs::read(root.join(scope).join(format!("{key}.bin"))).ok()
}

pub fn store_in(root: &Path, scope: &str, key: &str, bytes: &[u8]) {
    let dir = root.join(scope);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    // Unique .part suffix: two in-flight synths of identical text may both
    // store; write-then-rename keeps readers from ever seeing a torn file.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let part = dir.join(format!("{key}.part-{nanos}"));
    if std::fs::write(&part, bytes).is_err() {
        let _ = std::fs::remove_file(&part);
        return;
    }
    let target = dir.join(format!("{key}.bin"));
    if std::fs::rename(&part, &target).is_err() {
        // The twin won the race (Windows rename won't replace) — theirs is
        // byte-identical, so just drop ours.
        let _ = std::fs::remove_file(&part);
    }
}

pub fn purge_in(root: &Path, session_id: &str) {
    let scope = sanitize_scope(session_id);
    if scope == "_shared" {
        return; // app vocabulary, never session-owned
    }
    let _ = std::fs::remove_dir_all(root.join(scope));
}

pub fn lookup(app: &AppHandle, scope: &str, key: &str) -> Option<Vec<u8>> {
    lookup_in(&root(app), scope, key)
}

pub fn store(app: &AppHandle, scope: &str, key: &str, bytes: &[u8]) {
    store_in(&root(app), scope, key, bytes);
}

pub fn purge_session(app: &AppHandle, session_id: &str) {
    purge_in(&root(app), session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_is_stable() {
        // Locks the on-disk key format: if this ever changes, every user's
        // cache silently invalidates — change it knowingly or not at all.
        assert_eq!(
            cache_key("elevenlabs", "eleven_flash_v2_5/mp3_44100_128", "voice1", "hello"),
            "bbb7fd50a72cd3b4bdec6d422d40a7cae3ff6a2995b8a59d9402ccd0a452ded3"
        );
    }

    #[test]
    fn cache_key_varies_per_component() {
        let base = cache_key("p", "m", "v", "t");
        assert_ne!(base, cache_key("q", "m", "v", "t"));
        assert_ne!(base, cache_key("p", "n", "v", "t"));
        assert_ne!(base, cache_key("p", "m", "w", "t"));
        assert_ne!(base, cache_key("p", "m", "v", "u"));
        // Separator kills concat ambiguity: ("pm","","v","t") != ("p","m","v","t").
        assert_ne!(cache_key("pm", "", "v", "t"), cache_key("p", "m", "v", "t"));
        // Non-ASCII text hashes fine.
        let utf = cache_key("p", "m", "v", "café 🚀");
        assert_eq!(utf.len(), 64);
    }

    #[test]
    fn sanitize_scope_blocks_traversal() {
        assert_eq!(sanitize_scope("..\\..\\x"), "______x");
        assert_eq!(sanitize_scope("../../x"), "______x");
        assert_eq!(sanitize_scope(".."), "__");
        assert_eq!(sanitize_scope("."), "_");
        assert_eq!(sanitize_scope(""), "misc");
        assert_eq!(sanitize_scope("_shared"), "_shared");
        let long = sanitize_scope(&"a".repeat(200));
        assert_eq!(long.len(), 64);
        assert_eq!(
            sanitize_scope("0198c1c2-aaaa-bbbb-cccc-000000000000"),
            "0198c1c2-aaaa-bbbb-cccc-000000000000"
        );
    }

    #[test]
    fn store_lookup_roundtrip_and_purge() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        assert!(lookup_in(root, "sess1", "k1").is_none());
        store_in(root, "sess1", "k1", b"audio-bytes");
        assert_eq!(lookup_in(root, "sess1", "k1").unwrap(), b"audio-bytes");

        // Concurrent-twin simulation: second store of the same key leaves one
        // valid file and no stray .part files.
        store_in(root, "sess1", "k1", b"audio-bytes");
        assert_eq!(lookup_in(root, "sess1", "k1").unwrap(), b"audio-bytes");
        let strays: Vec<_> = std::fs::read_dir(root.join("sess1"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".part"))
            .collect();
        assert!(strays.is_empty());

        store_in(root, "_shared", "k2", b"blurb");
        purge_in(root, "sess1");
        assert!(lookup_in(root, "sess1", "k1").is_none());
        // Shared vocabulary survives purges, even a hostile explicit one.
        purge_in(root, "_shared");
        assert_eq!(lookup_in(root, "_shared", "k2").unwrap(), b"blurb");

        // Purging a never-created session is a no-op.
        purge_in(root, "ghost-session");
    }
}
