import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { quitApp } from "../shared/bus";
import { usePanelStore } from "./panelStore";

/**
 * The app's only modal: confirm before the panel × kills the process.
 * Escape is handled by PanelShell's chain (dialog first); scrim click and
 * Cancel both dismiss. Unchecking "always ask" persists confirmQuit=false
 * BEFORE exiting so the choice survives.
 */
export function QuitConfirm() {
  const { quitConfirmOpen, setQuitConfirm, saveSettings } = usePanelStore();
  const [alwaysAsk, setAlwaysAsk] = useState(true);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Fresh checkbox each opening — a stale unchecked box must not silently
  // disable confirmation from a previous, cancelled attempt.
  useEffect(() => {
    if (quitConfirmOpen) {
      setAlwaysAsk(true);
      cancelRef.current?.focus();
    }
  }, [quitConfirmOpen]);

  const quit = async () => {
    if (!alwaysAsk) await saveSettings({ confirmQuit: false });
    await quitApp(); // never resolves — the process exits
  };

  return (
    <AnimatePresence>
      {quitConfirmOpen && (
        <motion.div
          key="quit-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 z-50 flex items-center justify-center bg-bench-950/60 p-6"
          onClick={() => setQuitConfirm(false)}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Quit Companion"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 350, damping: 30 }}
            className="w-full max-w-70 rounded-md border border-hairline bg-raised p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
              Quit Companion
            </div>
            <p className="mt-1.5 text-[12px] leading-snug text-ink-dim">
              Narration stops and the dial disappears until you launch it again.
            </p>
            <label className="mt-2.5 flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={alwaysAsk}
                onChange={(e) => setAlwaysAsk(e.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              <span className="font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
                Always ask before quitting
              </span>
            </label>
            <div className="mt-3 flex justify-end gap-1.5">
              <button
                ref={cancelRef}
                onClick={() => setQuitConfirm(false)}
                className="rounded-md border border-hairline bg-bench-700 px-2 py-1 font-display text-[9px] uppercase tracking-[0.15em] text-ink-dim transition-colors duration-200 hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={() => void quit()}
                className="rounded-md border border-danger/40 bg-danger/15 px-2 py-1 font-display text-[9px] uppercase tracking-[0.15em] text-danger transition-colors duration-200 hover:bg-danger/25"
              >
                Quit
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
