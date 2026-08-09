import { Pin, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { hideSession, onPanelShown, sendEngineCmd } from "../shared/bus";
import { shortTitle, timeAgo } from "../shared/format";
import { usePanelStore } from "./panelStore";

export function SessionList() {
  const { sessions, engineState, settings, saveSettings } = usePanelStore();
  const followedId = engineState?.followedSessionId;
  const pinnedId = settings?.follow.mode === "pinned" ? settings.follow.pinnedSessionId : null;
  const listRef = useRef<HTMLDivElement>(null);
  // Pointer inside the list = the user is reading/choosing — never yank.
  const hover = useRef(false);

  const scrollFollowedIntoView = (force = false) => {
    if (hover.current && !force) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-followed="true"]')
      ?.scrollIntoView({ block: "nearest" });
  };

  // Keep the followed session visible as entries land or follow shifts.
  useEffect(() => scrollFollowedIntoView(), [followedId, sessions]);

  // Panel shown (fab click): bring the followed session back into view.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPanelShown(() => scrollFollowedIntoView(true)).then((fn) => (unlisten = fn));
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (sessions.length === 0) {
    return (
      <div className="px-3 py-2 text-[12px] text-ink-mute">
        No recent sessions. Start Claude Code and the companion will hear it.
      </div>
    );
  }

  const follow = (sessionId: string) => {
    // Switch narration now; auto-follow may still drift later. Pin is the sticky version.
    void sendEngineCmd({ cmd: "pin", sessionId });
  };

  const pin = (sessionId: string) => {
    void saveSettings({ follow: { mode: "pinned", pinnedSessionId: sessionId } });
  };

  const dismiss = (sessionId: string) => {
    // Hides from the list only — the transcript on disk is never touched.
    void hideSession(sessionId);
  };

  return (
    <div
      ref={listRef}
      onPointerEnter={() => (hover.current = true)}
      onPointerLeave={() => (hover.current = false)}
      className="px-2 py-1.5"
    >
      <div className="px-1 pb-1 font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
        Sessions
      </div>
      <ul className="flex flex-col gap-0.5">
        {sessions.map((s) => {
          const isFollowed = s.sessionId === followedId;
          const isPinned = s.sessionId === pinnedId;
          const active = Date.now() - s.lastActivity < 10_000;
          return (
            <li key={s.sessionId}>
              <div
                role="button"
                tabIndex={0}
                data-followed={isFollowed || undefined}
                aria-label={`Follow ${shortTitle(s.title, s.projectSlug)}`}
                onClick={() => follow(s.sessionId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    follow(s.sessionId);
                  }
                }}
                className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-200 ${
                  isFollowed ? "bg-accent/10" : "hover:bg-raised"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    isFollowed ? "bg-accent" : active ? "bg-ink-dim" : "bg-ink-mute/50"
                  } ${active && isFollowed ? "animate-pulse" : ""}`}
                />
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[12px] ${isFollowed ? "text-ink" : "text-ink-dim"}`}>
                    {shortTitle(s.title, s.projectSlug)}
                  </div>
                  <div className="truncate font-mono text-[10px] text-ink-mute">
                    {s.projectSlug} · {timeAgo(s.lastActivity)}
                  </div>
                </div>
                <button
                  aria-label={`Pin ${s.sessionId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    pin(s.sessionId);
                  }}
                  className={`rounded p-1 transition-colors duration-200 ${
                    isPinned
                      ? "text-accent"
                      : "text-ink-mute opacity-0 hover:text-ink-dim group-hover:opacity-100"
                  }`}
                >
                  <Pin size={12} strokeWidth={2} />
                </button>
                <button
                  aria-label={`Hide ${s.sessionId} from list`}
                  title="Hide from list (transcript untouched)"
                  onClick={(e) => {
                    e.stopPropagation();
                    dismiss(s.sessionId);
                  }}
                  className="rounded p-1 text-ink-mute opacity-0 transition-colors duration-200 hover:text-danger group-hover:opacity-100"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
