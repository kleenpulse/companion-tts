import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, type EngineHarness } from "./testkit";

/**
 * Double-click row replay: the "replay" engine command re-speaks a settled
 * utterance at priority position, per the replayMode setting.
 */

let h: EngineHarness;

afterEach(() => h?.dispose());

/** Speak one text to completion so a settled row exists to replay. */
async function speakToDone(text: string): Promise<string> {
  h.text("A", text);
  await h.settle();
  h.player.endCurrent();
  await h.settle();
  const row = h.state().queue.find((q) => q.displayText.includes(text));
  expect(row?.status).toBe("done");
  return row!.id;
}

describe("replay command", () => {
  it("next: splices after the playing item, plays before the backlog", async () => {
    h = await bootHarness();
    const doneId = await speakToDone("first message here");

    h.text("A", "second message playing now");
    h.text("A", "third message waiting");
    await h.settle();
    expect(h.state().nowPlayingId).toContain("u2");

    h.cmd({ cmd: "replay", id: doneId, text: "first message here" });
    await h.settle();
    const ids = h.state().queue.map((q) => q.id);
    const replayIdx = ids.findIndex((id) => id.startsWith("replay:"));
    const thirdIdx = ids.findIndex((id) => id.startsWith("u3"));
    expect(replayIdx).toBeGreaterThan(-1);
    expect(replayIdx).toBeLessThan(thirdIdx);

    h.player.endCurrent(); // second finishes
    await h.settle();
    expect(h.state().nowPlayingId?.startsWith("replay:")).toBe(true);
    // Backlog untouched — third still pending, source row still done.
    expect(h.state().queue.find((q) => q.id.startsWith("u3"))?.status).not.toBe("skipped");
    expect(h.state().queue.find((q) => q.id === doneId)?.status).toBe("done");
  });

  it("interrupt: current becomes skipped, replay speaks next, backlog intact", async () => {
    h = await bootHarness({ settings: { replayMode: "interrupt" } });
    const doneId = await speakToDone("first message here");

    h.text("A", "second message playing now");
    h.text("A", "third message waiting");
    await h.settle();
    const playingId = h.state().nowPlayingId!;

    h.cmd({ cmd: "replay", id: doneId, text: "first message here" });
    await h.settle();
    expect(h.state().queue.find((q) => q.id === playingId)?.status).toBe("skipped");
    expect(h.state().nowPlayingId?.startsWith("replay:")).toBe(true);
    expect(h.state().queue.find((q) => q.id.startsWith("u3"))?.status).not.toBe("skipped");
  });

  it("interrupt-clear: wipes the pending backlog before speaking", async () => {
    h = await bootHarness({ settings: { replayMode: "interrupt-clear" } });
    const doneId = await speakToDone("first message here");

    h.text("A", "second message playing now");
    h.text("A", "third message waiting");
    h.text("A", "fourth message waiting");
    await h.settle();

    h.cmd({ cmd: "replay", id: doneId, text: "first message here" });
    await h.settle();
    for (const prefix of ["u2", "u3", "u4"]) {
      expect(h.state().queue.find((q) => q.id.startsWith(prefix))?.status).toBe("skipped");
    }
    expect(h.state().nowPlayingId?.startsWith("replay:")).toBe(true);
  });

  it("off: the command is a no-op", async () => {
    h = await bootHarness({ settings: { replayMode: "off" } });
    const doneId = await speakToDone("first message here");
    const spokenBefore = h.spokenTexts().length;

    h.cmd({ cmd: "replay", id: doneId, text: "first message here" });
    await h.settle();
    expect(h.spokenTexts().length).toBe(spokenBefore);
    expect(h.state().queue.some((q) => q.id.startsWith("replay:"))).toBe(false);
  });

  it("pending rows are inert — no duplicate playback", async () => {
    h = await bootHarness();
    h.text("A", "first message playing now");
    h.text("A", "second message waiting");
    await h.settle();
    const pending = h.state().queue.find((q) => q.id.startsWith("u2"));
    expect(pending?.status).not.toBe("done");

    h.cmd({ cmd: "replay", id: pending!.id, text: "second message waiting" });
    await h.settle();
    expect(h.state().queue.some((q) => q.id.startsWith("replay:"))).toBe(false);
  });

  it("unmutes and speaks when muted — explicit user action overrides mute", async () => {
    h = await bootHarness();
    const doneId = await speakToDone("first message here");

    h.cmd({ cmd: "toggle-mute" });
    await h.settle();
    expect(h.state().mode).toBe("muted");

    h.cmd({ cmd: "replay", id: doneId, text: "first message here" });
    await h.settle();
    expect(h.state().mode).not.toBe("muted");
    expect(h.state().nowPlayingId?.startsWith("replay:")).toBe(true);
  });

  it("id resolution speaks the full-fidelity engine text verbatim", async () => {
    h = await bootHarness();
    const doneId = await speakToDone("exact words matter here");
    const original = h.spokenTexts()[h.spokenTexts().length - 1];

    h.cmd({ cmd: "replay", id: doneId, text: "truncated panel copy…" });
    await h.settle();
    // Same text → same cache key in production; the panel's copy is ignored.
    expect(h.spokenTexts()[h.spokenTexts().length - 1]).toBe(original);
  });

  it("backfill fallback runs cmd.text through transformForSpeech", async () => {
    h = await bootHarness();
    h.cmd({ cmd: "replay", text: "**bold claim** with `inline code` here" });
    await h.settle();
    const last = h.spokenTexts()[h.spokenTexts().length - 1];
    expect(last).toBeDefined();
    expect(last).not.toContain("**");
    expect(last).not.toContain("`");
    expect(h.state().nowPlayingId?.startsWith("replay:")).toBe(true);
  });

  it("unknown (pruned) id falls back to the provided text", async () => {
    h = await bootHarness();
    h.cmd({ cmd: "replay", id: "u999#0", text: "fallback words spoken" });
    await h.settle();
    expect(h.spokenTexts().some((t) => t.includes("fallback words spoken"))).toBe(true);
  });
});
