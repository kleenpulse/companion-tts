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
      plannedProvider: "mistral",
    });
    await h.settle();

    expect(h.followed()).toBeUndefined();
    expect(h.spokenTexts()).toContain("voice switched to mistral.");
  });

  it("forgets the last-used voice on a primary flip", async () => {
    h = await bootHarness({
      settings: { providerOrder: ["piper", "elevenlabs", "mistral", "windows"] },
    });

    // Mistral served last — the panel's "speaking: X" chip reads this.
    h.io.push.synthUsed("mistral");
    await h.settle();
    expect(h.state().activeProvider).toBe("mistral");

    // Pick a new primary: the old voice is history, not a live fallback.
    h.io.push.settingsUpdated({
      settings: defaultTestSettings({
        providerOrder: ["elevenlabs", "mistral", "piper", "windows"],
      }),
      envKeys: { elevenlabs: false, mistral: false },
      plannedProvider: "elevenlabs",
    });
    await h.settle();
    expect(h.state().activeProvider).toBeUndefined();

    // …and it comes back the moment something actually falls back again.
    h.io.push.synthUsed("mistral");
    await h.settle();
    expect(h.state().activeProvider).toBe("mistral");
  });

  it("announces when a pasted key changes the plan head without a primary flip", async () => {
    h = await bootHarness();
    h.io.push.synthUsed("windows");
    await h.settle();
    expect(h.state().activeProvider).toBe("windows");

    // Same providerOrder, new key — only the plan head moves.
    h.io.push.settingsUpdated({
      settings: defaultTestSettings({ keys: { elevenlabs: "sk_new", mistral: "" } }),
      envKeys: { elevenlabs: false, mistral: false },
      plannedProvider: "elevenlabs",
    });
    await h.settle();

    expect(h.spokenTexts()).toContain("voice switched to elevenlabs.");
    expect(h.state().activeProvider).toBeUndefined();
  });

  it("does not announce at boot", async () => {
    h = await bootHarness();
    await h.settle();
    expect(h.spokenTexts()).toEqual([]);
  });

  it("stays silent when an unrelated save leaves the plan head unchanged", async () => {
    h = await bootHarness();
    h.io.push.settingsUpdated({
      settings: defaultTestSettings({ fabScale: 2 }),
      envKeys: { elevenlabs: false, mistral: false },
      plannedProvider: "windows",
    });
    await h.settle();
    expect(h.spokenTexts()).toEqual([]);
  });

  it("announces the actual fallback when synthesis lands elsewhere, once", async () => {
    h = await bootHarness();
    h.io.push.settingsUpdated({
      settings: defaultTestSettings({ keys: { elevenlabs: "sk_bad", mistral: "" } }),
      envKeys: { elevenlabs: false, mistral: false },
      plannedProvider: "elevenlabs",
    });
    await h.settle();
    expect(h.spokenTexts()).toContain("voice switched to elevenlabs.");

    // The announcement itself 401s Rust-side; windows ends up serving it.
    h.io.push.synthUsed("windows");
    await h.settle();
    const fallbackCount = () =>
      h!.spokenTexts().filter((t) => t === "voice switched to on-device.").length;
    expect(fallbackCount()).toBe(1);

    // Repeats of the same landing spot stay silent.
    h.io.push.synthUsed("windows");
    await h.settle();
    expect(fallbackCount()).toBe(1);
  });

  it("is silenced by mute", async () => {
    h = await bootHarness();
    h.cmd({ cmd: "toggle-mute" });
    h.io.push.settingsUpdated({
      settings: defaultTestSettings(),
      envKeys: { elevenlabs: false, mistral: false },
      plannedProvider: "piper",
    });
    await h.settle();
    expect(h.spokenTexts()).toEqual([]);
  });

  it("announces even with tool blurbs toggled off", async () => {
    const noBlurbs = {
      prose: true,
      blurbs: false,
      errors: true,
      chime: true,
      attention: true,
    };
    h = await bootHarness({ settings: { features: noBlurbs } });
    h.io.push.settingsUpdated({
      settings: defaultTestSettings({ features: noBlurbs }),
      envKeys: { elevenlabs: false, mistral: false },
      plannedProvider: "mistral",
    });
    await h.settle();
    expect(h.spokenTexts()).toContain("voice switched to mistral.");
  });
});

describe("provider boost", () => {
  it("speeds and lifts mistral, resets when another provider takes over", async () => {
    h = await bootHarness();
    expect(h.player.providerBoost).toEqual({ rate: 1, gain: 1 });

    h.io.push.synthUsed("mistral");
    expect(h.player.providerBoost.rate).toBeCloseTo(1.1);
    expect(h.player.providerBoost.gain).toBeCloseTo(1.85);

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
  it("pings the instant the prompt lands, before any grace window", async () => {
    h = await bootHarness();

    h.attention("A", "Claude needs your permission to use Bash");
    await h.advance(0);

    // The prompt is already on screen — the cue must not wait on the window.
    expect(h.player.attentionPings).toBe(1);
    expect(h.state().queue.some((u) => u.kind === "attention")).toBe(false);
  });

  it("dissolves the spoken alert when the session moves on — the ping stands", async () => {
    h = await bootHarness();

    h.text("A", "narrating along");
    h.attention("A", "Claude needs your permission to use Bash");
    await h.advance(1000); // inside the grace window
    h.text("A", "fresh transcript activity"); // disarms the pending alert
    await h.advance(5000);

    expect(h.state().queue.some((u) => u.kind === "attention")).toBe(false);
    expect(h.spokenTexts().some((t) => t.includes("approval"))).toBe(false);
    // Answering fast costs one ping, not a narration after the fact.
    expect(h.player.attentionPings).toBe(1);
  });

  it("speaks after 1.5s of silence, into the _shared cache scope", async () => {
    h = await bootHarness();

    h.attention("A", "Claude needs your permission to use Bash");
    await h.advance(1500);
    await h.settle();

    expect(h.state().queue.some((u) => u.kind === "attention")).toBe(true);
    const call = h.io.synthCalls.find((c) => c.text.includes("approval"));
    expect(call?.text).toBe("Claude needs your approval to run a command.");
    expect(call?.scope).toBe("_shared");
    expect(h.player.attentionPings).toBe(1); // no second ping when it commits
  });

  it("pings every prompt in a run; only the narration is rate limited", async () => {
    h = await bootHarness();

    h.attention("A", "Claude needs your permission to use Bash");
    await h.advance(1500);
    await h.settle();
    expect(h.player.attentionPings).toBe(1);
    expect(h.io.synthCalls.filter((c) => c.text.includes("approval"))).toHaveLength(1);

    // Approve, next prompt three seconds later: still worth looking up for.
    h.attention("A", "Claude needs your permission to use Edit");
    await h.advance(1500);
    await h.settle();
    expect(h.player.attentionPings).toBe(2);
    // …but not worth a second sentence inside the rate-limit window.
    expect(h.io.synthCalls.filter((c) => c.text.includes("approval"))).toHaveLength(1);
  });

  it("collapses a same-instant burst into one ping", async () => {
    h = await bootHarness();

    // One turn, three tools, three PermissionRequest hooks back to back.
    h.attention("A", "Claude needs your permission to use Bash");
    h.attention("A", "Claude needs your permission to use Write");
    h.attention("A", "Claude needs your permission to use Edit");
    await h.advance(0);

    expect(h.player.attentionPings).toBe(1);
  });

  it("honors a longer window from settings", async () => {
    h = await bootHarness({ settings: { attentionDelayMs: 5000 } });

    h.attention("A", "Claude needs your permission to use Bash");
    await h.advance(1500);
    await h.settle();
    expect(h.player.attentionPings).toBe(1); // the cue never waits
    expect(h.state().queue.some((u) => u.kind === "attention")).toBe(false);

    await h.advance(3500);
    await h.settle();
    expect(h.state().queue.some((u) => u.kind === "attention")).toBe(true);
  });

  it("Instant: speaks before a transcript event can disarm it", async () => {
    h = await bootHarness({ settings: { attentionDelayMs: 0 } });

    h.attention("A", "Claude needs your permission to use Bash");
    h.text("A", "the tool result comes straight back"); // would disarm a window
    await h.settle();

    expect(h.player.attentionPings).toBe(1);
    expect(h.spokenTexts()).toContain("Claude needs your approval to run a command.");
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
