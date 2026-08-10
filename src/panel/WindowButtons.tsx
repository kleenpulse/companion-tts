import { Minus, X } from "lucide-react";
import { quitApp, togglePanel } from "../shared/bus";
import { usePanelStore } from "./panelStore";

/**
 * The window-control pair every panel header shares: − collapses to the
 * floating dial, × quits the app (behind the confirm dialog unless the user
 * disabled it).
 */
export function WindowButtons() {
  const { settings, setQuitConfirm } = usePanelStore();
  const base =
    "rounded-md p-1 text-ink-mute transition-colors duration-200 hover:bg-raised";

  return (
    <>
      <button
        aria-label="Collapse to floating dial"
        title="Collapse to floating dial"
        onClick={() => void togglePanel()}
        className={`${base} hover:text-ink`}
      >
        <Minus size={14} strokeWidth={2} />
      </button>
      <button
        aria-label="Quit Companion"
        title="Quit Companion"
        onClick={() =>
          settings?.confirmQuit === false ? void quitApp() : setQuitConfirm(true)
        }
        className={`${base} hover:text-danger`}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </>
  );
}
