import { usePanelStore } from "./panelStore";
import type { Settings } from "../shared/types";

const ROWS: Array<{ key: keyof Settings["features"]; label: string; hint: string }> = [
  { key: "prose", label: "Prose", hint: "speak Claude's words" },
  { key: "blurbs", label: "Tool blurbs", hint: "“editing 3 files”" },
  { key: "errors", label: "Errors", hint: "spoken API alerts" },
  { key: "chime", label: "Chime", hint: "cue on turn end" },
  { key: "attention", label: "Attention", hint: "approval & input alerts" },
];

export function Toggles() {
  const { settings, saveSettings } = usePanelStore();
  if (!settings) return null;

  const flip = (key: keyof Settings["features"]) => {
    void saveSettings({
      features: { ...settings.features, [key]: !settings.features[key] },
    });
  };

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2">
      {ROWS.map((row) => {
        const on = settings.features[row.key];
        return (
          <button
            key={row.key}
            role="switch"
            aria-checked={on}
            onClick={() => flip(row.key)}
            className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-200 hover:bg-raised"
          >
            <span className="min-w-0">
              <span
                className={`block font-display text-[10px] uppercase tracking-[0.15em] ${
                  on ? "text-ink-dim" : "text-ink-mute"
                }`}
              >
                {row.label}
              </span>
              <span className="block truncate text-[10px] text-ink-mute">{row.hint}</span>
            </span>
            <span
              className={`relative h-3.5 w-6 shrink-0 rounded-full border transition-colors duration-200 ${
                on ? "border-accent/40 bg-accent/25" : "border-hairline bg-surface"
              }`}
            >
              <span
                className={`absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full transition-all duration-200 ${
                  on ? "left-3 bg-accent" : "left-0.5 bg-ink-mute"
                }`}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}
