import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, type EngineHarness } from "./testkit";

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
  });
});
