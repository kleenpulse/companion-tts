import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { togglePanel } from "../shared/bus";
import { applyTheme } from "../shared/theme";
import { ChangelogView } from "./ChangelogView";
import { Footer } from "./Footer";
import { MainView } from "./MainView";
import { QuitConfirm } from "./QuitConfirm";
import { usePanelStore } from "./panelStore";
import { SettingsView } from "./SettingsView";
import { useViewStore } from "./viewStore";

/** Direction-aware micro-slide: settings enters from the right, main from the left. */
const viewMotion = (dir: 1 | -1) => ({
  initial: { opacity: 0, x: 12 * dir },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -12 * dir },
  transition: { type: "tween" as const, duration: 0.15, ease: "easeOut" as const },
});

export function PanelShell() {
  const init = usePanelStore((s) => s.init);
  const theme = usePanelStore((s) => s.settings?.theme);
  const view = useViewStore((s) => s.view);

  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    void init();
    // Settings moved to their own view — the sized sections box is gone.
    localStorage.removeItem("companion.ui.sectionsH");
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Dialog outranks views: Escape dismisses the quit confirm, never the panel.
      const { quitConfirmOpen, setQuitConfirm } = usePanelStore.getState();
      if (quitConfirmOpen) {
        setQuitConfirm(false);
        return;
      }
      const { view: current, closeSettings, closeChangelog } = useViewStore.getState();
      if (current === "changelog") closeChangelog();
      else if (current === "settings") closeSettings();
      else void togglePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [init]);

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-hairline bg-panel">
      <QuitConfirm />
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {view === "main" ? (
            <motion.div key="main" className="h-full" {...viewMotion(-1)}>
              <MainView />
            </motion.div>
          ) : view === "settings" ? (
            <motion.div key="settings" className="h-full" {...viewMotion(1)}>
              <SettingsView />
            </motion.div>
          ) : (
            <motion.div key="changelog" className="h-full" {...viewMotion(1)}>
              <ChangelogView />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Footer />
    </div>
  );
}
