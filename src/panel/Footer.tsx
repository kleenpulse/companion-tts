import { compactChars, costEstimate } from "../shared/format";
import { usePanelStore } from "./panelStore";
import { useViewStore } from "./viewStore";

export function Footer() {
  const { settings, watcherStatus, engineState, appVersion } = usePanelStore();
  const openSettings = useViewStore((s) => s.openSettings);
  const openChangelog = useViewStore((s) => s.openChangelog);
  const chars = settings?.monthly.chars ?? 0;

  const dot =
    watcherStatus === "dead" || engineState?.mode === "error"
      ? "bg-danger"
      : watcherStatus === "watching"
        ? "bg-accent"
        : "bg-ink-mute";

  const label =
    engineState?.mode === "error" && !engineState.audioUnlocked
      ? "audio blocked"
      : watcherStatus === "watching"
        ? "watching transcripts"
        : watcherStatus === "dead"
          ? "watcher dead"
          : "starting";

  // Live: the provider actually speaking; falls back to the configured primary.
  const voiceMode = engineState?.activeProvider ?? settings?.providerOrder[0] ?? "—";

  return (
    <footer className="grid grid-cols-[1fr_auto_1fr] items-center border-t border-hairline px-3 py-2">
      {/* Narrow panel sheds cosmetics, never signals: version → cost → status
          text (dot stays). Health dot and the voice shortcut always survive. */}
      <span
        title={label}
        className="flex items-center gap-1.5 justify-self-start whitespace-nowrap font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="hidden min-[390px]:inline">{label}</span>
      </span>
      <button
        onClick={() => openSettings("voice")}
        title="Voice settings"
        className="justify-self-center whitespace-nowrap font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute transition-colors duration-200 hover:text-ink"
      >
        voice: {voiceMode}
      </button>
      <span className="justify-self-end whitespace-nowrap font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
        {compactChars(chars)} chars
        <span className="hidden min-[430px]:inline"> · {costEstimate(chars)} mo</span>
        {appVersion && (
          <span className="hidden min-[480px]:inline">
            {" · "}
            <button
              onClick={openChangelog}
              title="View changelog"
              className="transition-colors duration-200 hover:text-ink"
            >
              v{appVersion}
            </button>
          </span>
        )}
      </span>
    </footer>
  );
}
