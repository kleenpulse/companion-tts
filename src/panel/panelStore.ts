import { create } from "zustand";
import {
  getAppVersion,
  getSettings,
  listSessions,
  onEngineState,
  onSessionsUpdated,
  onSettingsUpdated,
  onWatcherStatus,
  providerStatus,
  setSettings,
  tailBackfill,
} from "../shared/bus";
import type {
  EngineState,
  EnvKeys,
  FeedItem,
  ProviderId,
  ProviderStatus,
  SessionInfo,
  Settings,
} from "../shared/types";
import { blurbFor } from "../speech/blurbs";
import { fixMojibake } from "../speech/transform";

/** Backfill rows keep the FULL text for double-click replay — displayText is
 * truncated to 160 chars and the engine has no record of these rows. */
export type BackfillRow = FeedItem & { replayText: string };

interface PanelState {
  engineState: EngineState | null;
  sessions: SessionInfo[];
  settings: Settings | null;
  envKeys: EnvKeys | null;
  /** Rust's plan head — the provider the next utterance would use. */
  plannedProvider: ProviderId | null;
  providers: ProviderStatus[];
  backfill: BackfillRow[];
  backfillFor: string | null;
  watcherStatus: string;
  appVersion: string;
  /** Quit confirmation dialog — store-level: three headers trigger it and
   * the PanelShell escape chain must see it. */
  quitConfirmOpen: boolean;
  setQuitConfirm: (open: boolean) => void;
  init: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  refreshProviders: () => Promise<void>;
}

let booted = false;

export const usePanelStore = create<PanelState>((set, get) => ({
  engineState: null,
  sessions: [],
  settings: null,
  envKeys: null,
  plannedProvider: null,
  providers: [],
  backfill: [],
  backfillFor: null,
  watcherStatus: "starting",
  appVersion: "",
  quitConfirmOpen: false,
  setQuitConfirm: (open) => set({ quitConfirmOpen: open }),

  async init() {
    if (booted) return;
    booted = true;

    const [payload, sessions, providers, appVersion] = await Promise.all([
      getSettings(),
      listSessions(),
      providerStatus(),
      getAppVersion().catch(() => ""),
    ]);
    set({
      settings: payload.settings,
      envKeys: payload.envKeys,
      plannedProvider: payload.plannedProvider ?? null,
      sessions,
      providers,
      appVersion,
    });

    // First-ever run: seed silently so What's New only fires on real upgrades.
    if (appVersion && payload.settings.lastSeenVersion === "") {
      void get().saveSettings({ lastSeenVersion: appVersion });
    }

    await onSettingsUpdated((p) => {
      set({ settings: p.settings, envKeys: p.envKeys, plannedProvider: p.plannedProvider ?? null });
      // Breaker resets ride key/order saves — keep the badges honest.
      void get().refreshProviders();
    });
    await onSessionsUpdated((s) => set({ sessions: s }));
    await onWatcherStatus((s) => set({ watcherStatus: s }));
    await onEngineState((engineState) => {
      // A provider change mid-walk (401 tripped the breaker) is invisible to
      // settings events — re-pull statuses so "unavailable" shows immediately.
      const prevActive = get().engineState?.activeProvider;
      set({ engineState });
      if (engineState.activeProvider !== prevActive) void get().refreshProviders();
      const sid = engineState.followedSessionId;
      if (sid && sid !== get().backfillFor) {
        set({ backfillFor: sid });
        void loadBackfill(sid, set);
      }
    });
  },

  async saveSettings(patch) {
    const current = get().settings;
    if (!current) return;
    const next = { ...current, ...patch } as Settings;
    set({ settings: next }); // optimistic — the settings-updated echo confirms
    const res = await setSettings(next);
    set({
      settings: res.settings,
      envKeys: res.envKeys,
      plannedProvider: res.plannedProvider ?? null,
    });
  },

  async refreshProviders() {
    set({ providers: await providerStatus() });
  },
}));

async function loadBackfill(
  sessionId: string,
  set: (p: Partial<PanelState>) => void
): Promise<void> {
  const events = await tailBackfill(sessionId, 30);
  const items: BackfillRow[] = [];
  for (const ev of events) {
    if (ev.kind === "text") {
      const t = fixMojibake(ev.text).replace(/\s+/g, " ").trim();
      if (t) {
        items.push({
          id: `bf:${ev.uuid}`,
          kind: "prose",
          status: "done",
          displayText: t.length > 160 ? `${t.slice(0, 160)}…` : t,
          replayText: t,
          sessionId,
        });
      }
    } else if (ev.kind === "tool") {
      const b = blurbFor(ev.toolName, ev.input);
      if (b) {
        items.push({
          id: `bf:${ev.uuid}`,
          kind: "blurb",
          status: "done",
          displayText: b.phrase,
          replayText: b.phrase,
          sessionId,
        });
      }
    }
  }
  set({ backfill: items });
}
