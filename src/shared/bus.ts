import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AttentionEvent,
  EngineCmd,
  EngineState,
  PiperDownloadEvent,
  PiperVoiceInfo,
  ProviderId,
  ProviderStatus,
  SessionEvent,
  SessionInfo,
  Settings,
  SettingsPayload,
  VizEnv,
  WindowsVoice,
} from "./types";

/* ---------- events: rust → webviews ---------- */

export function onSessionEvent(cb: (ev: SessionEvent) => void): Promise<UnlistenFn> {
  return listen<SessionEvent>("session-event", (e) => cb(e.payload));
}

export function onSessionsUpdated(cb: (s: SessionInfo[]) => void): Promise<UnlistenFn> {
  return listen<SessionInfo[]>("sessions-updated", (e) => cb(e.payload));
}

export function onSettingsUpdated(cb: (p: SettingsPayload) => void): Promise<UnlistenFn> {
  return listen<SettingsPayload>("settings-updated", (e) => cb(e.payload));
}

export function onWatcherStatus(cb: (s: string) => void): Promise<UnlistenFn> {
  return listen<string>("watcher-status", (e) => cb(e.payload));
}

/** Claude Code Notification-hook events — "needs permission" / "waiting for input". */
export function onAttention(cb: (ev: AttentionEvent) => void): Promise<UnlistenFn> {
  return listen<AttentionEvent>("attention-event", (e) => cb(e.payload));
}

/** Fired by synth.rs after each successful synthesis — names the provider used. */
export function onSynthUsed(cb: (provider: ProviderId) => void): Promise<UnlistenFn> {
  return listen<ProviderId>("synth-used", (e) => cb(e.payload));
}

/** Fired by toggle_panel right after the panel window is shown — the hidden
 * webview never sees visibilitychange, so scroll re-syncs hang off this. */
export function onPanelShown(cb: () => void): Promise<UnlistenFn> {
  return listen("panel-shown", () => cb());
}

/* ---------- events: fab engine ↔ panel/tray ---------- */

export function onEngineState(cb: (s: EngineState) => void): Promise<UnlistenFn> {
  return listen<EngineState>("engine-state", (e) => cb(e.payload));
}

export function broadcastEngineState(state: EngineState): Promise<void> {
  // Global: the panel and the Rust tray listener both consume it.
  return emit("engine-state", state);
}

export function onEngineCmd(cb: (c: EngineCmd) => void): Promise<UnlistenFn> {
  return listen<EngineCmd>("engine-cmd", (e) => cb(e.payload));
}

/** Audio envelope streamed from the fab's analyser while speaking — feeds the visualizers. */
export function onVizEnv(cb: (env: VizEnv) => void): Promise<UnlistenFn> {
  return listen<VizEnv>("viz-env", (e) => cb(e.payload));
}

export function emitVizEnv(env: VizEnv): Promise<void> {
  return emit("viz-env", env);
}

export function sendEngineCmd(cmd: EngineCmd): Promise<void> {
  return emitTo("fab", "engine-cmd", cmd);
}

/* ---------- commands: webviews → rust ---------- */

/** Version compiled into the running binary (tauri.conf.json) — can't drift. */
export function getAppVersion(): Promise<string> {
  return getVersion();
}

export function getSettings(): Promise<SettingsPayload> {
  return invoke("get_settings");
}

export function setSettings(settings: Settings): Promise<SettingsPayload> {
  return invoke("set_settings", { settings });
}

export function listSessions(): Promise<SessionInfo[]> {
  return invoke("list_sessions");
}

export function tailBackfill(sessionId: string, maxEvents: number): Promise<SessionEvent[]> {
  return invoke("tail_backfill", { sessionId, maxEvents });
}

/** Dismiss a session from the list — the transcript on disk is never touched. */
export function hideSession(sessionId: string): Promise<void> {
  return invoke("hide_session", { sessionId });
}

/** Live Fab-size preview: shows the real dial beside the panel at this scale. */
export function previewFabScale(scale: number): Promise<void> {
  return invoke("preview_fab_scale", { scale });
}

/** Preview over — dial returns to its roost (hidden again if the panel is open). */
export function endFabPreview(): Promise<void> {
  return invoke("end_fab_preview");
}

export function attentionHookStatus(): Promise<boolean> {
  return invoke("attention_hook_status");
}

export function installAttentionHook(): Promise<boolean> {
  return invoke("install_attention_hook");
}

/** Scope names the audio-cache bucket: "_shared" for app vocabulary (blurbs,
 * attention phrases — reused across sessions), else the session id (purged
 * with the session). */
export function synthesize(text: string, scope: string): Promise<ArrayBuffer> {
  return invoke("synthesize", { text, scope });
}

export function providerStatus(): Promise<ProviderStatus[]> {
  return invoke("provider_status");
}

/** Installed on-device (WinRT) voices for the panel's voice dropdown. */
export function listWindowsVoices(): Promise<WindowsVoice[]> {
  return invoke("list_windows_voices");
}

/** Curated Piper neural voices with install state. */
export function listPiperVoices(): Promise<PiperVoiceInfo[]> {
  return invoke("list_piper_voices");
}

/** Download a Piper voice into app-data; progress arrives via onPiperDownload. */
export function downloadPiperVoice(id: string): Promise<void> {
  return invoke("download_piper_voice", { id });
}

/** Delete a downloaded Piper voice's files (clears selection if it was chosen). */
export function removePiperVoice(id: string): Promise<void> {
  return invoke("remove_piper_voice", { id });
}

/** Streamed by download_piper_voice while a model transfers. */
export function onPiperDownload(cb: (ev: PiperDownloadEvent) => void): Promise<UnlistenFn> {
  return listen<PiperDownloadEvent>("piper-download", (e) => cb(e.payload));
}

export function togglePanel(): Promise<boolean> {
  return invoke("toggle_panel");
}

export function reportAudioUnlocked(unlocked: boolean): Promise<void> {
  return invoke("report_audio_unlocked", { unlocked });
}
