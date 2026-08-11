# Changelog

All notable changes to Companion TTS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

Releases are cut with `npm run bump patch|minor|major` — it moves the
Unreleased section under a new version heading, syncs every version file,
commits, and tags.

## [Unreleased]

## [0.4.1] - 2026-08-11

### Changed

- New app icon — the strand dial, everywhere: installer, taskbar, tray,
  Start menu, and the README.

## [0.4.0] - 2026-08-10

### Added

- Double-click a transcript row to speak it again — jumps the queue. The
  row highlights in place while it replays (no duplicate feed entry), the
  behavior is configurable in settings (speak next / interrupt current /
  interrupt + clear queue / off), and double-clicking while muted unmutes
  first. Rows still waiting their turn are untouched.
- Attention alerts now ring a distinct urgent triple ping the instant they
  fire — clearly different from the turn-complete chime — with the spoken
  alert following as before.
- The panel × now quits the app behind a confirmation dialog (with an
  "always ask" checkbox, also toggleable in settings); a new − button
  collapses to the floating dial, which × used to do.

### Changed

- Groundwork for macOS/Linux ports: the code now compiles on all three
  platforms (Windows-only voice gated behind the platform, CI proves the
  cross-compile). Behavior on Windows is unchanged.

### Fixed

- Piper voices now play at the same loudness as the cloud providers: raw
  synthesis output is peak-normalized before encoding, and previously cached
  quiet Piper audio re-synthesizes automatically.
- Mistral (Voxtral) voices play at 1.1x by default to match the other
  providers' pace — layered over your rate setting, which stays untouched.
- Mistral voices also get a volume lift to match ElevenLabs' loudness —
  the turn-complete chime is unaffected.

## [0.3.0] - 2026-08-10

### Added

- Open-source release: GPL-3.0 license, third-party attributions, contributor
  docs, GitHub CI, and a release pipeline that builds the installer on tag push.

## [0.2.0] - 2026-08-09

### Added

- Version tracker: app version in the panel footer, a one-time What's New card
  after each update, and a full changelog browser in settings.
- Release pipeline: `npm run bump` syncs package.json, tauri.conf.json,
  Cargo.toml and Cargo.lock, cuts this changelog, commits and tags the release.

## [0.1.0] - 2026-08-09

### Added

- Floating companion dial (64px, always-on-top) that narrates Claude Code
  sessions aloud by tailing `~/.claude/projects/**/*.jsonl`.
- Provider chain with automatic fallback and health-aware switching:
  ElevenLabs → Mistral Voxtral → Piper neural (offline) → Windows on-device.
- Piper neural voices: in-process inference, downloadable voice catalog,
  no API key required.
- Attention alerts via Claude Code Notification hook — spoken heads-up when a
  session waits on permission prompts, questions, or plan approval.
- Control panel: session list, live transcript feed with typewriter reveal,
  transport controls, provider and voice configuration.
- Audio visualizers (waves and strands), dark/light/system theme, resizable
  dial (10 levels), global shortcuts for mute and pause.
- Synthesized-audio cache keyed by provider/model/voice/text — repeat phrases
  skip the API and the monthly character count.
