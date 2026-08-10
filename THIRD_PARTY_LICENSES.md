# Third-party licenses

Companion TTS is licensed under [GPL-3.0-only](LICENSE). That license choice is
driven by a dependency: the app compiles in and bundles parts of **espeak-ng**,
which is GPL-3.0, so distributed builds are a GPL-3 combined work.

## Bundled / compiled into the app

| Component | License | Role |
|-----------|---------|------|
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) | **GPL-3.0-or-later** | Phonemization for Piper neural TTS. Compiled into the binary via `espeak-rs-sys`, and its data files ship in the installer at `resources/espeak-ng-data` ([COPYING](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING)). |
| [piper-rs](https://crates.io/crates/piper-rs) | MIT | Piper neural TTS inference (Rust). |
| [espeak-rs](https://crates.io/crates/espeak-rs) / `espeak-rs-sys` | MIT | Rust bindings that build and wrap espeak-ng. |
| [ort](https://crates.io/crates/ort) (ONNX Runtime bindings) | MIT OR Apache-2.0 | Neural inference backend for Piper voices. ONNX Runtime itself is [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE). |
| [Tauri](https://tauri.app) 2 + official plugins | Apache-2.0 OR MIT | Application framework. |
| [windows](https://crates.io/crates/windows) crate | MIT OR Apache-2.0 | WinRT bindings for the on-device Windows voice. |
| Geist Sans / Geist Mono / Space Mono (via Fontsource) | SIL OFL 1.1 | UI typefaces. |

Full Rust and npm dependency trees are declared in
[`src-tauri/Cargo.toml`](src-tauri/Cargo.toml) and [`package.json`](package.json);
all other dependencies are under permissive licenses (MIT, Apache-2.0, ISC, or
similar).

## Downloaded at runtime (not bundled)

- **Piper voices** are downloaded on demand from
  [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) into the
  app's data directory. Each voice model carries its own license inherited from
  its training dataset — check the per-voice `MODEL_CARD` on Hugging Face
  before redistributing a voice.

## Cloud providers (optional, user-supplied keys)

ElevenLabs and Mistral (Voxtral) synthesis run against their public APIs under
the user's own account and their respective terms of service. No provider code
or models are bundled.

## Corresponding source

The complete corresponding source for distributed builds is this repository at
the tag matching the release version.
