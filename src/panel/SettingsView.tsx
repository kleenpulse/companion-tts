import { ArrowLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { ChangelogSection } from "./ChangelogSection";
import { onHeaderPointerDown } from "./dragRegion";
import { ProviderCard } from "./ProviderCard";
import { SettingsSection } from "./SettingsSection";
import { Toggles } from "./Toggles";
import { useViewStore } from "./viewStore";
import { WindowButtons } from "./WindowButtons";

export function SettingsView() {
  const closeSettings = useViewStore((s) => s.closeSettings);
  const settingsFocus = useViewStore((s) => s.settingsFocus);
  const voiceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (settingsFocus !== "voice") return;
    voiceRef.current?.scrollIntoView({ block: "start" });
    voiceRef.current?.focus({ preventScroll: true });
    useViewStore.getState().clearSettingsFocus();
  }, [settingsFocus]);

  return (
    <div className="flex h-full flex-col">
      <header
        onPointerDown={onHeaderPointerDown}
        className="flex cursor-grab items-center gap-2 border-b border-hairline px-3 py-2.5 active:cursor-grabbing"
      >
        <button
          aria-label="Back to main view"
          onClick={closeSettings}
          className="rounded-md p-1 text-ink-mute transition-colors duration-200 hover:bg-raised hover:text-ink"
        >
          <ArrowLeft size={14} strokeWidth={2} />
        </button>
        <span className="flex-1 font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
          Settings
        </span>
        <WindowButtons />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-3 pt-2 font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
          Toggles
        </div>
        <Toggles />
        <div ref={voiceRef} tabIndex={-1} className="outline-none">
          <ProviderCard />
        </div>
        <SettingsSection />
        <ChangelogSection />
      </div>
    </div>
  );
}
