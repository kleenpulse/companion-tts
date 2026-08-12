import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
  downloadPiperVoice,
  listPiperVoices,
  listWindowsVoices,
  onPiperDownload,
  removePiperVoice,
  sendEngineCmd,
} from "../shared/bus";
import type {
  CloudProviderId,
  PiperVoiceInfo,
  ProviderId,
  WindowsVoice,
} from "../shared/types";
import { usePanelStore } from "./panelStore";
import { PillTabs } from "./PillTabs";

export function ProviderCard() {
  const { settings, providers, engineState, saveSettings, refreshProviders } = usePanelStore();
  const [voices, setVoices] = useState<{ elevenlabs?: string; mistral?: string }>({});
  const [winVoices, setWinVoices] = useState<WindowsVoice[]>([]);
  const [piperVoices, setPiperVoices] = useState<PiperVoiceInfo[]>([]);
  /** id → download fraction (0..1), or -1 for indeterminate. */
  const [piperProgress, setPiperProgress] = useState<Record<string, number>>({});
  /** Voice picked from the dropdown that is still downloading — activated on "done". */
  const [piperPending, setPiperPending] = useState<string | null>(null);
  const piperPendingRef = useRef<string | null>(null);
  /** X clicked once — the row asks before deleting the downloaded model. */
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    void listWindowsVoices().then(setWinVoices).catch(() => setWinVoices([]));
    void listPiperVoices().then(setPiperVoices).catch(() => setPiperVoices([]));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPiperDownload((ev) => {
      if (ev.phase === "downloading") {
        setPiperProgress((p) => ({ ...p, [ev.id]: ev.total > 0 ? ev.received / ev.total : -1 }));
      } else {
        setPiperProgress((p) => {
          const { [ev.id]: _done, ...rest } = p;
          return rest;
        });
        // A dropdown pick that triggered this download activates on success.
        if (piperPendingRef.current === ev.id) {
          piperPendingRef.current = null;
          setPiperPending(null);
          if (ev.phase === "done") {
            const s = usePanelStore.getState().settings;
            if (s) {
              void usePanelStore
                .getState()
                .saveSettings({ voices: { ...s.voices, piper: ev.id } });
            }
          }
        }
        void listPiperVoices().then(setPiperVoices).catch(() => {});
        void refreshProviders();
      }
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
    // refreshProviders is a stable store action
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settings) return null;

  const primary = settings.providerOrder[0] ?? "elevenlabs";
  const anyFailed = providers.some((p) => p.permanentlyFailed);
  const active = engineState?.activeProvider;
  // hasKey mirrors the synth walk's eligibility predicate — for piper it means
  // "voice downloaded". Windows is always eligible, so it never banners.
  const primaryBlocked = providers.some((p) => p.id === primary && !p.hasKey);

  const setPrimary = (p: ProviderId) => {
    // Order-preserving promote — mirrors Rust promote_provider semantics.
    const order = [p, ...settings.providerOrder.filter((x) => x !== p)];
    void saveSettings({ providerOrder: order });
    void refreshProviders();
  };

  const commitVoice = (id: CloudProviderId) => {
    const v = voices[id]?.trim();
    if (!v || v === settings.voices[id]) return;
    void saveSettings({ voices: { ...settings.voices, [id]: v } });
  };

  const failed = (id: ProviderId) => providers.find((p) => p.id === id)?.permanentlyFailed;

  return (
    <div className="border-t border-hairline">
      <div className="flex w-full items-center justify-between px-3 py-2 font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
        <span className="flex items-center gap-1.5">
          Voice
          <span className="normal-case tracking-normal text-ink-mute/80">· {primary}</span>
          {/* the voice actually speaking, whenever it diverges from the
              selection — informational, not an error; degraded/unavailable
              badges carry the danger signal */}
          {active && active !== primary && (
            <span className="rounded-sm border border-hairline bg-bench-700 px-1 text-[8px] normal-case tracking-normal text-ink-mute">
              speaking: {active}
            </span>
          )}
          {anyFailed && (
            <span className="rounded-sm border border-danger/40 bg-danger/10 px-1 text-[8px] tracking-[0.15em] text-danger">
              degraded
            </span>
          )}
        </span>
      </div>
      <div className="px-3 pb-2.5">
          <div className="flex flex-col gap-1">
            <span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
              Primary
            </span>
            <PillTabs
              label="provider"
              value={primary}
              options={[
                { value: "elevenlabs", label: "ElevenLabs" },
                { value: "mistral", label: "Mistral" },
                { value: "piper", label: "Piper" },
                { value: "windows", label: "On-device" },
              ]}
              onChange={setPrimary}
            />
          </div>
          {/* Selection sticks even when unusable — this banner says why it's
              silent and where the missing piece goes. */}
          <AnimatePresence initial={false}>
            {primaryBlocked && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 350, damping: 30 }}
                className="overflow-hidden"
              >
                <div className="mt-1.5 rounded-md border border-hairline bg-raised px-2.5 py-1.5">
                  <span className="font-display text-[9px] uppercase tracking-[0.15em] text-accent">
                    {primary} needs setup
                  </span>
                  <p className="mt-0.5 text-[10px] leading-snug text-ink-dim">
                    {primary === "piper"
                      ? "No voice downloaded — pick one from the Piper voice list below."
                      : `No API key — add one under General, or set the ${
                          primary === "elevenlabs" ? "ELEVEN_LABS" : "MISTRAL_API_KEY"
                        } env var. Speech falls back to the next available voice meanwhile.`}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            {(["elevenlabs", "mistral"] as const).map((id) => (
              <label key={id} className="block min-w-0">
                <span className="flex items-center gap-1.5 font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
                  {id === "elevenlabs" ? "11L voice id" : "Voxtral voice"}
                  {failed(id) && (
                    <span className="rounded-sm border border-danger/40 bg-danger/10 px-1 text-[8px] text-danger">
                      unavailable
                    </span>
                  )}
                </span>
                <input
                  defaultValue={settings.voices[id]}
                  onChange={(e) => setVoices((v) => ({ ...v, [id]: e.target.value }))}
                  onBlur={() => commitVoice(id)}
                  spellCheck={false}
                  className="mt-0.5 w-full rounded-md border border-hairline bg-surface px-1.5 py-1 font-mono text-[10px] text-ink-dim outline-none transition-colors duration-200 focus:border-accent/40"
                />
              </label>
            ))}
            <label className="col-span-2 block min-w-0">
              <span className="flex items-center gap-1.5 font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
                Windows voice
                <span className="rounded-sm border border-hairline bg-bench-700 px-1 text-[8px] normal-case tracking-normal text-ink-mute">
                  no key needed
                </span>
              </span>
              <select
                value={settings.voices.windows}
                onChange={(e) =>
                  void saveSettings({ voices: { ...settings.voices, windows: e.target.value } })
                }
                className="mt-0.5 w-full rounded-md border border-hairline bg-surface px-1.5 py-1 font-mono text-[10px] text-ink-dim outline-none transition-colors duration-200 focus:border-accent/40"
              >
                <option value="">System default</option>
                {winVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.language})
                  </option>
                ))}
              </select>
            </label>
            <label className="col-span-2 block min-w-0">
              <span className="flex items-center gap-1.5 font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
                Piper voice
                <span className="rounded-sm border border-hairline bg-bench-700 px-1 text-[8px] normal-case tracking-normal text-ink-mute">
                  neural · offline
                </span>
                {piperPending && (
                  <span className="font-mono text-[9px] normal-case tracking-normal text-accent">
                    {(piperProgress[piperPending] ?? -1) >= 0
                      ? `downloading ${Math.round((piperProgress[piperPending] ?? 0) * 100)}%`
                      : "downloading…"}
                  </span>
                )}
              </span>
              <div className="mt-0.5 flex items-center gap-1">
                <select
                  value={piperPending ?? settings.voices.piper}
                  disabled={!!piperPending}
                  onChange={(e) => {
                    setConfirmRemove(false);
                    const id = e.target.value;
                    if (!id) {
                      void saveSettings({ voices: { ...settings.voices, piper: "" } });
                      return;
                    }
                    const v = piperVoices.find((x) => x.id === id);
                    if (!v) return;
                    if (v.installed) {
                      void saveSettings({ voices: { ...settings.voices, piper: id } });
                      return;
                    }
                    // Not on disk yet: download first, activate on "done".
                    piperPendingRef.current = id;
                    setPiperPending(id);
                    setPiperProgress((p) => ({ ...p, [id]: -1 }));
                    void downloadPiperVoice(id).catch(() => {
                      piperPendingRef.current = null;
                      setPiperPending(null);
                    });
                  }}
                  className="mt-0 w-full min-w-0 flex-1 rounded-md border border-hairline bg-surface px-1.5 py-1 font-mono text-[10px] text-ink-dim outline-none transition-colors duration-200 focus:border-accent/40 disabled:opacity-60"
                >
                  <option value="">None</option>
                  {piperVoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} · {v.language.replace("_", "-")}
                      {v.installed ? "" : ` · get ~${v.sizeMb} MB`}
                    </option>
                  ))}
                </select>
                {!piperPending &&
                  !confirmRemove &&
                  piperVoices.find((v) => v.id === settings.voices.piper)?.installed && (
                    <button
                      onClick={() => setConfirmRemove(true)}
                      title="Remove downloaded voice"
                      aria-label="Remove downloaded Piper voice"
                      className="shrink-0 rounded-md border border-hairline bg-bench-700 p-1 text-ink-mute transition-colors duration-200 hover:text-danger"
                    >
                      <X size={11} strokeWidth={1.75} />
                    </button>
                  )}
              </div>
              {confirmRemove && (
                <div className="mt-1 flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-1.5 py-1">
                  <span className="min-w-0 flex-1 truncate font-display text-[9px] uppercase tracking-[0.15em] text-danger">
                    Delete{" "}
                    {piperVoices.find((v) => v.id === settings.voices.piper)?.label ??
                      settings.voices.piper}{" "}
                    from disk?
                  </span>
                  <button
                    onClick={() => {
                      setConfirmRemove(false);
                      void removePiperVoice(settings.voices.piper)
                        .then(() => listPiperVoices().then(setPiperVoices))
                        .then(() =>
                          saveSettings({ voices: { ...settings.voices, piper: "" } })
                        );
                    }}
                    className="shrink-0 rounded-md border border-danger/40 bg-danger/15 px-1.5 py-0.5 font-display text-[9px] uppercase tracking-[0.15em] text-danger transition-colors duration-200 hover:bg-danger/25"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setConfirmRemove(false)}
                    className="shrink-0 rounded-md border border-hairline bg-bench-700 px-1.5 py-0.5 font-display text-[9px] uppercase tracking-[0.15em] text-ink-dim transition-colors duration-200 hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {piperPending && (piperProgress[piperPending] ?? -1) >= 0 && (
                <span className="mt-1 block h-0.5 overflow-hidden rounded-full bg-hairline">
                  <span
                    className="block h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{
                      width: `${Math.round((piperProgress[piperPending] ?? 0) * 100)}%`,
                    }}
                  />
                </span>
              )}
            </label>
          </div>
          <button
            onClick={() => void sendEngineCmd({ cmd: "speak-test" })}
            className="mt-2 w-full rounded-md border border-hairline bg-bench-700 px-2 py-1.5 font-display text-[10px] uppercase tracking-[0.15em] text-ink-dim transition-colors duration-200 hover:bg-bench-500/60 hover:text-accent"
          >
            Speak test
          </button>
      </div>
    </div>
  );
}
