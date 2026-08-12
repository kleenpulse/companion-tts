import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { releaseFor } from "../shared/changelog";
import { releases } from "./changelogData";
import { usePanelStore } from "./panelStore";
import { useViewStore } from "./viewStore";

const MAX_LINES = 5;

/** One-shot upgrade notice — shown until dismissed, then lastSeenVersion catches up. */
export function WhatsNewCard() {
  const { settings, appVersion, saveSettings } = usePanelStore();
  const openChangelog = useViewStore((s) => s.openChangelog);

  const show =
    !!settings &&
    appVersion !== "" &&
    settings.lastSeenVersion !== "" &&
    settings.lastSeenVersion !== appVersion;

  const dismiss = () => void saveSettings({ lastSeenVersion: appVersion });

  const release = releaseFor(releases, appVersion);
  const entries = release?.entries.slice(0, MAX_LINES) ?? [];

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ type: "spring", stiffness: 350, damping: 30 }}
          className="absolute inset-x-0 top-0 z-20 max-h-full px-3 pt-2"
        >
          <div className="flex max-h-full flex-col rounded-md border border-hairline bg-raised px-2.5 py-2">
            <div className="flex shrink-0 items-center justify-between">
              <span className="font-display text-[10px] uppercase tracking-[0.15em] text-accent">
                What's new · v{appVersion}
              </span>
              <button
                onClick={dismiss}
                title="Dismiss"
                aria-label="Dismiss What's New"
                className="shrink-0 text-ink-mute transition-colors duration-200 hover:text-ink"
              >
                <X size={12} strokeWidth={1.75} />
              </button>
            </div>
            {/* Scrolls inside a capped box: a long release must never grow the
                card past the content it floats over. */}
            {entries.length > 0 ? (
              <ul className="mt-1 flex max-h-24 min-h-0 flex-col gap-0.5 overflow-y-auto">
                {entries.map((e, i) => (
                  <li key={i} className="text-[10px] leading-snug text-ink-dim">
                    <span className="text-ink-mute">{e.category}</span> {e.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[10px] leading-snug text-ink-dim">
                Updated to v{appVersion}.
              </p>
            )}
            <button
              onClick={() => {
                openChangelog();
                dismiss();
              }}
              className="mt-1.5 shrink-0 self-start font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute transition-colors duration-200 hover:text-accent"
            >
              full changelog
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
