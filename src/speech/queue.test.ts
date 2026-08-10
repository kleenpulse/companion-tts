import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Utterance } from "../shared/types";
import { audioMime, UtteranceQueue, type PlayerLike } from "./queue";

/** Fully controllable fake player: playback ends only when the test says so. */
class FakePlayer implements PlayerLike {
  playing: string | null = null;
  chimes = 0;
  private onEnded: (() => void) | null = null;

  playUrl(url: string, onEnded: () => void): void {
    this.playing = url;
    this.onEnded = onEnded;
  }
  chime(onDone: () => void): void {
    this.chimes += 1;
    this.playing = "chime";
    this.onEnded = onDone;
  }
  stop(): void {
    this.playing = null;
    this.onEnded = null;
  }
  endCurrent(): void {
    const cb = this.onEnded;
    this.playing = null;
    this.onEnded = null;
    cb?.();
  }
}

function utterance(id: string, over: Partial<Utterance> = {}): Utterance {
  return {
    id,
    kind: "prose",
    sessionId: "s",
    text: `text ${id}`,
    displayText: `text ${id}`,
    status: "queued",
    enqueuedAt: 0,
    ...over,
  };
}

describe("UtteranceQueue", () => {
  let player: FakePlayer;
  let synthCalls: string[];
  let resolvers: Array<(b: ArrayBuffer) => void>;
  let rejecters: Array<(e: unknown) => void>;
  let queue: UtteranceQueue;

  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    player = new FakePlayer();
    synthCalls = [];
    resolvers = [];
    rejecters = [];
    queue = new UtteranceQueue({
      synth: (text) => {
        synthCalls.push(text);
        return new Promise<ArrayBuffer>((res, rej) => {
          resolvers.push(res);
          rejecters.push(rej);
        });
      },
      player,
      onChange: vi.fn(),
      createUrl: () => `url:${synthCalls.length}`,
      revokeUrl: vi.fn(),
    });
  });

  it("discards enqueues while muted — the single mute policy", () => {
    queue.setMuted(true);
    queue.enqueue(utterance("a"));
    queue.enqueue(utterance("chime1", { kind: "chime", text: "" }));
    expect(queue.items).toHaveLength(0);
    expect(synthCalls).toEqual([]);

    // Unmuting does not resurrect anything — the speech was never queued.
    queue.setMuted(false);
    expect(queue.items).toHaveLength(0);
    queue.enqueue(utterance("b"));
    expect(synthCalls).toEqual(["text b"]);
  });

  it("prefetches ahead while playing — pipeline, not serial", async () => {
    queue.enqueue(utterance("a"));
    queue.enqueue(utterance("b"));
    queue.enqueue(utterance("c"));
    queue.enqueue(utterance("d"));
    // inflight cap 2: a and b synthesize immediately, c/d wait
    expect(synthCalls).toEqual(["text a", "text b"]);

    resolvers[0](new ArrayBuffer(1));
    await flush();
    // a plays; prefetch keeps ≤2 ahead in flight
    expect(player.playing).not.toBeNull();
    expect(synthCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("plays strictly in order — never leapfrogs an unsynthesized head", async () => {
    queue.enqueue(utterance("a"));
    queue.enqueue(utterance("b"));
    // b resolves FIRST — but a is the head, so nothing plays yet
    resolvers[1](new ArrayBuffer(1));
    await flush();
    expect(player.playing).toBeNull();
    resolvers[0](new ArrayBuffer(1));
    await flush();
    expect(player.playing).not.toBeNull();
  });

  it("walks past failed items without blocking", async () => {
    queue.enqueue(utterance("a"));
    queue.enqueue(utterance("b"));
    rejecters[0](new Error("provider down"));
    resolvers[1](new ArrayBuffer(1));
    await flush();
    expect(queue.items.find((u) => u.id === "a")?.status).toBe("failed");
    expect(player.playing).not.toBeNull();
    expect(queue.nowPlaying?.id).toBe("b");
    // failures stamp lastError + lastErrorAt so the panel can explain the queue
    expect(queue.lastError).toContain("provider down");
    expect(queue.lastErrorAt).toBeGreaterThan(0);
  });

  it("chimeAfter inserts a chime right after the prose finishes", async () => {
    queue.enqueue(utterance("a", { chimeAfter: true, msgId: "m1" }));
    resolvers[0](new ArrayBuffer(1));
    await flush();
    expect(queue.nowPlaying?.id).toBe("a");
    player.endCurrent();
    await flush();
    expect(player.chimes).toBe(1);
    player.endCurrent();
    expect(queue.items.find((u) => u.id === "chime:m1")?.status).toBe("done");
  });

  it("backpressure drops queued blurbs, never prose", () => {
    queue.enqueue(utterance("p1", { text: "x".repeat(1400) }));
    queue.enqueue(utterance("p2", { text: "y".repeat(1400) }));
    queue.enqueue(utterance("bl", { kind: "blurb", text: "editing 3 files" }));
    queue.enqueue(utterance("p3", { text: "z".repeat(300) }));
    const blurb = queue.items.find((u) => u.id === "bl");
    expect(blurb?.status).toBe("skipped");
    expect(queue.items.filter((u) => u.kind === "prose" && u.status !== "skipped").length).toBe(3);
  });

  it("skip stops the current item and advances", async () => {
    queue.enqueue(utterance("a"));
    queue.enqueue(utterance("b"));
    resolvers[0](new ArrayBuffer(1));
    resolvers[1](new ArrayBuffer(1));
    await flush();
    expect(queue.nowPlaying?.id).toBe("a");
    queue.skip();
    await flush();
    expect(queue.items.find((u) => u.id === "a")?.status).toBe("skipped");
    expect(queue.nowPlaying?.id).toBe("b");
  });

  it("pause halts playback but synthesis continues; resume plays", async () => {
    queue.setPaused(true);
    queue.enqueue(utterance("a"));
    expect(synthCalls).toEqual(["text a"]); // synth proceeds while paused
    resolvers[0](new ArrayBuffer(1));
    await flush();
    expect(player.playing).toBeNull();
    queue.setPaused(false);
    queue.schedule();
    expect(player.playing).not.toBeNull();
  });

  it("mute clears everything pending", async () => {
    queue.enqueue(utterance("a"));
    queue.enqueue(utterance("b"));
    queue.setMuted(true);
    expect(queue.items.every((u) => u.status === "skipped" || u.status === "failed")).toBe(true);
    // late-resolving synth for a muted item must not resurrect it
    resolvers[0](new ArrayBuffer(1));
    await flush();
    expect(player.playing).toBeNull();
  });

  it("chimes skip synthesis entirely", () => {
    queue.enqueue(utterance("c1", { kind: "chime", text: "" }));
    expect(synthCalls).toEqual([]);
    expect(player.chimes).toBe(1);
  });
});

describe("audioMime", () => {
  it("sniffs RIFF as WAV (the on-device provider's container)", () => {
    const wav = new TextEncoder().encode("RIFF....WAVEfmt ").buffer;
    expect(audioMime(wav)).toBe("audio/wav");
  });

  it("defaults everything else to MP3 (cloud providers)", () => {
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer;
    expect(audioMime(mp3)).toBe("audio/mpeg");
  });
});
