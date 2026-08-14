import type {
  AttentionEvent,
  EngineCmd,
  EngineMode,
  EngineState,
  ProviderId,
  SessionEvent,
  SessionInfo,
  Settings,
  SettingsPayload,
  Theme,
  Utterance,
  VizEnv,
  VizStyle,
} from "../shared/types";
import { attentionText, isPermissionMessage, toolAttentionText } from "./attention";
import { BlurbCollapser } from "./blurbs";
import { synthHealthOf } from "./health";
import { UtteranceQueue, type PlayerLike } from "./queue";
import { fixMojibake, transformForSpeech } from "./transform";
import { shortTitle } from "../shared/format";

const FOLLOW_HYSTERESIS_MS = 5000;
const ERROR_RATE_LIMIT_MS = 30_000;
const CHIME_MEMORY = 64;
/** Fallback grace before *speaking* a permission alert, used until settings
 * land (`settings.attentionDelayMs` owns it after that). The ping never waits:
 * PermissionRequest fires as the prompt renders, so the cue is ground truth,
 * and this window only spares you a narration you already answered. */
const ATTENTION_ARM_MS = 1500;
const ATTENTION_RATE_LIMIT_MS = 10_000;
/** Ping floor. A run of prompts should ping per prompt — only collapse the
 * same-instant burst of a multi-tool turn. */
const ATTENTION_PING_MIN_MS = 1000;
/** Per-provider playback corrections, layered over the user's settings.
 * Voxtral runs slower AND quieter than ElevenLabs' loudness-normalized
 * output — nudge both. Locals need nothing (Piper peak-normalizes in Rust). */
const PROVIDER_BOOST: Partial<Record<ProviderId, { rate: number; gain: number }>> = {
  mistral: { rate: 1.1, gain: 1.85 },
};
const NO_BOOST = { rate: 1, gain: 1 };

/** "windows" is an implementation detail; listeners hear "on-device". */
function spokenProviderName(p: ProviderId): string {
  return p === "windows" ? "on-device" : p;
}

export type Unsubscribe = () => void;

/**
 * Everything the engine says to / hears from the outside world. Deliberately
 * name-and-shape congruent with the matching exports of shared/bus.ts, so in
 * production `import * as bus` satisfies it with zero adapter code — and any
 * bus signature drift becomes a compile error in engineInstance.ts.
 * Subscriptions may return the Unsubscribe directly or in a Promise (tauri's
 * listen() is async; test fakes are sync).
 */
export interface EngineIO {
  getSettings(): Promise<SettingsPayload>;
  listSessions(): Promise<SessionInfo[]>;
  /** scope names the audio-cache bucket; the engine decides the value. */
  synthesize(text: string, scope: string): Promise<ArrayBuffer>;

  broadcastEngineState(state: EngineState): Promise<void> | void;
  emitVizEnv(env: VizEnv): Promise<void> | void;
  reportAudioUnlocked(unlocked: boolean): Promise<void> | void;

  onSettingsUpdated(cb: (p: SettingsPayload) => void): Promise<Unsubscribe> | Unsubscribe;
  onSessionsUpdated(cb: (s: SessionInfo[]) => void): Promise<Unsubscribe> | Unsubscribe;
  onWatcherStatus(cb: (s: string) => void): Promise<Unsubscribe> | Unsubscribe;
  onSessionEvent(cb: (ev: SessionEvent) => void): Promise<Unsubscribe> | Unsubscribe;
  onAttention(cb: (ev: AttentionEvent) => void): Promise<Unsubscribe> | Unsubscribe;
  onSynthUsed(cb: (provider: ProviderId) => void): Promise<Unsubscribe> | Unsubscribe;
  onEngineCmd(cb: (c: EngineCmd) => void): Promise<Unsubscribe> | Unsubscribe;
}

/** Structural stand-in for AnalyserNode — the two members the viz loop and
 * WaveRing consume. A real AnalyserNode satisfies it; a fake is five lines. */
export interface SpectrumSource {
  readonly frequencyBinCount: number;
  getByteFrequencyData(out: Uint8Array<ArrayBuffer>): void;
}

/** Superset of the queue's PlayerLike — everything the engine itself needs.
 * The production Player satisfies it structurally. */
export interface EnginePlayerPort extends PlayerLike {
  probeAutoplay(): Promise<boolean>;
  pause(): void;
  resume(): void;
  setVolume(v: number): void;
  setRate(r: number): void;
  /** Rate + gain corrections layered over user settings — see PROVIDER_BOOST. */
  setProviderBoost(b: { rate: number; gain: number }): void;
  /** Instant "Claude needs you" cue — rings over ongoing narration. */
  attentionPing(): void;
  readonly analyser: SpectrumSource | null;
  /** 0..1 played fraction of the current track, or null when unknowable
   * (no track, non-finite duration, headless). Feeds VizEnv.frac. */
  progress(): number | null;
}

/** The patch the engine mirrors into the fab window's local store. */
export interface FabMirror {
  mode: EngineMode;
  queueCount: number;
  audioUnlocked: boolean;
  vizStyle: VizStyle;
  fabScale: number;
  vizOn: boolean;
  composing: boolean;
}

export interface EngineDeps {
  io: EngineIO;
  player: EnginePlayerPort;
  /** Side-effect sink: html[data-theme] flip. Test: no-op. */
  applyTheme(t: Theme): void;
  /** Side-effect sink: fab-window-local state. Test: recorder. */
  mirror(patch: FabMirror): void;
  /** Blob-URL indirection for the queue; required headless (no
   * URL.createObjectURL in node). */
  media?: {
    createUrl(buf: ArrayBuffer): string;
    revokeUrl(url: string): void;
  };
}

/**
 * The product's brain. Lives ONLY in the fab window (always-alive webview).
 * Routes tailer events through transform/blurbs into the queue, owns follow
 * logic and mute/pause, and broadcasts its state for the panel and tray.
 *
 * Construction happens at the composition root (src/fab/engineInstance.ts in
 * production, testkit.ts in vitest) — this module has no import-time side
 * effects and imports only pure, node-safe modules.
 */
export class Engine {
  private settings: Settings | null = null;
  private queue: UtteranceQueue;
  private collapser: BlurbCollapser;

  private followedSessionId: string | undefined;
  private lastSpeakableTs = new Map<string, number>();
  private chimedMsgIds: string[] = [];
  private lastErrorSpokenAt = new Map<string, number>();
  private lastAttentionAt = new Map<string, number>();
  private lastPingAt = 0;
  private pendingAttention = new Map<string, ReturnType<typeof setTimeout>>();
  private sessions = new Map<string, SessionInfo>();

  private audioUnlocked = true;
  private watcherStatus = "starting";
  private activeProvider: ProviderId | undefined;
  /** Rust's plan head — the provider the next synthesis would use. */
  private plannedProvider: ProviderId | undefined;
  /** The last voice named aloud (or adopted silently at boot) — announcement dedupe anchor. */
  private announcedProvider: ProviderId | undefined;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private vizTimer: ReturnType<typeof setInterval> | null = null;
  private vizBins: Uint8Array<ArrayBuffer> | null = null;
  private unsubs: Unsubscribe[] = [];

  constructor(private deps: EngineDeps) {
    this.queue = new UtteranceQueue({
      // Blurbs/attention are app vocabulary (repeats across every session) →
      // the shared cache bucket; prose is session content → session-scoped,
      // purged when the session is hidden.
      synth: (text, u) =>
        deps.io.synthesize(
          text,
          u.kind === "blurb" || u.kind === "attention" ? "_shared" : u.sessionId
        ),
      player: deps.player,
      onChange: () => this.scheduleBroadcast(),
      createUrl: deps.media?.createUrl,
      revokeUrl: deps.media?.revokeUrl,
      // Local providers have no API concurrency limit (piper serializes on
      // its own hot thread; extra inflight just queues there harmlessly) —
      // widen the pipeline. Unknown/cloud stays at the free-tier-safe 2.
      // Between a plan change and the first synth-used, the plan head stands
      // in for history — it's what the next call will actually use.
      limits: () => {
        const serving = this.activeProvider ?? this.plannedProvider;
        return serving === "piper" || serving === "windows"
          ? { maxInflight: 4, prefetchDepth: 4 }
          : { maxInflight: 2, prefetchDepth: 2 };
      },
    });
    this.collapser = new BlurbCollapser((phrase) => this.enqueueBlurb(phrase));
  }

  async boot(): Promise<void> {
    const io = this.deps.io;
    const payload = await io.getSettings();
    this.applySettings(payload);

    for (const s of await io.listSessions()) this.sessions.set(s.sessionId, s);

    this.unsubs.push(await io.onSettingsUpdated((p) => this.applySettings(p)));
    this.unsubs.push(
      await io.onSessionsUpdated((list) => {
        for (const s of list) this.sessions.set(s.sessionId, s);
      })
    );
    this.unsubs.push(
      await io.onWatcherStatus((s) => {
        this.watcherStatus = s;
        this.scheduleBroadcast();
      })
    );
    this.unsubs.push(await io.onSessionEvent((ev) => this.route(ev)));
    this.unsubs.push(await io.onAttention((ev) => this.routeAttention(ev.sessionId, ev.message)));
    this.unsubs.push(
      await io.onSynthUsed((provider) => {
        if (this.activeProvider !== provider) {
          this.activeProvider = provider;
          this.deps.player.setProviderBoost(PROVIDER_BOOST[provider] ?? NO_BOOST);
          this.scheduleBroadcast();
        }
        // The plan channel can't see a breaker trip mid-walk (401 during
        // synthesis) — what actually served is the truth then. Announce the
        // landing spot once; the announcement itself synthesizes via the same
        // fallback, so the next synth-used matches and the chain stops.
        if (this.announcedProvider === undefined) {
          this.announcedProvider = provider;
        } else if (provider !== this.announcedProvider) {
          this.announcedProvider = provider;
          this.enqueueBlurb(`voice switched to ${spokenProviderName(provider)}`);
        }
      })
    );
    this.unsubs.push(await io.onEngineCmd((cmd) => this.handleCmd(cmd)));

    this.audioUnlocked = await this.deps.player.probeAutoplay();
    await io.reportAudioUnlocked(this.audioUnlocked);
    if (this.audioUnlocked) {
      // The boot beep: proves the autoplay flag before anything else exists (M1 exit).
      this.deps.player.chime(() => {});
    }
    this.broadcastNow();
  }

  /** Unsubscribe everything, clear every timer, stop playback. Idempotent.
   * Prod never calls this (the fab window lives for the process lifetime);
   * it exists so tests don't leak timers across specs. */
  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs = [];
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.vizTimer) {
      clearInterval(this.vizTimer);
      this.vizTimer = null;
    }
    for (const t of this.pendingAttention.values()) clearTimeout(t);
    this.pendingAttention.clear();
    this.collapser.reset();
    this.deps.player.stop();
  }

  private applySettings(p: SettingsPayload): void {
    const s = p.settings;
    // Rust's plan head is the truth about what speaks next — it moves on
    // primary flips AND eligibility changes (key pasted, piper voice
    // installed…), which a providerOrder diff can't see. Any landing spot the
    // listener hasn't been told about deserves a spoken heads-up, in the NEW
    // voice (audible proof the change took). Deliberately not gated on
    // features.blurbs; mute alone silences it (queue.enqueue discards).
    const planned = p.plannedProvider ?? undefined;
    this.plannedProvider = planned;
    if (this.announcedProvider === undefined) {
      // First payload after boot: adopt silently — nothing changed yet.
      this.announcedProvider = planned;
    } else if (planned && planned !== this.announcedProvider) {
      // activeProvider is history — the last voice that actually synthesized.
      // Across a plan change that history says nothing about what speaks next,
      // and the panel only surfaces it when it DISAGREES with the plan, so
      // leaving it set reads as "your choice was ignored". Drop it and let
      // the next synth-used state the truth.
      this.activeProvider = undefined;
      this.announcedProvider = planned;
      this.enqueueBlurb(`voice switched to ${spokenProviderName(planned)}`);
    }
    this.settings = s;
    this.deps.applyTheme(s.theme);
    this.deps.player.setVolume(s.volume);
    this.deps.player.setRate(s.rate);
    if (s.follow.mode === "pinned" && s.follow.pinnedSessionId) {
      if (this.followedSessionId !== s.follow.pinnedSessionId) {
        this.switchFollow(s.follow.pinnedSessionId, false);
      }
    }
    this.scheduleBroadcast();
  }

  /* ---------- follow ---------- */

  private decideFollow(ev: SessionEvent): boolean {
    const sid = ev.sessionId;
    if (this.settings?.follow.mode === "pinned") {
      return sid === this.settings.follow.pinnedSessionId;
    }
    if (!this.followedSessionId) {
      this.switchFollow(sid, false);
      return true;
    }
    if (sid === this.followedSessionId) return true;

    // Another session is talking: switch only if ours has gone quiet.
    const lastOurs = this.lastSpeakableTs.get(this.followedSessionId) ?? 0;
    if (Date.now() - lastOurs > FOLLOW_HYSTERESIS_MS) {
      this.switchFollow(sid, true);
      return true;
    }
    return false;
  }

  private switchFollow(sid: string, announce: boolean): void {
    this.followedSessionId = sid;
    this.collapser.reset();
    this.queue.dropPendingBlurbs();
    if (announce && this.settings?.features.blurbs) {
      const info = this.sessions.get(sid);
      const title = shortTitle(info?.title, info?.projectSlug ?? sid.slice(0, 8));
      this.enqueueBlurb(`now following ${title}`);
    }
    this.scheduleBroadcast();
  }

  /* ---------- routing ---------- */

  private route(ev: SessionEvent): void {
    if (ev.kind === "title") return; // panel-only concern

    // Fresh transcript activity means the session isn't stalled on a prompt —
    // disarm any pending permission alert for it.
    const pending = this.pendingAttention.get(ev.sessionId);
    if (pending) {
      clearTimeout(pending);
      this.pendingAttention.delete(ev.sessionId);
    }

    // Question/plan prompts never reach the Notification hook — announce them
    // from the transcript, for ANY session (attention outranks follow).
    if (ev.kind === "tool") {
      const text = toolAttentionText(ev.toolName);
      if (text) this.speakAttention(ev.sessionId, text);
    }

    if (ev.kind === "text" || ev.kind === "tool") {
      // Speakability timestamps feed the hysteresis for ALL sessions.
      this.lastSpeakableTs.set(ev.sessionId, Date.now());
    }
    if (!this.decideFollow(ev)) return;
    if (!this.settings) return;

    switch (ev.kind) {
      case "text": {
        this.collapser.flushAll(); // order: pending blurbs precede this prose
        if (!this.settings.features.prose) break;
        const chunks = transformForSpeech(ev.text);
        const wantChime =
          this.settings.features.chime && ev.stopReason === "end_turn";
        chunks.forEach((chunk, i) => {
          this.queue.enqueue({
            id: `${ev.uuid}#${i}`,
            kind: "prose",
            sessionId: ev.sessionId,
            sourceUuid: ev.uuid,
            msgId: ev.msgId,
            text: chunk,
            displayText: chunk,
            status: "queued",
            chimeAfter: wantChime && i === chunks.length - 1,
            enqueuedAt: Date.now(),
          });
        });
        if (wantChime) this.rememberChime(ev.msgId);
        // Prose with zero speakable chunks (pure code block) still ends a turn.
        if (wantChime && chunks.length === 0) this.enqueueChime(ev.sessionId, ev.msgId);
        break;
      }
      case "tool": {
        if (!this.settings.features.blurbs) break;
        this.collapser.push(ev.toolName, ev.input);
        break;
      }
      case "turnEnd": {
        if (!this.settings.features.chime) break;
        if (this.chimedMsgIds.includes(ev.msgId)) break; // thinking+text both carry end_turn
        this.collapser.flushAll();
        this.enqueueChime(ev.sessionId, ev.msgId);
        break;
      }
      case "apiError": {
        if (!this.settings.features.errors) break;
        const last = this.lastErrorSpokenAt.get(ev.sessionId) ?? 0;
        if (Date.now() - last < ERROR_RATE_LIMIT_MS) break;
        this.lastErrorSpokenAt.set(ev.sessionId, Date.now());
        this.collapser.flushAll();
        const retry = ev.retryInMs
          ? ` Retrying in ${Math.round(ev.retryInMs / 1000)} seconds.`
          : "";
        this.queue.enqueue({
          id: `err:${Date.now()}`,
          kind: "error",
          sessionId: ev.sessionId,
          text: `Claude hit an API error. ${fixMojibake(ev.message)}.${retry}`,
          displayText: ev.message,
          status: "queued",
          enqueuedAt: Date.now(),
        });
        break;
      }
    }
  }

  /* ---------- attention (Notification hook + transcript prompts) ---------- */

  private routeAttention(sessionId: string, message: string): void {
    const text = attentionText(message);
    if (isPermissionMessage(message)) {
      // The prompt is on screen NOW — ping first, narrate later. Only the spoken
      // sentence waits out the grace window, so answering instantly costs you one
      // ping instead of a full alert after the fact.
      this.pingAttention();
      const key = sessionId || "unknown";
      const existing = this.pendingAttention.get(key);
      if (existing) clearTimeout(existing);
      const delay = this.settings?.attentionDelayMs ?? ATTENTION_ARM_MS;
      if (delay <= 0) {
        // No window at all — speak now, before any transcript event can disarm.
        this.speakAttention(sessionId, text, false);
        return;
      }
      this.pendingAttention.set(
        key,
        setTimeout(() => {
          this.pendingAttention.delete(key);
          this.speakAttention(sessionId, text, false);
        }, delay)
      );
    } else {
      // "waiting for your input" fires after a long idle — speak immediately.
      this.speakAttention(sessionId, text);
    }
  }

  /** The audible cue on its own — no queue, no per-session rate limit. Muted =
   * silent (a queued alert would be discarded too). */
  private pingAttention(): void {
    if (!this.settings?.features.attention) return;
    if (this.queue.muted) return;
    const now = Date.now();
    if (now - this.lastPingAt < ATTENTION_PING_MIN_MS) return;
    this.lastPingAt = now;
    this.deps.player.attentionPing();
  }

  private speakAttention(sessionId: string, text: string, ping = true): void {
    if (!this.settings?.features.attention) return;
    const key = sessionId || "unknown";
    const last = this.lastAttentionAt.get(key) ?? 0;
    if (Date.now() - last < ATTENTION_RATE_LIMIT_MS) return;
    this.lastAttentionAt.set(key, Date.now());

    if (ping) this.pingAttention();

    // Name the session when it isn't the one being narrated.
    let spoken = text;
    if (sessionId && sessionId !== this.followedSessionId) {
      const info = this.sessions.get(sessionId);
      if (info) {
        spoken = `In ${shortTitle(info.title, info.projectSlug)}: ${text}`;
      }
    }

    this.collapser.flushAll();
    this.queue.enqueue({
      id: `attn:${Date.now()}`,
      kind: "attention",
      sessionId: sessionId || "unknown",
      text: spoken,
      displayText: spoken,
      status: "queued",
      enqueuedAt: Date.now(),
    });
  }

  private rememberChime(msgId: string): void {
    // Idempotent: the zero-chunk text path records the id and enqueueChime
    // records it again — one slot per msgId, or the 64-entry ring halves.
    if (this.chimedMsgIds.includes(msgId)) return;
    this.chimedMsgIds.push(msgId);
    if (this.chimedMsgIds.length > CHIME_MEMORY) this.chimedMsgIds.shift();
  }

  private enqueueChime(sessionId: string, msgId: string): void {
    this.rememberChime(msgId);
    this.queue.enqueue({
      id: `chime:${msgId}`,
      kind: "chime",
      sessionId,
      msgId,
      text: "",
      displayText: "turn complete",
      status: "queued",
      enqueuedAt: Date.now(),
    });
  }

  private enqueueBlurb(phrase: string): void {
    // No follow required: the "voice switched" heads-up can arrive before any
    // session is followed (Rust auto-promote during attention/test speech).
    // Tool blurbs still only originate from followed-session events.
    this.queue.enqueue({
      id: `blurb:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      kind: "blurb",
      sessionId: this.followedSessionId ?? "system",
      text: `${phrase}.`,
      displayText: phrase,
      status: "queued",
      enqueuedAt: Date.now(),
    });
  }

  /* ---------- commands ---------- */

  private handleCmd(cmd: EngineCmd): void {
    switch (cmd.cmd) {
      case "pause":
        this.queue.setPaused(true);
        this.deps.player.pause();
        break;
      case "resume":
        this.queue.setPaused(false);
        this.deps.player.resume();
        this.queue.schedule();
        break;
      case "pause-resume":
        if (this.queue.paused) this.handleCmd({ cmd: "resume" });
        else this.handleCmd({ cmd: "pause" });
        break;
      case "skip":
        this.queue.skip();
        break;
      case "stop":
        this.queue.stopAll();
        break;
      case "toggle-mute":
        this.queue.setMuted(!this.queue.muted);
        break;
      case "set-volume":
        if (typeof cmd.v === "number") this.deps.player.setVolume(cmd.v);
        break;
      case "set-rate":
        if (typeof cmd.v === "number") this.deps.player.setRate(cmd.v);
        break;
      case "pin":
        if (cmd.sessionId) this.switchFollow(cmd.sessionId, false);
        break;
      case "speak-test":
        this.queue.enqueue({
          id: `test:${Date.now()}`,
          kind: "prose",
          sessionId: this.followedSessionId ?? "test",
          text: cmd.text?.trim() || "Companion online. The shadow garden hears everything.",
          displayText: "voice test",
          status: "queued",
          enqueuedAt: Date.now(),
        });
        break;
      case "replay":
        this.handleReplay(cmd);
        break;
    }
    this.broadcastNow();
  }

  /** Double-click-a-row re-speak. Live rows resolve by id for full-fidelity
   * text (already transformed); backfill rows and pruned ids fall back to
   * cmd.text, which goes through transformForSpeech here. */
  private handleReplay(cmd: { id?: string; text?: string; sessionId?: string }): void {
    const mode = this.settings?.replayMode ?? "next";
    if (mode === "off") return; // panel gates too — defense in depth
    // Replays are invisible in the feed — without this guard a double-double-
    // click would stack silent duplicates.
    const pending = (s: string) =>
      s === "queued" || s === "synthesizing" || s === "ready" || s === "playing";
    if (
      cmd.id &&
      this.queue.items.some((u) => u.replayOfId === cmd.id && pending(u.status))
    ) {
      return;
    }
    const src = cmd.id ? this.queue.items.find((u) => u.id === cmd.id) : undefined;
    if (src) {
      const settled =
        src.status === "done" || src.status === "failed" || src.status === "skipped";
      // Pending rows are inert — replaying one would play it twice.
      if (!settled || src.kind === "chime") return;
    }
    const parts: Array<{ text: string; display: string }> = src?.text
      ? [{ text: src.text, display: src.displayText }]
      : transformForSpeech(cmd.text?.trim() ?? "").map((c) => ({ text: c, display: c }));
    if (parts.length === 0) return; // pure code / empty — nothing speakable
    const sessionId = src?.sessionId ?? cmd.sessionId ?? this.followedSessionId ?? "replay";
    const stamp = Date.now();
    const us: Utterance[] = parts.map((p, i) => ({
      // Fresh ids — reusing the source row's id would collide React keys and
      // nowPlayingId matching.
      id: `replay:${stamp}:${i}:${Math.random().toString(36).slice(2, 6)}`,
      kind: "prose", // backpressure only ever drops blurbs — replays are safe
      sessionId,
      text: p.text,
      displayText: p.display,
      status: "queued",
      // Anchors the in-place highlight: while this plays, nowPlayingId maps
      // to the source row instead of spawning a duplicate feed entry.
      replayOfId: cmd.id,
      enqueuedAt: stamp,
    }));
    // Explicit user action overrides mute (pause is still respected).
    if (this.queue.muted) this.queue.setMuted(false);
    this.queue.enqueuePriority(us, mode);
  }

  /* ---------- state broadcast ---------- */

  private computeMode(): EngineMode {
    if (!this.audioUnlocked) return "error";
    if (this.queue.muted) return "muted";
    if (this.queue.paused) return "paused";
    if (this.queue.nowPlaying) return "speaking";
    if (this.watcherStatus === "dead") return "error";
    if (this.followedSessionId) return "watching";
    return "idle";
  }

  buildState(): EngineState {
    return {
      mode: this.computeMode(),
      followedSessionId: this.followedSessionId,
      // A playing replay highlights its SOURCE row in place — the replay
      // utterance itself never appears in the feed (filter below).
      nowPlayingId: this.queue.nowPlaying?.replayOfId ?? this.queue.nowPlaying?.id,
      queue: this.queue.items.filter((u) => !u.replayOfId).map((u) => ({
        id: u.id,
        kind: u.kind,
        status: u.status,
        // Prose chunks are already ≤ chunkChars (420); this guard only catches
        // pathological outliers, so normal feed rows never show a bare "…".
        displayText: u.displayText.length > 480 ? `${u.displayText.slice(0, 480)}…` : u.displayText,
        sessionId: u.sessionId,
      })),
      queuedChars: this.queue.queuedChars,
      audioUnlocked: this.audioUnlocked,
      lastError: this.queue.lastError ?? undefined,
      synthHealth: synthHealthOf(this.queue.lastError, this.queue.lastErrorAt),
      activeProvider: this.activeProvider,
    };
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastNow();
    }, 150);
  }

  private broadcastNow(): void {
    const state = this.buildState();
    this.deps.mirror({
      mode: state.mode,
      queueCount: state.queue.filter(
        (u) => u.status === "queued" || u.status === "synthesizing" || u.status === "ready"
      ).length,
      audioUnlocked: state.audioUnlocked,
      vizStyle: this.settings?.visualizerStyle ?? "strands",
      fabScale: this.settings?.fabScale ?? 1,
      vizOn: this.settings?.visualizer ?? true,
      composing: state.queue.some((u) => u.status === "synthesizing"),
    });
    this.syncVizStream(state.mode === "speaking");
    void this.deps.io.broadcastEngineState(state);
  }

  /** Stream the audio envelope (RMS + 12 coarse bins) to the visualizers while speaking. */
  private syncVizStream(speaking: boolean): void {
    if (speaking && !this.vizTimer) {
      this.vizTimer = setInterval(() => {
        const analyser = this.deps.player.analyser;
        if (!analyser) return;
        if (!this.vizBins || this.vizBins.length !== analyser.frequencyBinCount) {
          this.vizBins = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteFrequencyData(this.vizBins);
        let sum = 0;
        for (let i = 0; i < this.vizBins.length; i++) {
          const v = this.vizBins[i] / 255;
          sum += v * v;
        }
        // 12 coarse bins from the voiced low band (pairs of the first 24 fft bins).
        const bins: number[] = new Array(12);
        for (let i = 0; i < 12; i++) {
          const a = this.vizBins[Math.min(i * 2, this.vizBins.length - 1)] ?? 0;
          const b = this.vizBins[Math.min(i * 2 + 1, this.vizBins.length - 1)] ?? 0;
          bins[i] = (a + b) / 510;
        }
        // Playback position rides along for the panel's typewriter reveal.
        // Chimes are oscillators — the <audio> element holds a stale src then,
        // so they get no utteranceId and the panel renders them plain.
        const np = this.queue.nowPlaying;
        const utt = np && np.kind !== "chime" ? np : null;
        const frac = utt ? this.deps.player.progress() ?? 0 : 0;
        void this.deps.io.emitVizEnv({
          rms: Math.sqrt(sum / this.vizBins.length),
          bins,
          utteranceId: utt?.id,
          frac,
        });
      }, 50);
    } else if (!speaking && this.vizTimer) {
      clearInterval(this.vizTimer);
      this.vizTimer = null;
      void this.deps.io.emitVizEnv({ rms: 0, bins: new Array(12).fill(0) });
    }
  }

  get analyser(): SpectrumSource | null {
    return this.deps.player.analyser;
  }
}
