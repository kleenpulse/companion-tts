import { getCurrentWindow } from "@tauri-apps/api/window";

/** Header rows are the panel's drag handle — everywhere except their controls. */
export function onHeaderPointerDown(e: React.PointerEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, [role='tab'], [role='tablist']")) return;
  void getCurrentWindow().startDragging();
}
