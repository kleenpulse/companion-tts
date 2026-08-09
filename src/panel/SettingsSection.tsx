import { useEffect, useRef, useState } from "react";
import {
  attentionHookStatus,
  endFabPreview,
  installAttentionHook,
  previewFabScale,
} from "../shared/bus";
import { fabLevelToScale, fabScaleToLevel } from "../shared/format";
import type { CloudProviderId } from "../shared/types";
import { usePanelStore } from "./panelStore";
import { PillTabs } from "./PillTabs";

export function SettingsSection() {
  const { settings, envKeys, saveSettings, refreshProviders } = usePanelStore();
  const [draft, setDraft] = useState<{ elevenlabs?: string; mistral?: string }>({});
  const [hookInstalled, setHookInstalled] = useState<boolean | null>(null);
  const [fabScaleDraft, setFabScaleDraft] = useState<number | null>(null);
  const fabScaleCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewEnd = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void attentionHookStatus().then(setHookInstalled);
  }, []);

  // Never leave a stray preview dial on screen.
  useEffect(() => {
    return () => {
      if (previewEnd.current) {
        clearTimeout(previewEnd.current);
        void endFabPreview();
      }
    };
  }, []);

  if (!settings) return null;

  const installHook = () => {
    void installAttentionHook()
      .then(setHookInstalled)
      .catch(() => setHookInstalled(false));
  };

  const commitFabScale = (v: number) => {
    // The real dial appears beside the panel, scaled live, while tuning.
    void previewFabScale(v);
    if (previewEnd.current) clearTimeout(previewEnd.current);
    previewEnd.current = setTimeout(() => {
      previewEnd.current = null;
      void endFabPreview();
    }, 1400);

    if (fabScaleCommit.current) clearTimeout(fabScaleCommit.current);
    fabScaleCommit.current = setTimeout(() => void saveSettings({ fabScale: v }), 300);
  };

  const commitKey = (id: CloudProviderId) => {
    const v = draft[id];
    if (v === undefined || v === settings.keys[id]) return;
    void saveSettings({ keys: { ...settings.keys, [id]: v.trim() } }).then(() => refreshProviders());
  };

  return (
    <div className="border-t border-hairline">
      <div className="px-3 py-2 font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
        General
      </div>
      <div className="flex flex-col gap-2 px-3 pb-2.5">
          {(["elevenlabs", "mistral"] as const).map((id) => (
            <label key={id} className="block">
              <span className="flex items-center gap-1.5 font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
                {id === "elevenlabs" ? "ElevenLabs key" : "Mistral key"}
                {envKeys?.[id] && (
                  <span className="rounded-sm border border-accent/40 bg-accent/10 px-1 text-[8px] text-accent">
                    env
                  </span>
                )}
              </span>
              <input
                type="password"
                placeholder={envKeys?.[id] ? "supplied by environment" : "paste API key"}
                defaultValue={settings.keys[id]}
                onChange={(e) => setDraft((d) => ({ ...d, [id]: e.target.value }))}
                onBlur={() => commitKey(id)}
                spellCheck={false}
                className="mt-0.5 w-full rounded-md border border-hairline bg-surface px-1.5 py-1 font-mono text-[10px] text-ink-dim outline-none transition-colors duration-200 focus:border-accent/40"
              />
            </label>
          ))}
          <label className="flex items-center justify-between rounded-md px-0.5 py-0.5">
            <span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
              Start with Windows
            </span>
            <input
              type="checkbox"
              checked={settings.autostart}
              onChange={(e) => void saveSettings({ autostart: e.target.checked })}
              className="h-3.5 w-3.5 accent-accent"
            />
          </label>
          <label className="flex items-center justify-between rounded-md px-0.5 py-0.5">
            <span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
              Voice visualizer
            </span>
            <input
              type="checkbox"
              checked={settings.visualizer}
              onChange={(e) => void saveSettings({ visualizer: e.target.checked })}
              className="h-3.5 w-3.5 accent-accent"
            />
          </label>
          <label className="flex items-center justify-between rounded-md px-0.5 py-0.5">
            <span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
              Typewriter reveal
            </span>
            <input
              type="checkbox"
              checked={settings.typewriter}
              onChange={(e) => void saveSettings({ typewriter: e.target.checked })}
              className="h-3.5 w-3.5 accent-accent"
            />
          </label>
          <div className="flex items-center justify-between rounded-md px-0.5 py-0.5">
            <span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
              Visualizer style
            </span>
            <PillTabs
              label="visualizer style"
              value={settings.visualizerStyle}
              options={[
                { value: "waves", label: "Waves" },
                { value: "strands", label: "Strands" },
              ]}
              onChange={(v) => void saveSettings({ visualizerStyle: v })}
            />
          </div>
          <div className="flex items-center justify-between rounded-md px-0.5 py-0.5">
            <span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
              Theme
            </span>
            <PillTabs
              label="theme"
              value={settings.theme}
              options={[
                { value: "system", label: "System" },
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
              ]}
              onChange={(v) => void saveSettings({ theme: v })}
            />
          </div>
          <label className="block rounded-md px-0.5 py-0.5">
            <span className="flex items-center justify-between font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
              Fab size
              <span className="font-mono normal-case tracking-normal">
                {fabScaleToLevel(fabScaleDraft ?? settings.fabScale ?? 1)} · ×
                {fabLevelToScale(fabScaleToLevel(fabScaleDraft ?? settings.fabScale ?? 1))}
              </span>
            </span>
            <input
              aria-label="Floating dial size"
              type="range"
              min={1}
              max={10}
              step={1}
              value={fabScaleToLevel(fabScaleDraft ?? settings.fabScale ?? 1)}
              onChange={(e) => {
                const v = fabLevelToScale(Number(e.target.value));
                setFabScaleDraft(v);
                commitFabScale(v);
              }}
              className="mt-1 w-full"
            />
          </label>
          <div className="flex items-center justify-between rounded-md px-0.5 py-0.5">
            <span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
              Attention hook
            </span>
            {hookInstalled === null ? (
              <span className="font-mono text-[10px] text-ink-mute">…</span>
            ) : hookInstalled ? (
              <span className="rounded-sm border border-accent/40 bg-accent/10 px-1 font-display text-[8px] uppercase tracking-[0.15em] text-accent">
                installed
              </span>
            ) : (
              <button
                onClick={installHook}
                className="rounded-md border border-hairline bg-bench-700 px-2 py-0.5 font-display text-[9px] uppercase tracking-[0.15em] text-ink-dim transition-colors duration-200 hover:text-accent"
              >
                Install
              </button>
            )}
          </div>
          <div className="flex items-center justify-between text-[10px] text-ink-mute">
            <span className="font-display uppercase tracking-[0.15em]">Shortcuts</span>
            <span className="font-mono">
              {settings.shortcuts.mute} mute · {settings.shortcuts.pauseResume} pause
            </span>
          </div>
      </div>
    </div>
  );
}
