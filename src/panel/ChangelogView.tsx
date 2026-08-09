import { ArrowLeft, X } from "lucide-react";
import { togglePanel } from "../shared/bus";
import { releases } from "./changelogData";
import { onHeaderPointerDown } from "./dragRegion";
import { useViewStore } from "./viewStore";

/** Full release history from the bundled CHANGELOG.md — read-only browser. */
export function ChangelogView() {
  const closeChangelog = useViewStore((s) => s.closeChangelog);

  return (
    <div className="flex h-full flex-col">
      <header
        onPointerDown={onHeaderPointerDown}
        className="flex cursor-grab items-center gap-2 border-b border-hairline px-3 py-2.5 active:cursor-grabbing"
      >
        <button
          aria-label="Back to settings"
          onClick={closeChangelog}
          className="rounded-md p-1 text-ink-mute transition-colors duration-200 hover:bg-raised hover:text-ink"
        >
          <ArrowLeft size={14} strokeWidth={2} />
        </button>
        <span className="flex-1 font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
          Changelog
        </span>
        <button
          aria-label="Close panel"
          onClick={() => void togglePanel()}
          className="rounded-md p-1 text-ink-mute transition-colors duration-200 hover:bg-raised hover:text-ink"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3.5 px-3 py-3">
          {releases.map((r) => (
            <div key={r.version}>
              <div className="font-display text-[11px] uppercase tracking-[0.15em] text-accent">
                v{r.version}
                {r.date && <span className="text-ink-mute"> · {r.date}</span>}
              </div>
              <ul className="mt-1 flex flex-col gap-1">
                {r.entries.map((e, i) => (
                  <li key={i} className="text-[12px] leading-snug text-ink-dim">
                    <span className="text-ink-mute">{e.category}</span> {e.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
