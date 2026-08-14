# Changelog

All notable changes to Companion TTS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

Releases are cut with `npm run bump patch|minor|major` — it moves the
Unreleased section under a new version heading, syncs every version file,
commits, and tags.

## [Unreleased]

### Added

- Every voice change is announced aloud — in the *new* voice — unless the app
  is muted. Paste a working API key and you immediately hear "voice switched
  to elevenlabs" spoken by ElevenLabs itself: the announcement doubles as
  proof the key works. If a key is wrong, you hear the attempt fail over
  ("voice switched to on-device") instead of discovering it in a badge. The
  Tool blurbs toggle no longer silences these — only mute does.
- Alert delay is now a setting: a pill selector under General picks how long a
  permission alert waits before it *speaks* — Instant, 1.5s, 3s, or 5s. The ping
  still fires the moment the prompt appears in every case; the delay only holds
  the sentence back, and any transcript activity inside the window cancels it.
  Pick Instant to always hear the full alert, or 5s to be told only about the
  prompts you actually left sitting.
- Piper voice downloads can be canceled. An X sits beside the voice picker
  while a model transfers; under halfway it stops the download on the spot,
  and past halfway it asks first with an inline ✓ / ✗ — 30-odd megabytes in is
  a bad place for a misclick. Either way the partial file is deleted, so a
  canceled download leaves nothing behind.

### Changed

- The Primary pill row now shows the voice that will actually speak. Selecting
  a provider that can't serve (no key, no downloaded voice, rejected key) saves
  your choice but the pill visibly lands on the fallback, the picked pill
  shakes, and a banner explains what's missing — no more ElevenLabs highlighted
  while on-device does the talking. Your selection is remembered, never
  rewritten: the pill jumps back the moment the missing piece arrives. The
  footer's voice label follows the same truth.
- API key and voice-id fields commit on Enter as well as on focus loss.
- The Piper voice list tells downloaded voices apart at a glance: installed
  ones are accented and tagged "on disk", undownloaded ones are muted with
  their download size.
- The Piper voice download bar now scrubs smoothly and wears the signature
  magenta→violet→cyan gradient. It used to lurch: bytes were reported every
  512KB and the bar stepped between them. Progress is now sampled four times
  finer and a spring carries the fill and the percentage between samples, with
  a travelling highlight so a slow link still reads as moving. The gradient is
  anchored to the whole track, so the leading edge walks violet→magenta→cyan
  as the download advances. Before the download's size is known the bar sweeps
  instead of sitting at a dead zero.

### Fixed

- Pasting an API key now takes effect immediately. The panel used to keep
  showing the fallback as active until the next utterance happened to speak;
  now the switch is spoken and displayed the moment the key lands.
- A tripped provider (rejected key) is no longer silently resurrected by
  unrelated settings saves — only changing a key or re-picking the primary
  retries it, so a bad key can't cause a failed attempt on every fab-scale
  drag or theme flip.
- Settings can no longer be lost to a torn write. settings.json was overwritten
  in place from several threads at once (window moves, the monthly meter, panel
  edits), so a crash, shutdown, or racing writer mid-save could truncate it —
  and the next launch would read the wreckage as "no settings", silently
  resetting API keys, voice choices, and the FAB size, then burying the
  evidence on its first save. Saves now write to a temp file and rename into
  place (the same doctrine the audio cache always used), and a settings.json
  that fails to parse is quarantined to `settings.json.corrupt` for recovery
  instead of being replaced with defaults.
- A failed Piper voice download no longer fails in silence. It used to reset the
  row with no explanation and leave a half-written `.part` file in app-data that
  nothing ever cleaned up — invisible from the UI, and dead weight on disk. The
  reason now appears under the picker, and the partial is deleted.
- The "speaking: X" chip no longer keeps naming the previous voice after you
  pick a new primary. The chip reports the provider that last actually
  synthesized, and nothing cleared it on a switch — so it sat there naming the
  old voice until something spoke again, and because the chip only appears when
  it disagrees with your selection, it read as though the switch hadn't taken.
  It now clears on a primary change and returns the moment a real fallback
  happens.

## [0.5.2] - 2026-08-13

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
