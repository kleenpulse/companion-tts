import { create } from "zustand";
import {
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
  ProviderStatus,
  SessionInfo,
  Settings,
} from "../shared/types";
import { blurbFor } from "../speech/blurbs";
import { fixMojibake } from "../speech/transform";

interface PanelState {
  engineState: EngineState | null;
  sessions: SessionInfo[];
  settings: Settings | null;
  envKeys: EnvKeys | null;
  providers: ProviderStatus[];
  backfill: FeedItem[];
  backfillFor: string | null;
  watcherStatus: string;
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
  providers: [],
  backfill: [],
  backfillFor: null,
  watcherStatus: "starting",

  async init() {
    if (booted) return;
    booted = true;

    const [payload, sessions, providers] = await Promise.all([
      getSettings(),
      listSessions(),
      providerStatus(),
    ]);
    set({ settings: payload.settings, envKeys: payload.envKeys, sessions, providers });

    await onSettingsUpdated((p) => set({ settings: p.settings, envKeys: p.envKeys }));
    await onSessionsUpdated((s) => set({ sessions: s }));
    await onWatcherStatus((s) => set({ watcherStatus: s }));
    await onEngineState((engineState) => {
      set({ engineState });
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
    set({ settings: res.settings, envKeys: res.envKeys });
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
  const items: FeedItem[] = [];
  for (const ev of events) {
    if (ev.kind === "text") {
      const t = fixMojibake(ev.text).replace(/\s+/g, " ").trim();
      if (t) {
        items.push({
          id: `bf:${ev.uuid}`,
          kind: "prose",
          status: "done",
          displayText: t.length > 160 ? `${t.slice(0, 160)}…` : t,
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
          sessionId,
        });
      }
    }
  }
  set({ backfill: items });
}
