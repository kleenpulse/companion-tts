import { useState } from "react";
import { Header } from "./Header";
import { SectionResizer } from "./SectionResizer";
import { SessionList } from "./SessionList";
import { TranscriptFeed } from "./TranscriptFeed";
import { Transport } from "./Transport";
import { WhatsNewCard } from "./WhatsNewCard";

const SESSIONS_MIN = 72;
const SESSIONS_MAX = 320;

/** Section height the user dragged — clamped, remembered across panel opens. */
function usePersistedHeight(key: string, initial: number, min: number, max: number) {
  const [h, setH] = useState(() => {
    const raw = Number(localStorage.getItem(key));
    return Number.isFinite(raw) && raw >= min && raw <= max ? raw : initial;
  });
  const update = (next: number) => {
    const clamped = Math.min(max, Math.max(min, Math.round(next)));
    setH(clamped);
    localStorage.setItem(key, String(clamped));
  };
  return [h, update] as const;
}

export function MainView() {
  const [sessionsH, setSessionsH] = usePersistedHeight("companion.ui.sessionsH", 128, SESSIONS_MIN, SESSIONS_MAX);

  return (
    <div className="flex h-full flex-col">
      <Header />

      {/* The What's New card floats over this region instead of sitting in the
          column — an overlay can never push the feed and transport off-panel. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <WhatsNewCard />

        {/* Sessions: user-sized, scrolls within itself. Floor fits the header
            plus one full session row. */}
        <div style={{ height: sessionsH }} className="min-h-18 shrink overflow-y-auto">
          <SessionList />
        </div>
        <SectionResizer label="Resize sessions list" onDelta={(dy) => setSessionsH(sessionsH + dy)} />

        {/* The feed owns its scroller and can never be crushed below 120px. */}
        <TranscriptFeed />
      </div>

      {/* The visualizer lives in the orb beside the transport controls. */}
      <Transport />
    </div>
  );
}
