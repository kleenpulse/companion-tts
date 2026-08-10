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
/** Grace before speaking a permission alert — canceled if the session moves on. */
const ATTENTION_ARM_MS = 2500;
const ATTENTION_RATE_LIMIT_MS = 20_000;

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
  private pendingAttention = new Map<string, ReturnType<typeof setTimeout>>();
  private sessions = new Map<string, SessionInfo>();

  private audioUnlocked = true;
  private watcherStatus = "starting";
  private activeProvider: ProviderId | undefined;
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
    });
    this.collapser = new BlurbCollapser((phrase) => this.enqueueBlurb(phrase));
  }

  async boot(): Promise<void> {
    const io = this.deps.io;
    const payload = await io.getSettings();
    this.applySettings(payload.settings);

    for (const s of await io.listSessions()) this.sessions.set(s.sessionId, s);

    this.unsubs.push(await io.onSettingsUpdated((p) => this.applySettings(p.settings)));
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
          this.scheduleBroadcast();
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

  private applySettings(s: Settings): void {
    // A primary flip (manual or auto-switch) deserves a spoken heads-up —
    // the listener already heard the voice change; name the reason.
    const prevPrimary = this.settings?.providerOrder[0];
    const nextPrimary = s.providerOrder[0];
    if (prevPrimary && nextPrimary && prevPrimary !== nextPrimary && s.features.blurbs) {
      const spoken = nextPrimary === "windows" ? "on-device" : nextPrimary;
      this.enqueueBlurb(`voice switched to ${spoken}`);
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
        if (!this.settings.features.prose || this.queue.muted) break;
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
        if (!this.settings.features.blurbs || this.queue.muted) break;
        this.collapser.push(ev.toolName, ev.input);
        break;
      }
      case "turnEnd": {
        if (!this.settings.features.chime || this.queue.muted) break;
        if (this.chimedMsgIds.includes(ev.msgId)) break; // thinking+text both carry end_turn
        this.collapser.flushAll();
        this.enqueueChime(ev.sessionId, ev.msgId);
        break;
      }
      case "apiError": {
        if (!this.settings.features.errors || this.queue.muted) break;
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
      // Grace window: if the user approves fast enough that the session moves
      // on, the alert dissolves unspoken.
      const key = sessionId || "unknown";
      const existing = this.pendingAttention.get(key);
      if (existing) clearTimeout(existing);
      this.pendingAttention.set(
        key,
        setTimeout(() => {
          this.pendingAttention.delete(key);
          this.speakAttention(sessionId, text);
        }, ATTENTION_ARM_MS)
      );
    } else {
      // "waiting for your input" fires after a long idle — speak immediately.
      this.speakAttention(sessionId, text);
    }
  }

  private speakAttention(sessionId: string, text: string): void {
    if (!this.settings?.features.attention || this.queue.muted) return;
    const key = sessionId || "unknown";
    const last = this.lastAttentionAt.get(key) ?? 0;
    if (Date.now() - last < ATTENTION_RATE_LIMIT_MS) return;
    this.lastAttentionAt.set(key, Date.now());

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
    if (!this.followedSessionId || this.queue.muted) return;
    this.queue.enqueue({
      id: `blurb:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      kind: "blurb",
      sessionId: this.followedSessionId,
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
    }
    this.broadcastNow();
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
      nowPlayingId: this.queue.nowPlaying?.id,
      queue: this.queue.items.map((u) => ({
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
