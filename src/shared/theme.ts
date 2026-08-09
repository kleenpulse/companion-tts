import type { Theme } from "./types";

/**
 * Document-level theme switch, shared by both windows. The CSS default is
 * dark; "light" flips the semantic tokens via html[data-theme].
 */
const mq = window.matchMedia("(prefers-color-scheme: light)");
let current: Theme = "dark";

export const resolveTheme = (t: Theme): "dark" | "light" =>
  t === "system" ? (mq.matches ? "light" : "dark") : t === "light" ? "light" : "dark";

export function applyTheme(t: Theme): void {
  current = t;
  document.documentElement.dataset.theme = resolveTheme(t);
  localStorage.setItem("companion.ui.theme", t);
}

mq.addEventListener("change", () => applyTheme(current));

// Flash guard: last-known theme before settings arrive (dark needs nothing).
const saved = localStorage.getItem("companion.ui.theme");
if (saved === "light" || saved === "system") applyTheme(saved as Theme);
