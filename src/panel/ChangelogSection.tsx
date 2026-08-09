import { releases } from "./changelogData";

/** Full release history from the bundled CHANGELOG.md — read-only browser. */
export function ChangelogSection() {
  return (
    <div className="border-t border-hairline">
      <div className="px-3 py-2 font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
        Changelog
      </div>
      <div className="flex flex-col gap-2.5 px-3 pb-3">
        {releases.map((r) => (
          <div key={r.version}>
            <div className="font-display text-[9px] uppercase tracking-[0.15em] text-accent">
              v{r.version}
              {r.date && <span className="text-ink-mute"> · {r.date}</span>}
            </div>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {r.entries.map((e, i) => (
                <li key={i} className="text-[10px] leading-snug text-ink-dim">
                  <span className="text-ink-mute">{e.category}</span> {e.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
