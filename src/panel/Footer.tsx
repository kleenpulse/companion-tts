import { compactChars, costEstimate } from "../shared/format";
import { usePanelStore } from "./panelStore";
import { useViewStore } from "./viewStore";

export function Footer() {
  const { settings, watcherStatus, engineState } = usePanelStore();
  const openSettings = useViewStore((s) => s.openSettings);
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
      <span className="flex items-center gap-1.5 justify-self-start font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </span>
      <button
        onClick={() => openSettings("voice")}
        title="Voice settings"
        className="justify-self-center font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute transition-colors duration-200 hover:text-ink"
      >
        voice: {voiceMode}
      </button>
      <span className="justify-self-end font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
        {compactChars(chars)} chars · {costEstimate(chars)} mo
      </span>
    </footer>
  );
}
