import type { Utterance } from "../shared/types";

/**
 * Utterance queue with a pipelined prefetch: synthesize N+1..N+depth while N
 * plays, so audio flows nearly gapless after the first utterance.
 */

export interface PlayerLike {
  playUrl(url: string, onEnded: () => void, onError: (e: unknown) => void): void;
  chime(onDone: () => void): void;
  stop(): void;
}

export interface QueueDeps {
  synth(text: string, u: Utterance): Promise<ArrayBuffer>;
  player: PlayerLike;
  onChange(): void;
  createUrl?(buf: ArrayBuffer): string;
  revokeUrl?(url: string): void;
}

const PREFETCH_DEPTH = 2;
const MAX_INFLIGHT = 2; // ElevenLabs free-tier concurrency limit
const MAX_QUEUE_CHARS = 2500;
const DONE_KEEP = 50;

/** Cloud providers return MP3; the on-device provider returns WAV ("RIFF"). */
export function audioMime(buf: ArrayBuffer): string {
  const head = new Uint8Array(buf.slice(0, 4));
  const isWav = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
  return isWav ? "audio/wav" : "audio/mpeg";
}

export class UtteranceQueue {
  items: Utterance[] = [];
  paused = false;
  muted = false;
  nowPlaying: Utterance | null = null;
  lastError: string | null = null;
  lastErrorAt = 0;

  private inflight = 0;
  private createUrl: (buf: ArrayBuffer) => string;
  private revokeUrl: (url: string) => void;

  constructor(private deps: QueueDeps) {
    this.createUrl =
      deps.createUrl ??
      ((buf) => URL.createObjectURL(new Blob([buf], { type: audioMime(buf) })));
    this.revokeUrl = deps.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  get queuedChars(): number {
    return this.items
      .filter((u) => u.status === "queued" || u.status === "synthesizing" || u.status === "ready")
      .reduce((n, u) => n + u.text.length, 0);
  }

  enqueue(u: Utterance): void {
    this.items.push(u);
    // Backpressure: blurbs are droppable garnish; prose is the verbatim contract.
    if (this.queuedChars > MAX_QUEUE_CHARS) {
      const victim = this.items.find((i) => i.kind === "blurb" && i.status === "queued");
      if (victim) victim.status = "skipped";
    }
    this.schedule();
  }

  schedule(): void {
    this.prune();
    this.tryPlayHead();

    // Prefetch ahead of the playhead.
    const ahead = this.items.filter(
      (u) => u.status === "synthesizing" || (u.status === "ready" && u !== this.nowPlaying)
    ).length;
    let budget = PREFETCH_DEPTH - ahead;
    for (const u of this.items) {
      if (budget <= 0 || this.inflight >= MAX_INFLIGHT) break;
      if (u.status !== "queued") continue;
      if (u.kind === "chime") {
        u.status = "ready";
        budget -= 1;
        continue;
      }
      u.status = "synthesizing";
      this.inflight += 1;
      budget -= 1;
      this.deps
        .synth(u.text, u)
        .then((buf) => {
          // Skipped/stopped while in flight — a late result must not resurrect it.
          if (u.status !== "synthesizing") return;
          u.audioUrl = this.createUrl(buf);
          u.status = "ready";
        })
        .catch((e) => {
          if (u.status !== "synthesizing") return;
          u.status = "failed";
          this.lastError = String(e);
          this.lastErrorAt = Date.now();
        })
        .finally(() => {
          this.inflight -= 1;
          this.schedule();
          this.deps.onChange();
        });
    }

    // A chime marked ready inside the loop can be the head — check again.
    this.tryPlayHead();
    this.deps.onChange();
  }

  /** Play strictly in order; never leapfrog an unsynthesized item. */
  private tryPlayHead(): void {
    if (this.paused || this.muted || this.nowPlaying) return;
    const head = this.items.find(
      (u) => u.status === "queued" || u.status === "synthesizing" || u.status === "ready"
    );
    if (head?.status === "ready") this.play(head);
  }

  private play(u: Utterance): void {
    this.nowPlaying = u;
    u.status = "playing";
    const done = () => this.finish(u, "done");
    if (u.kind === "chime") {
      this.deps.player.chime(done);
    } else if (u.audioUrl) {
      this.deps.player.playUrl(u.audioUrl, done, (e) => {
        this.lastError = String(e);
        this.lastErrorAt = Date.now();
        this.finish(u, "failed");
      });
    } else {
      this.finish(u, "failed");
    }
    this.deps.onChange();
  }

  private finish(u: Utterance, status: "done" | "failed" | "skipped"): void {
    if (u.status === "done" || u.status === "failed" || u.status === "skipped") {
      return; // already settled — a stale element handler must not double-finish
    }
    if (u.audioUrl) {
      this.revokeUrl(u.audioUrl);
      u.audioUrl = undefined;
    }
    u.status = status;
    if (this.nowPlaying === u) this.nowPlaying = null;
    if (status === "done" && u.chimeAfter) {
      // The chime belongs immediately after its prose — insert at the playhead.
      const idx = this.items.indexOf(u);
      this.items.splice(idx + 1, 0, {
        id: `chime:${u.msgId ?? u.id}`,
        kind: "chime",
        sessionId: u.sessionId,
        msgId: u.msgId,
        text: "",
        displayText: "turn complete",
        status: "ready",
        enqueuedAt: Date.now(),
      });
    }
    this.schedule();
  }

  skip(): void {
    if (this.nowPlaying) {
      const u = this.nowPlaying;
      this.deps.player.stop();
      this.nowPlaying = null;
      if (u.audioUrl) {
        this.revokeUrl(u.audioUrl);
        u.audioUrl = undefined;
      }
      u.status = "skipped";
    }
    this.schedule();
  }

  stopAll(): void {
    this.deps.player.stop();
    for (const u of this.items) {
      if (u.status === "queued" || u.status === "synthesizing" || u.status === "ready" || u.status === "playing") {
        if (u.audioUrl) {
          this.revokeUrl(u.audioUrl);
          u.audioUrl = undefined;
        }
        u.status = "skipped";
      }
    }
    this.nowPlaying = null;
    this.deps.onChange();
  }

  /** Drop pending blurbs (used on session switch — stale garnish). */
  dropPendingBlurbs(): void {
    for (const u of this.items) {
      if (u.kind === "blurb" && (u.status === "queued" || u.status === "ready")) {
        if (u.audioUrl) {
          this.revokeUrl(u.audioUrl);
          u.audioUrl = undefined;
        }
        u.status = "skipped";
      }
    }
    this.schedule();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    // Queue keeps synthesizing up to depth while paused; playback halts.
    this.schedule();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (m) this.stopAll();
    else this.schedule();
  }

  private prune(): void {
    const settled = this.items.filter(
      (u) => u.status === "done" || u.status === "skipped" || u.status === "failed"
    );
    if (settled.length > DONE_KEEP) {
      const drop = new Set(settled.slice(0, settled.length - DONE_KEEP).map((u) => u.id));
      this.items = this.items.filter((u) => !drop.has(u.id));
    }
  }
}
