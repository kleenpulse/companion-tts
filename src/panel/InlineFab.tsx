import { AlertTriangle, AudioLines, Pause, VolumeX } from "lucide-react";
import { motion } from "motion/react";
import { togglePanel } from "../shared/bus";
import { StrandsVisualizer } from "../viz/StrandsVisualizer";
import { WaveStrip } from "../viz/WaveStrip";
import { usePanelStore } from "./panelStore";

/**
 * The companion's face while the panel is open — the glass lens, mirrored from
 * admin_shadow-garden's voice-brief panel: a fixed-width round bench-950 field
 * with a radial mask melting its edge, alive at idle, reacting to the voice.
 * Fixed width is load-bearing: aspect-square needs a definite width in a flex
 * row (a stretched height resolves too late and collapses the orb to 0).
 * Clicking collapses the panel back to the floating dial.
 */
export function InlineFab() {
  const { engineState, settings } = usePanelStore();
  const mode = engineState?.mode ?? "idle";
  const speaking = mode === "speaking";
  const composing = engineState?.queue.some((u) => u.status === "synthesizing") ?? false;
  const queued =
    engineState?.queue.filter(
      (u) => u.status === "queued" || u.status === "synthesizing" || u.status === "ready"
    ).length ?? 0;
  const style = settings?.visualizerStyle ?? "strands";
  const vizOn = settings?.visualizer ?? true;
  // Paused deliberately absent: the transport button already says it, and the
  // frozen ribbons make the state obvious — the overlay was pure cosmetics.
  const glyphState = mode === "muted" || mode === "error";

  // Visualizer off: stay a compact status dial, not a lens.
  if (!vizOn) {
    return (
      <button
        type="button"
        aria-label={`Companion — ${mode}. Collapse to floating dial`}
        title="Collapse to floating dial"
        onClick={() => void togglePanel()}
        className="relative h-9 w-9 shrink-0 self-center rounded-full border border-hairline bg-panel outline-none"
      >
        <span className="absolute inset-0 flex items-center justify-center">
          {mode === "paused" ? (
            <Pause size={15} className="text-ink-dim" strokeWidth={1.75} />
          ) : mode === "muted" ? (
            <VolumeX size={15} className="text-ink-mute" strokeWidth={1.75} />
          ) : mode === "error" ? (
            <AlertTriangle size={14} className="text-danger" strokeWidth={1.75} />
          ) : (
            <AudioLines
              size={15}
              strokeWidth={1.75}
              className={speaking || mode === "watching" ? "text-accent" : "text-ink-mute"}
            />
          )}
        </span>
        {queued > 0 && <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-accent" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label={`Companion — ${mode}. Collapse to floating dial`}
      title="Collapse to floating dial"
      onClick={() => void togglePanel()}
      className="relative aspect-square w-28 shrink-0 self-center outline-none max-[400px]:w-24"
    >
      {/* bench-950 deliberately: additive ribbons need a dark field in any
          theme — the lens is a physical object, not a themed surface. */}
      <div className="h-full w-full rounded-full bg-bench-950 mask-[radial-gradient(circle_at_center,#000_55%,transparent_65%)]">
        {style === "strands" ? (
          <StrandsVisualizer glass playing={speaking} thinking={composing && !speaking} />
        ) : (
          <WaveStrip playing={speaking} thinking={composing && !speaking} />
        )}
      </div>

      {/* Readable states take the stage over the ambience. */}
      {glyphState && (
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="absolute inset-0 flex items-center justify-center rounded-full bg-bench-950/60"
        >
          {mode === "muted" ? (
            <VolumeX size={22} className="text-ink-mute" strokeWidth={1.75} />
          ) : (
            <AlertTriangle size={20} className="text-danger" strokeWidth={1.75} />
          )}
        </motion.span>
      )}

      {queued > 0 && !speaking && (
        <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent" />
      )}
    </button>
  );
}
