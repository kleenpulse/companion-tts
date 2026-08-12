# Domain glossary

Terms with a precise meaning in this codebase. Architecture reviews and new
code should use these names; sharpen or extend this file when a term shifts.

## Speech pipeline (TS, fab window)

- **Engine** — the product's brain (`src/speech/engine.ts`). Routes session
  events through transform/blurbs into the Utterance queue, owns follow logic,
  mute/pause, and state broadcast. Constructed only at a composition root
  (`src/fab/engineInstance.ts` in prod, `src/speech/testkit.ts` in tests) via
  `EngineDeps`; the module itself has no import-time side effects.
- **EngineIO** — the engine's IPC port, deliberately shape-congruent with
  `shared/bus.ts` exports so production wiring is `io: bus` with zero adapter
  code. The seam every headless test drives the engine through.
- **Utterance** — one queued unit of speech (prose chunk, blurb, error,
  attention phrase, or chime). Prose is under the verbatim contract: never
  auto-dropped; only blurbs yield to backpressure.
- **Blurb** — short interstitial tool narration ("editing 3 files"). App
  vocabulary, cached in the `_shared` scope, droppable garnish.
- **Follow** — which session is being narrated. Auto mode uses 5s hysteresis;
  pinned mode bypasses it. Attention outranks follow.
- **Attention** — "Claude needs you" alerts. Permission-style ones arm a 2.5s
  grace window canceled by fresh transcript activity.
- **Chime** — the turn-complete cue, deduped per `msgId` (thinking and text
  lines of one turn both carry `end_turn`).

## Synthesis (Rust)

- **Provider** — one TTS backend described by a descriptor in `synth.rs`'s
  `PROVIDERS` table: id, Cloud/Local kind, billed flag, eligibility predicate,
  cache inputs. The only match on provider ids lives in `dispatch()`.
- **Plan / fallback walk** — the pure function selecting eligible, un-tripped
  providers from `provider_order`; the synthesize command consumes its output.
- **Breaker** — per-provider failure state: `permanently_failed` (cloud auth
  401/403, process lifetime) and consecutive-failure counts driving the
  auto-switch after 3 primary failures. Only that 3-strike case rewrites
  `provider_order`; an unconfigured or auth-tripped primary is skipped for
  free by the walk and the panel's "speaking:" badge shows the divergence
  instead.

## Tailing (Rust)

- **Tail / TailCursor** — the pure offset machine (`src-tauri/src/tail.rs`):
  offset only advances past a complete `\n`, truncation resets to the new EOF
  (never 0), unknown pre-existing files prime at EOF so history is never
  narrated. Shared by the transcript tailer, the attention tailer, and
  backfill.
