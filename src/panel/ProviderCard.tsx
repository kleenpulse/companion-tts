import { Check, X } from "lucide-react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
  cancelPiperDownload,
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

/** Springs overshoot; the scrub must not. */
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function ProviderCard() {
  const { settings, providers, engineState, plannedProvider, saveSettings, refreshProviders } =
    usePanelStore();
  /** Rejection shake for a pill picked while its provider can't serve. */
  const [shake, setShake] = useState<{ value: ProviderId; key: number } | null>(null);
  const [voices, setVoices] = useState<{ elevenlabs?: string; mistral?: string }>({});
  const [winVoices, setWinVoices] = useState<WindowsVoice[]>([]);
  const [piperVoices, setPiperVoices] = useState<PiperVoiceInfo[]>([]);
  /** Voice picked from the dropdown that is still downloading — activated on "done". */
  const [piperPending, setPiperPending] = useState<string | null>(null);
  const piperPendingRef = useRef<string | null>(null);
  /** Indeterminate until the model response reports a content-length. */
  const [dlMode, setDlMode] = useState<"indeterminate" | "determinate">("indeterminate");
  /** Past halfway, cancelling asks first — that's a lot of bytes to throw away. */
  const [confirmCancel, setConfirmCancel] = useState(false);
  /** Why the last download died, so a failure isn't silent. */
  const [dlError, setDlError] = useState<string | null>(null);
  /** X clicked once — the row asks before deleting the downloaded model. */
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Chunk events land in bursts (~128KB apart, irregularly spaced), so the raw
  // fraction steps. A spring low-passes it: the bar and the percentage glide
  // between samples and never re-render React to do it.
  const dlRaw = useMotionValue(0);
  const dlSmooth = useSpring(dlRaw, { stiffness: 140, damping: 26, mass: 0.4, restDelta: 0.0004 });
  const dlPct = useTransform(dlSmooth, (v) => `${Math.round(clamp01(v) * 100)}%`);
  // The scrub is a full-width gradient with a cover sliding off it, so the only
  // animated property is a transform — motion writes those straight to the DOM.
  const dlCover = useTransform(dlSmooth, (v) => 1 - clamp01(v));

  useEffect(() => {
    void listWindowsVoices().then(setWinVoices).catch(() => setWinVoices([]));
    void listPiperVoices().then(setPiperVoices).catch(() => setPiperVoices([]));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPiperDownload((ev) => {
      const mine = ev.id === piperPendingRef.current;
      if (ev.phase === "downloading") {
        if (mine && ev.total > 0) {
          setDlMode("determinate");
          dlRaw.set(ev.received / ev.total);
        }
      } else {
        // A dropdown pick that triggered this download activates on success.
        if (mine) {
          piperPendingRef.current = null;
          setPiperPending(null);
          setConfirmCancel(false);
          if (ev.phase === "done") {
            // Land on full before the bar fades out — the last chunk event is
            // always a hair short of 100%.
            dlRaw.set(1);
            const s = usePanelStore.getState().settings;
            if (s) {
              void usePanelStore
                .getState()
                .saveSettings({ voices: { ...s.voices, piper: ev.id } });
            }
          } else {
            // Canceled or failed: the bar is leaving, so reset rather than glide.
            dlRaw.jump(0);
            dlSmooth.jump(0);
            setDlMode("indeterminate");
            if (ev.phase === "error") setDlError(ev.error ?? "download failed");
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
  // The pill row shows the voice that will actually speak (Rust's plan head).
  // providerOrder keeps the user's intent — it is never rewritten, so a
  // blocked choice restores itself the moment its missing piece arrives.
  const effective = plannedProvider ?? primary;
  // hasKey mirrors the synth walk's eligibility predicate — for piper it means
  // "voice downloaded". Windows is always eligible, so it never banners.
  const primaryBlocked = providers.some((p) => p.id === primary && !p.hasKey);
  const primaryFailed = providers.some((p) => p.id === primary && p.permanentlyFailed);

  const setPrimary = (p: ProviderId) => {
    const status = providers.find((x) => x.id === p);
    if (status && (!status.hasKey || status.permanentlyFailed)) {
      // The pick still saves (it's the stored intent) but can't serve — the
      // indicator stays on the fallback, so the shake carries the "no".
      setShake((s) => ({ value: p, key: (s?.key ?? 0) + 1 }));
    }
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
          <span className="normal-case tracking-normal text-ink-mute/80">· {effective}</span>
          {/* transient truth: what actually served last, when it disagrees
              with the plan (a breaker tripped mid-walk) — accent because the
              live voice outranks the stale plan until the next settings save */}
          {active && active !== effective && (
            <span className="rounded-sm border border-accent/40 bg-accent/10 px-1 text-[8px] normal-case tracking-normal text-accent">
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
              value={effective}
              options={[
                { value: "elevenlabs", label: "ElevenLabs" },
                { value: "mistral", label: "Mistral" },
                { value: "piper", label: "Piper" },
                { value: "windows", label: "On-device" },
              ]}
              onChange={setPrimary}
              shake={shake}
            />
          </div>
          {/* Intent sticks even when unusable (the pill just won't land on
              it) — this banner says why and where the missing piece goes. */}
          <AnimatePresence initial={false}>
            {(primaryBlocked || primaryFailed) && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 350, damping: 30 }}
                className="overflow-hidden"
              >
                <div className="mt-1.5 rounded-md border border-hairline bg-raised px-2.5 py-1.5">
                  <span className="font-display text-[9px] uppercase tracking-[0.15em] text-accent">
                    {primary} {primaryBlocked ? "needs setup" : "unavailable"}
                  </span>
                  <p className="mt-0.5 text-[10px] leading-snug text-ink-dim">
                    {primaryBlocked
                      ? primary === "piper"
                        ? "No voice downloaded — pick one from the Piper voice list below."
                        : `No API key — add one under General, or set the ${
                            primary === "elevenlabs" ? "ELEVEN_LABS" : "MISTRAL_API_KEY"
                          } env var. Speaking with ${effective} meanwhile.`
                      : `The API rejected the key — re-save it under General to retry. Speaking with ${effective} meanwhile.`}
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
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
                    {dlMode === "determinate" ? (
                      <>
                        downloading <motion.span>{dlPct}</motion.span>
                      </>
                    ) : (
                      "downloading…"
                    )}
                  </span>
                )}
              </span>
              <div className="mt-0.5 flex items-center gap-1">
                <select
                  value={piperPending ?? settings.voices.piper}
                  disabled={!!piperPending}
                  onChange={(e) => {
                    setConfirmRemove(false);
                    setDlError(null);
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
                    setDlMode("indeterminate");
                    setConfirmCancel(false);
                    dlRaw.jump(0);
                    dlSmooth.jump(0);
                    void downloadPiperVoice(id).catch(() => {
                      piperPendingRef.current = null;
                      setPiperPending(null);
                    });
                  }}
                  className="mt-0 w-full min-w-0 flex-1 rounded-md border border-hairline bg-surface px-1.5 py-1 font-mono text-[10px] text-ink-dim outline-none transition-colors duration-200 focus:border-accent/40 disabled:opacity-60"
                >
                  <option value="">None</option>
                  {piperVoices.map((v) => (
                    // Chromium honors color on <option>; the accent var flips
                    // with the theme, so installed reads on either popup bg.
                    <option
                      key={v.id}
                      value={v.id}
                      className={v.installed ? "text-accent" : "text-ink-mute"}
                    >
                      {v.label} · {v.language.replace("_", "-")}
                      {v.installed ? " · on disk" : ` · get ~${v.sizeMb} MB`}
                    </option>
                  ))}
                </select>
                {piperPending &&
                  (confirmCancel ? (
                    // Past halfway: the X becomes a question, and these answer it.
                    <>
                      <button
                        onClick={() => void cancelPiperDownload(piperPending)}
                        title="Yes, cancel the download"
                        aria-label="Confirm cancelling the download"
                        className="shrink-0 rounded-md border border-danger/40 bg-danger/15 p-1 text-danger transition-colors duration-200 hover:bg-danger/25"
                      >
                        <Check size={11} strokeWidth={2} />
                      </button>
                      <button
                        onClick={() => setConfirmCancel(false)}
                        title="Keep downloading"
                        aria-label="Keep downloading"
                        className="shrink-0 rounded-md border border-hairline bg-bench-700 p-1 text-ink-mute transition-colors duration-200 hover:text-ink"
                      >
                        <X size={11} strokeWidth={1.75} />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        // Under half (or size still unknown) there's little to
                        // lose — stop immediately instead of nagging.
                        if (dlRaw.get() > 0.5) setConfirmCancel(true);
                        else void cancelPiperDownload(piperPending);
                      }}
                      title="Cancel download"
                      aria-label="Cancel Piper voice download"
                      className="shrink-0 rounded-md border border-hairline bg-bench-700 p-1 text-ink-mute transition-colors duration-200 hover:text-danger"
                    >
                      <X size={11} strokeWidth={1.75} />
                    </button>
                  ))}
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
              <AnimatePresence>
                {piperPending && (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className="relative mt-1 block h-1 overflow-hidden rounded-full bg-hairline"
                  >
                    {dlMode === "determinate" ? (
                      // The triad is painted across the whole track and never
                      // moves — the cover retreats off it. So the leading edge
                      // walks violet→magenta→cyan, and the one animated
                      // property is a transform.
                      <>
                        <span className="grainient-scrub absolute inset-0 block" />
                        <motion.span
                          className="grainient-sheen absolute inset-y-0 left-0 block w-1/4"
                          animate={{ x: ["-120%", "440%"] }}
                          transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
                        />
                        <motion.span
                          className="absolute inset-0 block origin-right bg-hairline"
                          style={{ scaleX: dlCover }}
                        />
                      </>
                    ) : (
                      // No content-length yet (the tiny config file downloads
                      // first) — sweep rather than sit at a dead zero.
                      <motion.span
                        className="grainient-scrub absolute inset-y-0 left-0 block w-2/5 rounded-full"
                        animate={{ x: ["-105%", "255%"] }}
                        transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                      />
                    )}
                  </motion.span>
                )}
              </AnimatePresence>
              {dlError && !piperPending && (
                <div className="mt-1 flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-1.5 py-1">
                  <span className="min-w-0 flex-1 truncate text-[10px] leading-snug text-danger">
                    Download failed — {dlError}
                  </span>
                  <button
                    onClick={() => setDlError(null)}
                    aria-label="Dismiss download error"
                    className="shrink-0 text-danger/70 transition-colors duration-200 hover:text-danger"
                  >
                    <X size={11} strokeWidth={1.75} />
                  </button>
                </div>
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
