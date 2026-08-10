# Contributing

Thanks for your interest! Issues and PRs are welcome — including the big one:
**macOS/Linux support** is the most-wanted feature and currently unowned.

## Dev setup

Prerequisites: Rust (MSVC toolchain), Node 20+, Visual Studio Build Tools 2022
with the Windows SDK.

```sh
npm install
# Piper's build needs machine-specific env pins:
#   copy src-tauri/.cargo/config.toml.example → src-tauri/.cargo/config.toml
#   and fix the paths (the example explains each one)
npm run tauri dev
```

To exercise the app without a real Claude Code session:

```sh
node scripts/fake-session.mjs --interval 1500
```

(flags: `--split-writes`, `--truncate-at N`, `--sessions 2`, `--loop`)

## Tests

- `npm test` — vitest: transform/blurbs/queue plus engine behaviour through
  `src/speech/testkit.ts`, a headless harness that boots a real Engine.
- `cargo test` (in `src-tauri/`) — tailer/parser fixtures, provider walk,
  tail core.

Both must be green before a PR. New engine behaviour should come with a
testkit-based test; new parser behaviour with a fixture.

## Architecture orientation

Read [`CLAUDE.md`](CLAUDE.md) (architecture + load-bearing invariants — the
"violate = broken product" list is real) and [`CONTEXT.md`](CONTEXT.md)
(domain glossary). The one-sentence version: **Rust classifies, TS phrases** —
`watcher.rs` → `tailer.rs` → `parser.rs` emit compact session events, and
`src/speech/engine.ts` transforms, queues, and plays them.

Two rules that surprise newcomers:

- `engine.ts` is node-clean: it must never import bus/theme/fabStore/Player as
  values. Wiring happens in `src/fab/engineInstance.ts`.
- Prose is never auto-dropped from the queue (verbatim contract); only blurbs
  yield to backpressure.

## Releases

Maintainer-only: `npm run bump patch|minor|major` cuts the changelog, syncs
versions, commits, and tags. Pushing the tag builds the installer via CI.
Keep user-visible changes in the `[Unreleased]` section of `CHANGELOG.md` —
it ships inside the app.
