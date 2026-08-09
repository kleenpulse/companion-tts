import type { ProviderId, SynthHealth, SynthReason } from "../shared/types";

/** A degraded verdict older than this is stale — the queue has moved on. */
export const HEALTH_WINDOW_MS = 30_000;

/**
 * Turn synth.rs's error strings into something a human can act on.
 * Shapes produced Rust-side (see synth.rs):
 *   "all-providers-failed: elevenlabs auth 401 Unauthorized"
 *   "all-providers-failed: elevenlabs 429: {...concurrency...}"
 *   "all-providers-failed: mistral network: <reqwest msg>"
 *   "all-providers-failed: elevenlabs 401: {...quota_exceeded...}"
 *   "all-providers-failed: no provider configured"
 */
export function categorizeSynthError(raw: string): { reason: SynthReason; provider?: ProviderId } {
  const msg = raw.toLowerCase();
  const provider: ProviderId | undefined = msg.includes("elevenlabs")
    ? "elevenlabs"
    : msg.includes("mistral")
      ? "mistral"
      : msg.includes("piper")
        ? "piper"
        : msg.includes("windows")
          ? "windows"
          : undefined;

  let reason: SynthReason;
  if (msg.includes("no provider configured")) reason = "no API key";
  else if (msg.includes("quota") || msg.includes("credit") || msg.includes("insufficient"))
    reason = "out of credits";
  else if (/auth 40[13]/.test(msg)) reason = "key rejected";
  else if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too_many"))
    reason = "rate limited";
  else if (msg.includes("network") || msg.includes("timed out") || msg.includes("timeout"))
    reason = "network error";
  else reason = "provider error";

  return { reason, provider };
}

export function synthHealthOf(
  lastError: string | null,
  lastErrorAt: number,
  now: number = Date.now()
): SynthHealth {
  if (!lastError || now - lastErrorAt > HEALTH_WINDOW_MS) return { state: "ok" };
  return { state: "degraded", ...categorizeSynthError(lastError) };
}
