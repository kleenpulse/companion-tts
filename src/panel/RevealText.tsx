import { useEffect, useMemo, useState } from "react";
import { onVizEnv } from "../shared/bus";
import { revealEdge } from "../shared/format";
import type { VizEnv } from "../shared/types";

/**
 * Per-character typewriter for the row being spoken, revealed in step with
 * playback (ported from admin_shadow-garden's BriefTranscript, char mode).
 * No per-word timestamps exist from the TTS, so the reveal maps linearly
 * against duration via the viz-env `frac` stream (20Hz from the fab window),
 * with a ~1-unit lead so text lands just before it's heard.
 */

// One module-level subscription feeds every mount (at most one row typewrites
// at a time, but this also lets a row mounting mid-utterance — the engine
// state that creates it is 150ms debounced — start at the current edge
// instead of 0) and avoids listen/unlisten churn on row transitions.
let lastEnv: VizEnv | null = null;
const subscribers = new Set<(env: VizEnv) => void>();
void onVizEnv((env) => {
  lastEnv = env;
  for (const cb of subscribers) cb(env);
});

export function RevealText({ id, text }: { id: string; text: string }) {
  // Array.from is surrogate-pair safe — emoji never split mid-glyph.
  const units = useMemo(() => Array.from(text), [text]);
  const [shown, setShown] = useState(() =>
    lastEnv?.utteranceId === id ? revealEdge(lastEnv.frac ?? 0, units.length, false) : 0
  );

  useEffect(() => {
    const onEnv = (env: VizEnv) => {
      if (env.utteranceId !== id) return; // idle-zero envs never reset the edge
      // Monotonic latch: frac jitter can't un-reveal; skips settle via unmount.
      setShown((s) => Math.max(s, revealEdge(env.frac ?? 0, units.length, false)));
    };
    subscribers.add(onEnv);
    return () => {
      subscribers.delete(onEnv);
    };
  }, [id, units.length]);

  // Memoized on the integer edge: frames where it hasn't moved return the
  // same element tree, so React skips reconciling hundreds of spans.
  return useMemo(
    () => (
      <>
        {units.map((ch, i) => (
          <span key={i} className={`brief-char${i < shown ? " is-shown" : ""}`}>
            {ch}
          </span>
        ))}
      </>
    ),
    [units, shown]
  );
}
