# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/kleenpulse/companion-tts/security/advisories/new)** —
or email `ellumainc@gmail.com` if you prefer.

Please do not open public issues for security reports.

## Scope notes

Things worth extra scrutiny in this app:

- API keys: stored in the app-data settings file and used only from the Rust
  side (`synth.rs`). Any path that could leak a key into a webview, log, or
  transcript is a vulnerability.
- The Claude Code Notification hook: the installer writes a hook entry into
  `~/.claude/settings.json` (original backed up to `settings.json.companion-bak`)
  and a helper script into app-data. Anything that could make that hook
  execute untrusted input is a vulnerability.
- Transcript handling: the app tails and parses `~/.claude/projects/**/*.jsonl`.
  Parser crashes on malformed input are bugs; code execution from transcript
  content is a vulnerability.
