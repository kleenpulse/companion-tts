//! Pure byte-offset tail machinery — no AppHandle, no tauri. This is the one
//! implementation of the offset machine that used to live in three copies
//! (transcript tailer, attention notifications, panel backfill).

use std::io::{self, Read, Seek, SeekFrom};

/// Byte-offset cursor over an append-only file. The offset only ever advances
/// past a complete `\n`; truncation resets it to the new EOF (never 0), so a
/// rewritten file's history is never replayed.
pub struct TailCursor {
    pub offset: u64,
}

impl TailCursor {
    /// Start at EOF: pre-existing content is history and is never yielded.
    pub fn primed_at_eof(len: u64) -> Self {
        Self { offset: len }
    }

    /// Drain complete lines appended since the last call. `len` is the current
    /// file length (callers already have it from metadata). Bytes decode via
    /// lossy UTF-8; lines come back unfiltered — callers skip their own blanks.
    pub fn drain<R: Read + Seek>(&mut self, reader: &mut R, len: u64) -> io::Result<Vec<String>> {
        if len < self.offset {
            // Truncated/rewritten: a rewrite means history, and history is never spoken.
            self.offset = len;
            return Ok(Vec::new());
        }
        if len == self.offset {
            return Ok(Vec::new());
        }
        reader.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::with_capacity((len - self.offset) as usize);
        reader.read_to_end(&mut buf)?;

        // Consume only up to the last complete line; a partial tail stays on disk
        // and is re-read on the next event. No dangling buffer state to corrupt.
        let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
            return Ok(Vec::new());
        };
        self.offset += (last_nl + 1) as u64;
        Ok(String::from_utf8_lossy(&buf[..=last_nl])
            .lines()
            .map(str::to_string)
            .collect())
    }
}

/// One-shot read of a file's trailing window (backfill, not tailing): yields
/// every line from `start` to the actual EOF — including a final line with no
/// trailing newline, since there is no next pass to pick it up. When `start > 0`
/// the seek likely landed mid-line, so the first line is skipped.
pub fn read_window_lines<R: Read + Seek>(reader: &mut R, start: u64) -> io::Result<Vec<String>> {
    reader.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    reader.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf)
        .lines()
        .skip(if start > 0 { 1 } else { 0 })
        .map(str::to_string)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    fn drain_file(cursor: &mut TailCursor, path: &Path) -> Vec<String> {
        let len = std::fs::metadata(path).unwrap().len();
        let mut file = std::fs::File::open(path).unwrap();
        cursor.drain(&mut file, len).unwrap()
    }

    #[test]
    fn partial_line_not_consumed_until_complete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        let full = r#"{"type":"assistant","uuid":"u1","text":"first"}"#;
        let (a, b) = full.split_at(30);

        f.write_all(a.as_bytes()).unwrap();
        f.flush().unwrap();
        let mut cur = TailCursor { offset: 0 };
        assert!(drain_file(&mut cur, &path).is_empty(), "half a line must not be consumed");
        assert_eq!(cur.offset, 0);

        f.write_all(b.as_bytes()).unwrap();
        f.write_all(b"\n").unwrap();
        f.flush().unwrap();
        let lines = drain_file(&mut cur, &path);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], full);
    }

    #[test]
    fn truncation_resets_to_eof_not_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s2.jsonl");
        std::fs::write(&path, "line-a\nline-b\n").unwrap();
        let mut cur = TailCursor::primed_at_eof(std::fs::metadata(&path).unwrap().len());

        // Rewrite shorter — history rewritten, nothing re-narrated.
        std::fs::write(&path, "line-c\n").unwrap();
        assert!(drain_file(&mut cur, &path).is_empty());
        assert_eq!(cur.offset, std::fs::metadata(&path).unwrap().len());

        // New growth after the reset IS consumed.
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"line-d\n").unwrap();
        let lines = drain_file(&mut cur, &path);
        assert_eq!(lines, vec!["line-d"]);
    }

    #[test]
    fn primed_at_eof_skips_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s3.jsonl");
        std::fs::write(&path, "old-1\nold-2\n").unwrap();
        let mut cur = TailCursor::primed_at_eof(std::fs::metadata(&path).unwrap().len());

        // Pre-existing content is history — never yielded.
        assert!(drain_file(&mut cur, &path).is_empty());

        // A line appended after priming is fresh.
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"fresh\n").unwrap();
        assert_eq!(drain_file(&mut cur, &path), vec!["fresh"]);
    }

    #[test]
    fn window_read_skips_first_partial_and_keeps_unterminated_tail() {
        let data = b"aaa\nbbb\nccc";
        let mut r = io::Cursor::new(&data[..]);
        // start > 0 lands mid-line: "aa" is dropped, unterminated "ccc" kept.
        assert_eq!(read_window_lines(&mut r, 1).unwrap(), vec!["bbb", "ccc"]);
        // start == 0: nothing to skip.
        let mut r = io::Cursor::new(&data[..]);
        assert_eq!(read_window_lines(&mut r, 0).unwrap(), vec!["aaa", "bbb", "ccc"]);
    }
}
