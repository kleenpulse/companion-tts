import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, defaultTestSettings, type EngineHarness } from "./testkit";

/**
 * Behaviour tests for the Engine, driven headlessly through the EngineIO seam.
 * These pin the invariants CLAUDE.md calls load-bearing — previously only the
 * shipped product could observe them.
 */

let h: EngineHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

describe("chime dedupe", () => {
  it("chimes once when the text line and turnEnd both carry the same msgId", async () => {
    h = await bootHarness();

    // The turn's text line arrives with end_turn → prose chunk with chimeAfter.
    h.text("A", "Done. The fix is in.", { msgId: "m1", stopReason: "end_turn" });
    // The thinking line's turnEnd carries the SAME msgId — must be a no-op.
    h.turnEnd("A", "m1");
    await h.settle();

    // No chime materializes until the prose finishes playing.
    expect(h.state().queue.filter((u) => u.kind === "chime")).toHaveLength(0);

    h.player.endCurrent(); // prose done → the chimeAfter chime splices in and plays
    await h.settle();
    expect(h.state().queue.filter((u) => u.kind === "chime")).toHaveLength(1);

    h.player.endCurrent(); // chime done
    await h.settle();
    expect(h.chimesSinceBoot()).toBe(1);

    // A replayed turnEnd for m1 (tailer replay) still adds nothing — 64-id memory.
    h.turnEnd("A", "m1");
    await h.settle();
    expect(h.state().queue.filter((u) => u.kind === "chime")).toHaveLength(1);
  });

  it("keeps one ring slot per msgId — a zero-chunk turn must not halve the memory", async () => {
    h = await bootHarness();

    // m0 takes one slot.
    h.turnEnd("A", "m0");
    // A no-speech turn (no alphanumerics survive the transform): zero chunks,
    // still ends the turn. Both the text path and enqueueChime record m1 —
    // one slot, not two.
    h.text("A", "...", { msgId: "m1", stopReason: "end_turn" });
    // 62 more distinct turn ends fill the 64-slot ring exactly (m0 + m1 + 62).
    for (let i = 1; i <= 62; i++) h.turnEnd("A", `d${i}`);

    // If m1 had eaten two slots, m0 would be evicted and chime again here.
    h.turnEnd("A", "m0");
    await h.settle();
    expect(h.state().queue.filter((u) => u.id === "chime:m0")).toHaveLength(1);
  });
});

describe("follow hysteresis", () => {
  it("steals follow only after 5s of quiet, and announces the switch", async () => {
    h = await bootHarness({
      sessions: [
        { sessionId: "A", projectSlug: "d--x-alpha", path: "", lastActivity: 0 },
        { sessionId: "B", projectSlug: "d--x-beta", path: "", title: "Beta work", lastActivity: 0 },
      ],
    });

    h.text("A", "first speakable wins");
    expect(h.followed()).toBe("A");

    await h.advance(3000);
    h.text("B", "too early, A is still fresh");
    expect(h.followed()).toBe("A");

    await h.advance(2001); // A now quiet for 5001ms
    h.text("B", "now A has gone quiet");
    expect(h.followed()).toBe("B");

    await h.settle();
    expect(h.spokenTexts()).toContain("now following Beta work.");
  });
});

describe("mute", () => {
  it("discards speech while muted; speaks again after unmute", async () => {
    h = await bootHarness();

    h.cmd({ cmd: "toggle-mute" });
    h.text("A", "muted words");
    h.attention("A", "Claude is waiting for your input");
    await h.advance(3000);
    expect(h.state().queue).toHaveLength(0);
    expect(h.spokenTexts()).toEqual([]);

    h.cmd({ cmd: "toggle-mute" });
    h.text("A", "audible again");
    await h.settle();
    expect(h.spokenTexts().length).toBeGreaterThan(0);
  });
});

describe("voice-switch announcement", () => {
  it("speaks the provider flip even before any session is followed", async () => {
    h = await bootHarness();

    h.io.push.settingsUpdated({
      settings: defaultTestSettings({
        providerOrder: ["mistral", "elevenlabs", "piper", "windows"],
      }),
      envKeys: { elevenlabs: false, mistral: false },
    });
    await h.settle();

    expect(h.followed()).toBeUndefined();
    expect(h.spokenTexts()).toContain("voice switched to mistral.");
  });
});

describe("provider boost", () => {
  it("speeds and lifts mistral, resets when another provider takes over", async () => {
    h = await bootHarness();
    expect(h.player.providerBoost).toEqual({ rate: 1, gain: 1 });

    h.io.push.synthUsed("mistral");
    expect(h.player.providerBoost.rate).toBeCloseTo(1.1);
    expect(h.player.providerBoost.gain).toBeCloseTo(1.3);

    h.io.push.synthUsed("piper");
    expect(h.player.providerBoost).toEqual({ rate: 1, gain: 1 });
  });
});

describe("provider-aware queue limits", () => {
  it("prefetches deeper once a local provider is serving", async () => {
    h = await bootHarness();

    h.io.push.synthUsed("windows");
    // Five one-chunk prose turns land back to back; synth calls fire
    // synchronously inside enqueue, before any promise resolves.
    for (let i = 0; i < 5; i++) h.text("A", `sentence number ${i} here`);
    expect(h.io.synthCalls.length).toBe(4); // cloud default would stop at 2
  });
});

describe("attention grace window", () => {
  it("dissolves a permission alert when the session moves on within 2.5s", async () => {
    h = await bootHarness();

    h.text("A", "narrating along");
    h.attention("A", "Claude needs your permission to use Bash");
    await h.advance(1000); // inside the grace window
    h.text("A", "fresh transcript activity"); // disarms the pending alert
    await h.advance(5000);

    expect(h.state().queue.some((u) => u.kind === "attention")).toBe(false);
    expect(h.spokenTexts().some((t) => t.includes("approval"))).toBe(false);
    // A dissolved alert never rings the attention cue either.
    expect(h.player.attentionPings).toBe(0);
  });

  it("speaks after 2.5s of silence, into the _shared cache scope", async () => {
    h = await bootHarness();

    h.attention("A", "Claude needs your permission to use Bash");
    await h.advance(2500);
    await h.settle();

    expect(h.state().queue.some((u) => u.kind === "attention")).toBe(true);
    const call = h.io.synthCalls.find((c) => c.text.includes("approval"));
    expect(call?.text).toBe("Claude needs your approval to run a command.");
    expect(call?.scope).toBe("_shared");
    // The distinct triple ping fired the instant the alert committed.
    expect(h.player.attentionPings).toBe(1);
  });

  it("rate limit covers the ping — a second alert within 20s stays silent", async () => {
    h = await bootHarness();

    h.attention("A", "Claude needs your permission to use Bash");
    await h.advance(2500);
    expect(h.player.attentionPings).toBe(1);

    h.attention("A", "Claude needs your permission to use Edit");
    await h.advance(2500);
    expect(h.player.attentionPings).toBe(1);
  });

  it("muted: no ping, no spoken alert", async () => {
    h = await bootHarness();

    h.cmd({ cmd: "toggle-mute" });
    h.attention("A", "Claude needs your permission to use Bash");
    await h.advance(2500);
    await h.settle();

    expect(h.player.attentionPings).toBe(0);
    expect(h.state().queue.some((u) => u.kind === "attention")).toBe(false);
  });
});
