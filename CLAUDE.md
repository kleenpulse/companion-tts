# Companion TTS

Windows floating companion (Tauri v2) that tails Claude Code session transcripts
(`~/.claude/projects/**/*.jsonl`) and speaks Claude's output aloud.
ElevenLabs `eleven_flash_v2_5` primary, Mistral Voxtral TTS fallback, then two
keyless local providers: Piper neural (`piper_tts.rs`, in-process piper-rs =
ort + espeak-ng; voices downloaded to app-data `piper\` from rhasspy/piper-voices;
eligible only with a voice installed; inference on one dedicated hot thread) and
Windows on-device (WinRT `local_tts.rs`, always works). Settings migration keeps
`provider_order` ending …piper→windows; locals excluded from monthly chars.
Piper build needs `src-tauri/.cargo/config.toml` env pins (libclang + cmake pip
wheels, MSVC includes for bindgen) and bundles `resources/espeak-ng-data`
(espeak-ng is GPL-3 — copyleft applies if the app is ever distributed).

## Commands

- `npm run tauri dev` — run the app (needs Rust + MSVC Build Tools)
- `npm test` — vitest (transform/blurbs/queue)
- `cargo test` in `src-tauri/` — tailer/parser fixtures
- `node scripts/fake-session.mjs --interval 1500` — emit a fake session to narrate
  (flags: `--split-writes`, `--truncate-at N`, `--sessions 2`, `--loop`)
- `npm run bump patch|minor|major` — cut a release: refuses dirty tree / empty
  `[Unreleased]`, syncs package.json + tauri.conf.json + Cargo.toml + Cargo.lock,
  cuts CHANGELOG.md (bundled into the panel via `?raw` — the What's New card and
  settings changelog read it), commits `chore(release): vX.Y.Z`, tags. Never pushes.
- API keys: settings UI, or env `ELEVEN_LABS` / `MISTRAL_API_KEY`

## Architecture

Two static webview windows (`fab` 64×64 always-on-top + `panel` 380×660).
**Rust classifies, TS phrases**: `watcher.rs`→`tailer.rs`→`parser.rs` emit compact
`session-event`s (noise never crosses IPC); the fab window's `speech/engine.ts`
transforms, queues, and plays. The panel is a remote control over tauri events
(`engine-state` / `engine-cmd`). Synthesis is a Rust command (`synth.rs`, reqwest)
so keys stay native-side and CORS never applies. Synthesized bytes persist in
app-data `audio-cache\` (`audio_cache.rs`; keyed sha256 of provider|model|voice|text,
`_shared` scope for blurb/attention vocabulary, per-session dirs purged by
`hide_session`) — a hit skips the API, monthly chars, and breaker bookkeeping but
still emits `synth-used`. The 20Hz `viz-env` stream carries `utteranceId`+`frac`
so the panel's typewriter reveal (settings `typewriter`) tracks playback without
touching the 150ms-debounced engine-state. When the panel opens, the fab
window hides and an inline dial takes over (engine keeps running hidden — the
anti-throttling browser args make that safe).

**Attention alerts** (`attention.rs` + `speech/attention.ts`): the transcript is
silent while Claude Code waits on a permission prompt, so stall-guessing would
false-alarm on slow commands. Instead we install a Claude Code Notification hook
(`~/.claude/settings.json`, helper ps1 in app-data; original settings backed up
once to `settings.json.companion-bak`) that appends hook JSON to
`notifications.jsonl`, which Rust tails EOF-primed and emits as
`attention-event`s. Permission alerts arm a 2.5s grace window canceled by fresh
transcript activity; AskUserQuestion/ExitPlanMode are announced straight from
the transcript (they never fire the hook).

## Load-bearing invariants (violate = broken product)

- `additionalBrowserArgs` must keep wry's `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
  AND `--autoplay-policy=no-user-gesture-required`, IDENTICAL on both windows
  (tauri #11144). The boot chime is the canary.
- Windows are declared statically in `tauri.conf.json` — runtime window creation
  breaks transparency on Windows (tauri #12450). The fab window is resized ONLY
  by `windows::apply_fab_scale` (settings fabScale ≤3.0; UI speaks levels 1–10;
  suppressed, center-preserving) — the dial itself scales via CSS transform in
  `Fab.tsx`, and its canvases must back at dpr×fabScale (`pixelScale` prop) or
  the transform blurs them.
- Tailer: offset only ever advances past a complete `\n`; truncation resets to
  new EOF (never 0); unknown pre-existing files prime at EOF — history is never
  narrated. uuid LRU dedupes replays.
- Chime dedupes by `message.id`: the final thinking AND text lines of a turn
  both carry `stop_reason:"end_turn"` with the same msg id.
- Mojibake repair is a targeted table in `transform.ts` — a blanket latin1→utf8
  round-trip corrupts the correctly-encoded majority of transcripts. Never.
- Queue: prose is never auto-dropped (verbatim contract); only blurbs yield to
  backpressure. Playback is strictly in-order.
- One `<audio>` element for life — `createMediaElementSource` is once-per-element.

## House style

Graphite bench tokens + amethyst accent (`src/styles/globals.css`), Space Mono
uppercase micro-labels, hairline borders, elevation by `panel`→`raised` (no
shadows), spring `{stiffness:350, damping:30}`. The grainient conic ring appears
ONLY on the speaking FAB state.

Dark-native with a token-driven light variant: settings `theme`
("dark"|"light"|"system", `shared/theme.ts` sets `html[data-theme]`, both
windows). Only semantic tokens + `bench-700/500` flip — viz lens fields
(`bg-bench-950`), viz palettes, and the grainient ring stay dark in any theme
(additive ribbons need a dark ground).
