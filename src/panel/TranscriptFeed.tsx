import { AlertTriangle, Bell, BellRing, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import { onPanelShown } from "../shared/bus";
import type { FeedItem } from "../shared/types";
import { usePanelStore } from "./panelStore";
import { RevealText } from "./RevealText";

function RowGlyph({ kind }: { kind: FeedItem["kind"] }) {
  if (kind === "blurb") return <Wrench size={11} className="mt-0.5 shrink-0 text-ink-mute" />;
  if (kind === "error") return <AlertTriangle size={11} className="mt-0.5 shrink-0 text-danger" />;
  if (kind === "chime") return <Bell size={11} className="mt-0.5 shrink-0 text-ink-mute" />;
  if (kind === "attention") return <BellRing size={11} className="mt-0.5 shrink-0 text-accent" />;
  return null;
}

/**
 * Owns its scroll container with a guaranteed 120px floor — the feed is the
 * panel's reason to exist and can never be fully crushed by the sections
 * around it, but the user may trade most of it away for sessions/settings.
 */
export function TranscriptFeed() {
  const { engineState, backfill, settings } = usePanelStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow mode: keep the spoken row (or the bottom, when idle) in view.
  // A manual scroll away releases it; scrolling back — or reopening the
  // panel — re-engages it.
  const follow = useRef(true);
  // Our own scrollIntoView fires scroll events too — ignore them so a
  // programmatic scroll never reads as the user taking over.
  const progUntil = useRef(0);
  // Pointer inside the feed = the user is reading — their scroll position
  // holds. Once the pointer leaves, new text re-arms follow.
  const hover = useRef(false);

  const live = engineState?.queue ?? [];
  const nowPlayingId = engineState?.nowPlayingId;

  const scrollToPlaying = (behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el) return;
    progUntil.current = Date.now() + 800;
    const row = el.querySelector<HTMLElement>('[data-playing="true"]');
    if (row) row.scrollIntoView({ block: "center", behavior });
    else el.scrollTop = el.scrollHeight;
  };

  // Manual-scroll latch: user leaves → release; back at the spoken row or
  // the bottom → re-engage.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (Date.now() < progUntil.current) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      const row = el.querySelector<HTMLElement>('[data-playing="true"]');
      const playingVisible =
        !!row &&
        row.offsetTop < el.scrollTop + el.clientHeight &&
        row.offsetTop + row.offsetHeight > el.scrollTop;
      follow.current = nearBottom || playingVisible;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Track the row being spoken as playback advances.
  useEffect(() => {
    if (nowPlayingId && follow.current) scrollToPlaying("smooth");
  }, [nowPlayingId]);

  // New text landed: if the user isn't reading inside the feed, follow
  // re-arms and the view tracks — spoken row while playing, newest row idle.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!hover.current) follow.current = true;
    if (!follow.current) return;
    if (nowPlayingId) scrollToPlaying("smooth");
    else el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, backfill]);

  // Panel shown (fab click): jump straight to the spoken row, follow re-armed.
  // (Explicit Rust cue — the hidden webview never sees visibilitychange.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPanelShown(() => {
      follow.current = true;
      scrollToPlaying("auto");
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderRow = (item: FeedItem, history: boolean) => {
    const playing = item.id === nowPlayingId;
    const pending =
      item.status === "queued" || item.status === "synthesizing" || item.status === "ready";
    // Typewriter applies ONLY to the row being spoken — queued rows stay
    // instant-dim (read-ahead preserved). Leaving "playing" unmounts the
    // reveal, which latches the row to full plain text.
    const typewrite =
      !!settings?.typewriter && playing && item.status === "playing" && item.kind !== "chime";
    return (
      <div
        key={item.id}
        data-playing={playing || undefined}
        className={`flex gap-2 rounded-md px-2 py-1.5 text-[12px] leading-snug transition-colors duration-200 ${
          playing
            ? "border-l-2 border-accent bg-accent/10 text-ink"
            : item.status === "failed"
              ? "text-danger/90"
              : history
                ? "text-ink-mute"
                : pending
                  ? "text-ink-mute opacity-55"
                  : "text-ink-dim"
        }`}
      >
        <RowGlyph kind={item.kind} />
        <span className="min-w-0 flex-1 wrap-break-word">
          {typewrite ? <RevealText id={item.id} text={item.displayText} /> : item.displayText}
          {item.status === "synthesizing" && (
            <span className="ml-1 font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
              synth…
            </span>
          )}
          {item.status === "failed" && (
            <span className="ml-1 font-display text-[9px] uppercase tracking-[0.15em]">failed</span>
          )}
        </span>
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      onPointerEnter={() => (hover.current = true)}
      onPointerLeave={() => (hover.current = false)}
      className="min-h-30 flex-1 overflow-y-auto px-2 py-1.5"
    >
      {backfill.length === 0 && live.length === 0 ? (
        <div className="px-6 py-10 text-center text-[12px] text-ink-mute">
          The feed is empty. When Claude speaks, the words land here as they are spoken.
        </div>
      ) : (
        <>
          {backfill.map((item) => renderRow(item, true))}
          {backfill.length > 0 && live.length > 0 && (
            <div className="mx-2 my-1.5 flex items-center gap-2">
              <span className="h-px flex-1 bg-hairline" />
              <span className="font-display text-[9px] uppercase tracking-[0.15em] text-ink-mute">
                live
              </span>
              <span className="h-px flex-1 bg-hairline" />
            </div>
          )}
          {live.map((item) => renderRow(item, false))}
        </>
      )}
    </div>
  );
}
