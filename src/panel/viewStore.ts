import { create } from "zustand";

export type PanelView = "main" | "settings" | "changelog";
/** One-shot scroll target inside the settings view, consumed after scrolling. */
export type SettingsFocus = "voice" | null;

interface ViewState {
  view: PanelView;
  settingsFocus: SettingsFocus;
  openSettings: (focus?: SettingsFocus) => void;
  closeSettings: () => void;
  openChangelog: () => void;
  closeChangelog: () => void;
  clearSettingsFocus: () => void;
}

export const useViewStore = create<ViewState>((set) => ({
  view: "main",
  settingsFocus: null,
  openSettings: (focus = null) => set({ view: "settings", settingsFocus: focus }),
  closeSettings: () => set({ view: "main", settingsFocus: null }),
  openChangelog: () => set({ view: "changelog", settingsFocus: null }),
  // Changelog is a sub-page of settings — back lands there, not on main.
  closeChangelog: () => set({ view: "settings" }),
  clearSettingsFocus: () => set({ settingsFocus: null }),
}));
