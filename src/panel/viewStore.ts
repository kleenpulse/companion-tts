import { create } from "zustand";

export type PanelView = "main" | "settings";
/** One-shot scroll target inside the settings view, consumed after scrolling. */
export type SettingsFocus = "voice" | "changelog" | null;

interface ViewState {
  view: PanelView;
  settingsFocus: SettingsFocus;
  openSettings: (focus?: SettingsFocus) => void;
  closeSettings: () => void;
  clearSettingsFocus: () => void;
}

export const useViewStore = create<ViewState>((set) => ({
  view: "main",
  settingsFocus: null,
  openSettings: (focus = null) => set({ view: "settings", settingsFocus: focus }),
  closeSettings: () => set({ view: "main", settingsFocus: null }),
  clearSettingsFocus: () => set({ settingsFocus: null }),
}));
