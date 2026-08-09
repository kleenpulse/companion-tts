//! Piper neural TTS — in-process via piper-rs (ONNX Runtime + espeak-ng).
//! Keyless like the WinRT provider, but eligible only once a voice model is
//! downloaded. Voices come from the official rhasspy/piper-voices catalog
//! (the same models piper1-gpl uses); output is a 16-bit PCM mono WAV.
//!
//! Inference runs on ONE dedicated OS thread: espeak-ng phonemization is
//! global-state C (not thread-safe), the loaded ort session stays hot between
//! utterances, and requests serialize naturally through the channel.

use serde::Serialize;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{mpsc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// Parent dir handed to espeak at init (`PIPER_ESPEAKNG_DATA_DIRECTORY`) —
/// set in lib.rs setup to the bundled resources dir.
pub const ESPEAK_DATA_ENV: &str = "PIPER_ESPEAKNG_DATA_DIRECTORY";

struct CatalogEntry {
    id: &'static str,
    label: &'static str,
    language: &'static str,
    size_mb: u32,
    hf_dir: &'static str,
}

/// Curated shortlist — official checkpoints, medium = ~63MB, high = ~100+MB.
const CATALOG: &[CatalogEntry] = &[
    CatalogEntry { id: "en_GB-alba-medium", label: "Alba", language: "en_GB", size_mb: 63, hf_dir: "en/en_GB/alba/medium" },
    CatalogEntry { id: "en_GB-cori-high", label: "Cori", language: "en_GB", size_mb: 104, hf_dir: "en/en_GB/cori/high" },
    CatalogEntry { id: "en_GB-northern_english_male-medium", label: "Northern English", language: "en_GB", size_mb: 63, hf_dir: "en/en_GB/northern_english_male/medium" },
    CatalogEntry { id: "en_US-lessac-medium", label: "Lessac", language: "en_US", size_mb: 63, hf_dir: "en/en_US/lessac/medium" },
    CatalogEntry { id: "en_US-amy-medium", label: "Amy", language: "en_US", size_mb: 63, hf_dir: "en/en_US/amy/medium" },
    CatalogEntry { id: "en_US-ryan-high", label: "Ryan", language: "en_US", size_mb: 115, hf_dir: "en/en_US/ryan/high" },
];

fn hf_url(entry: &CatalogEntry, ext: &str) -> String {
    format!(
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/{}/{}{ext}?download=true",
        entry.hf_dir, entry.id
    )
}

/* ---------- voice store ---------- */

fn voices_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("no app data dir")
        .join("piper")
}

fn voice_paths(app: &AppHandle, id: &str) -> (PathBuf, PathBuf) {
    let dir = voices_dir(app);
    (dir.join(format!("{id}.onnx")), dir.join(format!("{id}.onnx.json")))
}

/// Both model files on disk — the provider's eligibility test.
pub fn voice_ready(app: &AppHandle, id: &str) -> bool {
    if id.trim().is_empty() {
        return false;
    }
    let (onnx, json) = voice_paths(app, id);
    onnx.exists() && json.exists()
}

/* ---------- synthesis thread ---------- */

struct SynthReq {
    voice_id: String,
    onnx: PathBuf,
    json: PathBuf,
    text: String,
    reply: mpsc::Sender<Result<Vec<u8>, String>>,
}

static SYNTH_TX: OnceLock<mpsc::Sender<SynthReq>> = OnceLock::new();

fn synth_thread(rx: mpsc::Receiver<SynthReq>) {
    // (voice_id, model) — reload only when the voice changes.
    let mut loaded: Option<(String, piper_rs::Piper)> = None;
    for req in rx {
        let result = (|| {
            if loaded.as_ref().map(|(id, _)| id != &req.voice_id).unwrap_or(true) {
                let model = piper_rs::Piper::new(&req.onnx, &req.json)
                    .map_err(|e| format!("load {}: {e}", req.voice_id))?;
                loaded = Some((req.voice_id.clone(), model));
            }
            let (_, piper) = loaded.as_mut().expect("just loaded");
            let (samples, sample_rate) = piper
                .create(&req.text, false, None, None, None, None)
                .map_err(|e| format!("synthesize: {e}"))?;
            Ok(encode_wav_mono16(&samples, sample_rate))
        })();
        // Receiver gone = caller timed out / app shutting down; nothing to do.
        let _ = req.reply.send(result);
    }
}

/// Synthesize `text` with the given downloaded voice. BLOCKS on the reply —
/// callers wrap in `spawn_blocking` (same doctrine as local_tts).
pub fn synthesize(app: &AppHandle, voice_id: &str, text: &str) -> Result<Vec<u8>, String> {
    let (onnx, json) = voice_paths(app, voice_id);
    let tx = SYNTH_TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("piper-synth".into())
            .spawn(move || synth_thread(rx))
            .expect("spawn piper thread");
        tx
    });
    let (reply_tx, reply_rx) = mpsc::channel();
    tx.send(SynthReq {
        voice_id: voice_id.to_string(),
        onnx,
        json,
        text: text.to_string(),
        reply: reply_tx,
    })
    .map_err(|_| "piper thread gone".to_string())?;
    reply_rx.recv().map_err(|_| "piper thread died".to_string())?
}

/// f32 samples → 16-bit PCM mono WAV (44-byte RIFF header).
fn encode_wav_mono16(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let byte_rate = sample_rate * 2;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/* ---------- commands ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiperVoiceInfo {
    pub id: String,
    pub label: String,
    pub language: String,
    pub size_mb: u32,
    pub installed: bool,
}

#[tauri::command]
pub fn list_piper_voices(app: AppHandle) -> Vec<PiperVoiceInfo> {
    CATALOG
        .iter()
        .map(|e| PiperVoiceInfo {
            id: e.id.to_string(),
            label: e.label.to_string(),
            language: e.language.to_string(),
            size_mb: e.size_mb,
            installed: voice_ready(&app, e.id),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress<'a> {
    id: &'a str,
    received: u64,
    total: u64,
    phase: &'a str, // "downloading" | "done" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit_progress(app: &AppHandle, id: &str, received: u64, total: u64, phase: &str, error: Option<String>) {
    let _ = app.emit("piper-download", DownloadProgress { id, received, total, phase, error });
}

#[tauri::command]
pub async fn download_piper_voice(app: AppHandle, id: String) -> Result<(), String> {
    let entry = CATALOG
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("unknown voice: {id}"))?;

    let result = download_voice_files(&app, entry).await;
    match &result {
        Ok(()) => {
            emit_progress(&app, &id, 0, 0, "done", None);
            // First voice in = make it the selected one (never overrides a choice).
            crate::settings::set_piper_voice_if_empty(&app, &id);
        }
        Err(e) => emit_progress(&app, &id, 0, 0, "error", Some(e.clone())),
    }
    result
}

async fn download_voice_files(app: &AppHandle, entry: &CatalogEntry) -> Result<(), String> {
    let dir = voices_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    // Model downloads run minutes, not seconds — the synth client's 20s total
    // timeout would kill them; connect timeout only.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // Config first (tiny), then the model; progress tracks the model bytes.
    for ext in [".onnx.json", ".onnx"] {
        let url = hf_url(entry, ext);
        let final_path = dir.join(format!("{}{ext}", entry.id));
        let part_path = dir.join(format!("{}{ext}.part", entry.id));

        let res = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("download {}: HTTP {}", entry.id, res.status()));
        }
        let total = res.content_length().unwrap_or(0);
        let mut received: u64 = 0;
        let mut last_emit: u64 = 0;
        let mut file = std::fs::File::create(&part_path).map_err(|e| format!("create: {e}"))?;

        let mut stream = res;
        while let Some(chunk) = stream.chunk().await.map_err(|e| format!("stream: {e}"))? {
            file.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
            received += chunk.len() as u64;
            // Progress only for the big file, throttled to ~every 512KB.
            if ext == ".onnx" && received - last_emit >= 512 * 1024 {
                last_emit = received;
                emit_progress(app, entry.id, received, total, "downloading", None);
            }
        }
        drop(file);
        std::fs::rename(&part_path, &final_path).map_err(|e| format!("rename: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_piper_voice(app: AppHandle, id: String) -> Result<(), String> {
    let (onnx, json) = voice_paths(&app, &id);
    for p in [onnx, json] {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("remove: {e}"))?;
        }
    }
    crate::settings::clear_piper_voice_if(&app, &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_shape() {
        let wav = encode_wav_mono16(&[0.0, 0.5, -0.5, 1.0], 22050);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(wav.len(), 44 + 8); // header + 4 samples × 2 bytes
        // sample rate little-endian at offset 24
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 22050);
        // full-scale clamp
        assert_eq!(i16::from_le_bytes(wav[50..52].try_into().unwrap()), 32767);
    }

    /// Real inference — needs en_GB-alba-medium downloaded into app-data.
    /// Run: `cargo test piper_end_to_end -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn piper_end_to_end() {
        let repo_resources = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        std::env::set_var(ESPEAK_DATA_ENV, &repo_resources);
        let dir = PathBuf::from(std::env::var("APPDATA").unwrap())
            .join("com.vxrcel.companion-tts")
            .join("piper");
        let onnx = dir.join("en_GB-alba-medium.onnx");
        let json = dir.join("en_GB-alba-medium.onnx.json");
        assert!(onnx.exists() && json.exists(), "download the voice first");

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || synth_thread(rx));
        let (rtx, rrx) = mpsc::channel();
        tx.send(SynthReq {
            voice_id: "en_GB-alba-medium".into(),
            onnx,
            json,
            text: "The shadow garden speaks with a neural voice now.".into(),
            reply: rtx,
        })
        .unwrap();
        let wav = rrx.recv().unwrap().expect("synthesis");
        assert_eq!(&wav[..4], b"RIFF");
        assert!(wav.len() > 44 + 22050, "should be more than half a second of audio");
        println!("piper synthesized {} bytes of WAV", wav.len());
    }

    #[test]
    fn catalog_urls_are_wellformed() {
        for e in CATALOG {
            let url = hf_url(e, ".onnx");
            assert!(url.starts_with("https://huggingface.co/rhasspy/piper-voices/resolve/main/"));
            assert!(url.contains(e.id), "{url}");
            assert!(e.hf_dir.split('/').count() == 4, "{}", e.hf_dir);
        }
    }
}
