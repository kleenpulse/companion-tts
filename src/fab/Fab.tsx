import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, AudioLines, Pause, VolumeX } from "lucide-react";
import { motion } from "motion/react";
import { useRef } from "react";
import { togglePanel } from "../shared/bus";
import { engine } from "../speech/engine";
import { StrandsVisualizer } from "../viz/StrandsVisualizer";
import { useFabStore } from "./fabStore";
import { WaveRing } from "./WaveRing";

const DRAG_THRESHOLD_PX = 4;

/**
 * The floating instrument dial. Manual drag/click disambiguation:
 * pointer travel beyond 4px hands off to the OS drag loop; a clean
 * release toggles the panel. (data-tauri-drag-region eats clicks — unused.)
 */
export function Fab() {
  const { mode, queueCount, vizStyle, fabScale, vizOn, composing } = useFabStore();
  const origin = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Capture so fast drags keep streaming moves even outside the 64px window.
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = { x: e.screenX, y: e.screenY };
    dragging.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!origin.current || dragging.current) return;
    const dx = e.screenX - origin.current.x;
    const dy = e.screenY - origin.current.y;
    if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      dragging.current = true;
      void getCurrentWindow().startDragging();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be gone after an OS drag — fine
    }
    const wasDrag = dragging.current;
    origin.current = null;
    dragging.current = false;
    if (!wasDrag) void togglePanel();
  };

  const onPointerCancel = () => {
    origin.current = null;
    dragging.current = false;
  };

  const speaking = mode === "speaking";
  // Strands mode: the lens IS the fab — full-bleed glass, no dial chrome.
  // Paused deliberately keeps the lens: frozen ribbons say it, and the
  // transport already shows the state — no glyph takeover needed.
  const lensActive =
    vizStyle === "strands" && vizOn && mode !== "muted" && mode !== "error";

  return (
    <div className="flex h-screen w-screen items-center justify-center">
      <button
        type="button"
        aria-label={`Companion — ${mode}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        // The window resizes to 64×scale (Rust apply_fab_scale); the dial
        // scales as one organism — canvas, rings, glyphs — via transform.
        style={{ transform: `scale(${fabScale})` }}
        className="relative h-14 w-14 rounded-full outline-none"
      >
        {lensActive ? (
          // Full-bleed lens: the mask melts its own edge, so no dial body,
          // no rings, no black border — the glass is the whole instrument.
          // viz-env events loop back to this window, so the strands drink
          // from the same IPC stream the panel does.
          <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-full bg-bench-950 mask-[radial-gradient(circle_at_center,#000_58%,transparent_72%)]">
            <StrandsVisualizer
              glass
              playing={speaking}
              thinking={composing && !speaking}
              pixelScale={fabScale}
            />
          </span>
        ) : (
          <>
            {/* the one place the grainient lives: a 1.5px conic ring while speaking */}
            {speaking && (
              <span className="grainient-ring absolute inset-0 rounded-full p-[1.5px] opacity-60">
                <span className="block h-full w-full rounded-full bg-panel" />
              </span>
            )}

            {/* watching pulse — slow breath on an accent ring */}
            {mode === "watching" && (
              <motion.span
                className="absolute inset-0 rounded-full border border-accent/40"
                animate={{ opacity: [0.15, 0.5, 0.15] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
              />
            )}

            {/* error ring */}
            {mode === "error" && (
              <span className="absolute inset-0 rounded-full border border-danger/60" />
            )}

            {/* the dial body */}
            <span
              className={`absolute inset-0 flex items-center justify-center rounded-full border bg-panel/95 ${
                speaking ? "border-transparent" : mode === "error" ? "border-transparent" : "border-hairline"
              }`}
            >
              {speaking ? (
                <WaveRing analyser={engine.analyser} pixelScale={fabScale} />
              ) : mode === "paused" ? (
                <Pause size={18} className="text-ink-dim" strokeWidth={1.75} />
              ) : mode === "muted" ? (
                <VolumeX size={18} className="text-ink-mute" strokeWidth={1.75} />
              ) : mode === "error" ? (
                <AlertTriangle size={17} className="text-danger" strokeWidth={1.75} />
              ) : (
                <AudioLines
                  size={18}
                  strokeWidth={1.75}
                  className={mode === "watching" ? "text-accent" : "text-ink-mute"}
                />
              )}
            </span>
          </>
        )}

        {/* queue badge — a 3px amethyst dot at 45° */}
        {queueCount > 0 && !speaking && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />
        )}
      </button>
    </div>
  );
}
