# Changelog

All notable changes to Companion TTS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

Releases are cut with `npm run bump patch|minor|major` — it moves the
Unreleased section under a new version heading, syncs every version file,
commits, and tags.

## [Unreleased]

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
