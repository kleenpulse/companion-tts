import { ChevronRight } from "lucide-react";
import { releases } from "./changelogData";
import { useViewStore } from "./viewStore";

const SNIPPET_LINES = 3;

/** Latest release only — the full history lives on the changelog view. */
export function ChangelogSection() {
  const openChangelog = useViewStore((s) => s.openChangelog);
  const latest = releases[0];
  if (!latest) return null;

  const entries = latest.entries.slice(0, SNIPPET_LINES);
  const more = latest.entries.length - entries.length;

  return (
    <div className="border-t border-hairline">
      <div className="px-3 py-2 font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
        Changelog
      </div>
      <div className="px-3 pb-3">
        <div className="font-display text-[9px] uppercase tracking-[0.15em] text-accent">
          v{latest.version}
          {latest.date && <span className="text-ink-mute"> · {latest.date}</span>}
        </div>
        <ul className="mt-0.5 flex flex-col gap-0.5">
          {entries.map((e, i) => (
            <li key={i} className="truncate text-[10px] leading-snug text-ink-dim">
              <span className="text-ink-mute">{e.category}</span> {e.text}
            </li>
          ))}
        </ul>
        <button
          onClick={openChangelog}
          className="mt-1.5 flex items-center gap-0.5 font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute transition-colors duration-200 hover:text-accent"
        >
          View full changelog{more > 0 && ` (+${more} more)`}
          <ChevronRight size={10} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
