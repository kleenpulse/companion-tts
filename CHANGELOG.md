# Changelog

All notable changes to Companion TTS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

Releases are cut with `npm run bump patch|minor|major` — it moves the
Unreleased section under a new version heading, syncs every version file,
commits, and tags.

## [Unreleased]

### Fixed

- Permission prompts ("Allow this bash command?") now actually call for your
  attention. They were nearly always silent: attention alerts rode Claude Code's
  `Notification` hook, which is gated behind a presence check — sit at the
  keyboard and Claude Code decides you already saw the prompt and never sends
  one. Only plan approvals and questions got through, because those are read
  from the transcript. Companion now installs Claude Code's `PermissionRequest`
  hook, which fires as the prompt renders and is not presence-gated. Existing
  installs pick it up on the next launch.

### Changed

- A permission alert pings the moment the prompt appears instead of waiting out
  the grace window; only the spoken sentence waits, and it now waits 1.5s rather
  than 2.5s. Answering fast costs you one short ping instead of being narrated
  after the fact. Consecutive prompts each get a ping, while the spoken alert
  stays rate limited (20s → 10s) so a run of approvals doesn't turn into a
  monologue.

## [0.5.1] - 2026-08-12

### Changed

- Mistral Voxtral now plays noticeably louder — its per-provider gain lift went
  from 1.3x to 1.85x, closing the volume gap against ElevenLabs at the same
  volume setting. A peak limiter was added to the playback chain so the extra
  gain rides the peaks instead of clipping.

### Fixed

- The What's New card no longer pushes the transcript feed and transport
  controls off the bottom of the panel. It now floats over the session list as
  a dismissible overlay with its own scroll, so a long release announcement
  can't crowd out the rest of the panel. The panel's minimum height also rose
  to 560px, which is what the feed and controls actually need.

## [0.5.0] - 2026-08-12

### Added

- A setup banner under the primary voice picker explains why a chosen voice
  can't speak yet — missing API key (and which env var works instead) or no
  Piper voice downloaded — and clears itself the moment the gap is filled.
- The Voice header shows a "speaking: X" chip whenever the voice actually
  playing differs from your selection (previously only visible with two API
  keys configured).
- `scripts/demo-session.mjs` — a camera-ready ~90 second scripted session for
  marketing recordings: narration, blurbs, plan approval, a question, a
  permission alert, and the chime.

### Fixed

- Picking a primary voice no longer snaps back to on-device. The auto-switcher
  used to rewrite your saved order the instant the chosen provider was missing
  its API key or Piper voice — even the "voice switched" announcement itself
  could trigger it. It now steps in only after three consecutive real failures;
  an unconfigured or auth-failed primary keeps your selection while speech
  quietly falls back, and fixing the key restores your choice automatically.

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
