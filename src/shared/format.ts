/** Small pure helpers shared by both windows. */

export function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** ElevenLabs flash ≈ $0.05 / 1K chars — the meter is an estimate, not a bill. */
export function costEstimate(chars: number): string {
  const usd = (chars / 1000) * 0.05;
  return usd < 0.01 && chars > 0 ? "<$0.01" : `~$${usd.toFixed(2)}`;
}

export function compactChars(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M`;
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)}K`;
  return String(chars);
}

// "d--Vxrcel-shadow-garden" → "shadow-garden"
export function projectName(slug: string): string {
  const parts = slug.split("-").filter(Boolean);
  return parts.length > 1 ? parts.slice(-2).join("-") : slug;
}

export function shortTitle(title: string | null | undefined, slug: string): string {
  if (title && title.trim()) return title.trim();
  return projectName(slug);
}

/**
 * Fab size levels: the UI speaks 1–10, settings store the raw multiplier
 * (backward compatible — old percent-slider values just snap to a level).
 * L1 = ×0.75, L2 = ×1.0 (default), L10 = ×3.0.
 */
export function fabLevelToScale(level: number): number {
  return 0.5 + 0.25 * Math.min(10, Math.max(1, Math.round(level)));
}

export function fabScaleToLevel(scale: number): number {
  return Math.min(10, Math.max(1, Math.round((scale - 0.5) / 0.25)));
}

/**
 * Typewriter reveal edge: how many of `total` units are visible at playback
 * fraction `frac`. +1 lead so text lands just before it's heard; latches
 * full on end; nothing before playback starts.
 */
export function revealEdge(frac: number, total: number, ended: boolean): number {
  if (ended) return total;
  return frac > 0 ? Math.min(Math.floor(frac * total) + 1, total) : 0;
}

export function timeAgo(epochMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
