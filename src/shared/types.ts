/** Shapes shared across both windows and the Rust bridge. Single source of truth. */

export type ProviderId = "elevenlabs" | "mistral" | "piper" | "windows";

/** Providers that need an API key — "piper"/"windows" are local and keyless. */
export type CloudProviderId = "elevenlabs" | "mistral";

export type VizStyle = "waves" | "strands";

export type Theme = "dark" | "light" | "system";

export interface Settings {
  keys: { elevenlabs: string; mistral: string };
  providerOrder: ProviderId[];
  /**
   * windows: WinRT voice Id (or DisplayName); "" = system default voice.
   * piper: downloaded voice id (e.g. "en_GB-alba-medium"); "" = none yet.
   */
  voices: { elevenlabs: string; mistral: string; windows: string; piper: string };
  features: {
    prose: boolean;
    blurbs: boolean;
    errors: boolean;
    chime: boolean;
    attention: boolean;
  };
  volume: number; // 0..1
  rate: number; // 0.75..1.5
  follow: { mode: "auto" | "pinned"; pinnedSessionId?: string | null };
  visualizer: boolean;
  visualizerStyle: VizStyle;
  /** Feed reveals the spoken row character-by-character, synced to playback. */
  typewriter: boolean;
  theme: Theme;
  /** Last version whose What's New was acknowledged; "" = never seeded. */
  lastSeenVersion: string;
  /** Floating dial scale (0.75–3.0) — window and dial resize together. */
  fabScale: number;
  hiddenSessions: string[];
  fabPosition?: { x: number; y: number } | null;
  panelBounds?: { x: number; y: number; width: number; height: number } | null;
  autostart: boolean;
  shortcuts: { mute: string; pauseResume: string };
  monthly: { month: string; chars: number };
}

export interface EnvKeys {
  elevenlabs: boolean;
  mistral: boolean;
}

export interface SettingsPayload {
  settings: Settings;
  envKeys: EnvKeys;
}

export interface SessionInfo {
  sessionId: string;
  projectSlug: string;
  path: string;
  title?: string | null;
  lastActivity: number;
}

/** Typed events emitted by the Rust tailer — mirror of parser.rs SessionEvent. */
export type SessionEvent =
  | {
      kind: "text";
      sessionId: string;
      uuid: string;
      msgId: string;
      text: string;
      stopReason: string | null;
      ts: string;
    }
  | {
      kind: "tool";
      sessionId: string;
      uuid: string;
      msgId: string;
      toolName: string;
      input: ToolInput;
      ts: string;
    }
  | { kind: "turnEnd"; sessionId: string; msgId: string; ts: string }
  | {
      kind: "apiError";
      sessionId: string;
      message: string;
      retryInMs?: number | null;
      retryAttempt?: number | null;
      ts: string;
    }
  | { kind: "title"; sessionId: string; title: string };

export interface ToolInput {
  filePath?: string;
  command?: string;
  description?: string;
  pattern?: string;
  url?: string;
  skill?: string;
}

export type UtteranceKind = "prose" | "blurb" | "error" | "chime" | "attention";

/** Claude Code Notification-hook event, tailed from notifications.jsonl. */
export interface AttentionEvent {
  sessionId: string;
  message: string;
}
export type UtteranceStatus =
  | "queued"
  | "synthesizing"
  | "ready"
  | "playing"
  | "done"
  | "failed"
  | "skipped";

export interface Utterance {
  id: string; // `${uuid}#${chunkIndex}` | `chime:${msgId}` | `err:${ts}`
  kind: UtteranceKind;
  sessionId: string;
  sourceUuid?: string;
  msgId?: string;
  text: string; // sanitized speech text ("" for chime)
  displayText: string; // pre-transform text for the panel feed
  status: UtteranceStatus;
  audioUrl?: string;
  chimeAfter?: boolean;
  enqueuedAt: number;
}

export type EngineMode =
  | "idle"
  | "watching"
  | "speaking"
  | "paused"
  | "muted"
  | "error";

export interface FeedItem {
  id: string;
  kind: UtteranceKind;
  status: UtteranceStatus;
  displayText: string;
  sessionId: string;
}

/** Why the queue is (or isn't) draining — derived from recent synthesis outcomes. */
export type SynthReason =
  | "rate limited"
  | "key rejected"
  | "out of credits"
  | "network error"
  | "no API key"
  | "provider error";

export interface SynthHealth {
  state: "ok" | "degraded";
  reason?: SynthReason;
  provider?: ProviderId;
}

export interface EngineState {
  mode: EngineMode;
  followedSessionId?: string;
  nowPlayingId?: string;
  queue: FeedItem[]; // pending + playing + recent done, in order (capped)
  queuedChars: number;
  audioUnlocked: boolean;
  lastError?: string;
  synthHealth: SynthHealth;
  /** Provider that actually synthesized most recently — the voice you hear. */
  activeProvider?: ProviderId;
}

/** Audio envelope streamed fab→panel while speaking: overall RMS + coarse spectrum. */
export interface VizEnv {
  rms: number;
  bins: number[]; // 12 normalized (0..1) low-band bins
  /** Utterance whose audio is playing right now (absent for chimes/idle). */
  utteranceId?: string;
  /** currentTime/duration of that audio — drives the typewriter reveal. */
  frac?: number;
}

export type EngineCmd =
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "pause-resume" }
  | { cmd: "skip" }
  | { cmd: "stop" }
  | { cmd: "toggle-mute" }
  | { cmd: "set-volume"; v: number }
  | { cmd: "set-rate"; v: number }
  | { cmd: "pin"; sessionId?: string }
  | { cmd: "speak-test"; text?: string };

export interface ProviderStatus {
  id: ProviderId;
  permanentlyFailed: boolean;
  hasKey: boolean;
}

/** An installed on-device (WinRT) voice. */
export interface WindowsVoice {
  id: string;
  name: string;
  language: string;
}

/** A curated Piper neural voice — installed = model files on disk. */
export interface PiperVoiceInfo {
  id: string;
  label: string;
  language: string;
  sizeMb: number;
  installed: boolean;
}

/** Progress stream for a Piper voice download (`piper-download` event). */
export interface PiperDownloadEvent {
  id: string;
  received: number;
  total: number;
  phase: "downloading" | "done" | "error";
  error?: string;
}
