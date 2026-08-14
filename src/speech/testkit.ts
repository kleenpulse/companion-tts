import { vi } from "vitest";
import { Engine, type EngineIO, type EnginePlayerPort, type FabMirror, type Unsubscribe } from "./engine";
import type {
  AttentionEvent,
  EngineCmd,
  EngineState,
  ProviderId,
  SessionEvent,
  SessionInfo,
  Settings,
  SettingsPayload,
  VizEnv,
} from "../shared/types";

/**
 * Headless engine harness. Boots a real Engine against in-memory adapters so
 * behaviour tests drive it through the same channels production uses:
 * inbound events via `io.push.*` (wrapped in scenario verbs), observation via
 * `engine.buildState()` and the recording arrays. Installs fake timers
 * (including Date — the hysteresis and rate limits read Date.now); `advance`
 * is the only way tests move time. Always call `dispose()` at the end.
 */

export function defaultTestSettings(over?: Partial<Settings>): Settings {
  return {
    keys: { elevenlabs: "", mistral: "" },
    providerOrder: ["elevenlabs", "mistral", "piper", "windows"],
    voices: { elevenlabs: "", mistral: "", windows: "", piper: "" },
    features: { prose: true, blurbs: true, errors: true, chime: true, attention: true },
    volume: 0.9,
    rate: 1,
    follow: { mode: "auto", pinnedSessionId: null },
    visualizer: true,
    visualizerStyle: "strands",
    typewriter: true,
    replayMode: "next",
    attentionDelayMs: 1500,
    theme: "dark",
    lastSeenVersion: "",
    fabScale: 1,
    hiddenSessions: [],
    fabPosition: null,
    panelBounds: null,
    autostart: false,
    confirmQuit: true,
    shortcuts: { mute: "", pauseResume: "" },
    monthly: { month: "2026-01", chars: 0 },
    ...over,
  };
}

class FakeIO implements EngineIO {
  broadcasts: EngineState[] = [];
  vizEnvs: VizEnv[] = [];
  unlockedReports: boolean[] = [];
  synthCalls: Array<{ text: string; scope: string }> = [];

  private sessionEventCbs: Array<(ev: SessionEvent) => void> = [];
  private attentionCbs: Array<(ev: AttentionEvent) => void> = [];
  private settingsCbs: Array<(p: SettingsPayload) => void> = [];
  private sessionsCbs: Array<(s: SessionInfo[]) => void> = [];
  private watcherCbs: Array<(s: string) => void> = [];
  private synthUsedCbs: Array<(p: ProviderId) => void> = [];
  private cmdCbs: Array<(c: EngineCmd) => void> = [];

  constructor(
    private settings: Settings,
    private sessions: SessionInfo[],
    private plannedProvider: ProviderId | null = "windows"
  ) {}

  /** Test steering wheel: fire inbound events exactly as the bus would. */
  push = {
    sessionEvent: (ev: SessionEvent) => this.sessionEventCbs.forEach((cb) => cb(ev)),
    attention: (ev: AttentionEvent) => this.attentionCbs.forEach((cb) => cb(ev)),
    settingsUpdated: (p: SettingsPayload) => this.settingsCbs.forEach((cb) => cb(p)),
    sessionsUpdated: (s: SessionInfo[]) => this.sessionsCbs.forEach((cb) => cb(s)),
    watcherStatus: (s: string) => this.watcherCbs.forEach((cb) => cb(s)),
    synthUsed: (p: ProviderId) => this.synthUsedCbs.forEach((cb) => cb(p)),
    engineCmd: (c: EngineCmd) => this.cmdCbs.forEach((cb) => cb(c)),
  };

  getSettings(): Promise<SettingsPayload> {
    return Promise.resolve({
      settings: this.settings,
      envKeys: { elevenlabs: false, mistral: false },
      // Tests supply plan heads explicitly per push — the testkit must NOT
      // emulate Rust's plan(); this is only the boot value.
      plannedProvider: this.plannedProvider,
    });
  }
  listSessions(): Promise<SessionInfo[]> {
    return Promise.resolve(this.sessions);
  }
  synthesize(text: string, scope: string): Promise<ArrayBuffer> {
    this.synthCalls.push({ text, scope });
    return Promise.resolve(new ArrayBuffer(8));
  }
  broadcastEngineState(state: EngineState): void {
    this.broadcasts.push(state);
  }
  emitVizEnv(env: VizEnv): void {
    this.vizEnvs.push(env);
  }
  reportAudioUnlocked(unlocked: boolean): void {
    this.unlockedReports.push(unlocked);
  }

  onSettingsUpdated(cb: (p: SettingsPayload) => void): Unsubscribe {
    this.settingsCbs.push(cb);
    return () => {};
  }
  onSessionsUpdated(cb: (s: SessionInfo[]) => void): Unsubscribe {
    this.sessionsCbs.push(cb);
    return () => {};
  }
  onWatcherStatus(cb: (s: string) => void): Unsubscribe {
    this.watcherCbs.push(cb);
    return () => {};
  }
  onSessionEvent(cb: (ev: SessionEvent) => void): Unsubscribe {
    this.sessionEventCbs.push(cb);
    return () => {};
  }
  onAttention(cb: (ev: AttentionEvent) => void): Unsubscribe {
    this.attentionCbs.push(cb);
    return () => {};
  }
  onSynthUsed(cb: (p: ProviderId) => void): Unsubscribe {
    this.synthUsedCbs.push(cb);
    return () => {};
  }
  onEngineCmd(cb: (c: EngineCmd) => void): Unsubscribe {
    this.cmdCbs.push(cb);
    return () => {};
  }
}

class FakePlayer implements EnginePlayerPort {
  playingUrl: string | null = null;
  chimeCalls = 0;
  attentionPings = 0;
  providerBoost = { rate: 1, gain: 1 };
  private pendingEnd: (() => void) | null = null;

  playUrl(url: string, onEnded: () => void, _onError: (e: unknown) => void): void {
    this.playingUrl = url;
    this.pendingEnd = () => {
      this.playingUrl = null;
      onEnded();
    };
  }
  chime(onDone: () => void): void {
    this.chimeCalls += 1;
    this.pendingEnd = () => onDone();
  }
  stop(): void {
    this.playingUrl = null;
    this.pendingEnd = null;
  }
  pause(): void {}
  resume(): void {}
  setVolume(_v: number): void {}
  setRate(_r: number): void {}
  setProviderBoost(b: { rate: number; gain: number }): void {
    this.providerBoost = b;
  }
  attentionPing(): void {
    this.attentionPings += 1;
  }
  probeAutoplay(): Promise<boolean> {
    return Promise.resolve(true);
  }
  readonly analyser = null;
  progress(): number | null {
    return null;
  }

  /** Finish whatever is playing (audio track or chime) — the playback clock. */
  endCurrent(): void {
    const fire = this.pendingEnd;
    this.pendingEnd = null;
    fire?.();
  }
}

export interface EngineHarness {
  engine: Engine;
  io: FakeIO;
  player: FakePlayer;
  mirrors: FabMirror[];
  /** Scenario verbs — auto-numbered uuids/msgIds unless overridden. */
  text(sessionId: string, text: string, over?: { msgId?: string; stopReason?: string | null }): void;
  tool(sessionId: string, toolName: string, input?: Record<string, unknown>): void;
  turnEnd(sessionId: string, msgId: string): void;
  attention(sessionId: string, message: string): void;
  cmd(c: EngineCmd): void;
  /** Advance fake time, running due timers and flushing microtasks. */
  advance(ms: number): Promise<void>;
  /** Flush pending synth resolutions and zero-delay work without moving time. */
  settle(): Promise<void>;
  state(): EngineState;
  followed(): string | undefined;
  /** Every text handed to synthesis, in order. */
  spokenTexts(): string[];
  chimesSinceBoot(): number;
  dispose(): void;
}

export async function bootHarness(opts?: {
  settings?: Partial<Settings>;
  sessions?: SessionInfo[];
  /** Boot-time plan head (default "windows" — the keyless default's real head). */
  plannedProvider?: ProviderId | null;
}): Promise<EngineHarness> {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });

  const io = new FakeIO(
    defaultTestSettings(opts?.settings),
    opts?.sessions ?? [],
    opts?.plannedProvider === undefined ? "windows" : opts.plannedProvider
  );
  const player = new FakePlayer();
  const mirrors: FabMirror[] = [];
  const engine = new Engine({
    io,
    player,
    applyTheme: () => {},
    mirror: (patch) => mirrors.push(patch),
    media: { createUrl: (buf) => `url:${buf.byteLength}`, revokeUrl: () => {} },
  });
  await engine.boot();
  const chimesAtBoot = player.chimeCalls;

  let n = 0;
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
  };

  return {
    engine,
    io,
    player,
    mirrors,
    text: (sessionId, text, over) => {
      n += 1;
      io.push.sessionEvent({
        kind: "text",
        sessionId,
        uuid: `u${n}`,
        msgId: over?.msgId ?? `m${n}`,
        text,
        stopReason: over?.stopReason ?? null,
        ts: "t",
      });
    },
    tool: (sessionId, toolName, input = {}) => {
      n += 1;
      io.push.sessionEvent({
        kind: "tool",
        sessionId,
        uuid: `u${n}`,
        msgId: `m${n}`,
        toolName,
        input,
        ts: "t",
      });
    },
    turnEnd: (sessionId, msgId) => {
      io.push.sessionEvent({ kind: "turnEnd", sessionId, msgId, ts: "t" });
    },
    attention: (sessionId, message) => {
      io.push.attention({ sessionId, message });
    },
    cmd: (c) => io.push.engineCmd(c),
    advance: async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    settle,
    state: () => engine.buildState(),
    followed: () => engine.buildState().followedSessionId,
    spokenTexts: () => io.synthCalls.map((c) => c.text),
    chimesSinceBoot: () => player.chimeCalls - chimesAtBoot,
    dispose: () => {
      engine.dispose();
      vi.useRealTimers();
    },
  };
}
