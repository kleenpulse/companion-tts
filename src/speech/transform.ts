/**
 * Verbatim-to-speech contract: turn Claude's markdown prose into text a TTS
 * engine can read aloud. Pure function, ordered rules, vitest-covered.
 */

export interface TransformOptions {
  /** Announce stripped code fences as the phrase "Code block." */
  announceCode: boolean;
  /** Hard cap per source line, cut at a sentence boundary. */
  maxChars: number;
  /** Sentence-pack target per chunk (ElevenLabs latency scales with input length). */
  chunkChars: number;
}

export const DEFAULT_TRANSFORM: TransformOptions = {
  announceCode: true,
  maxChars: 1200,
  chunkChars: 420,
};

/**
 * Targeted Windows-1252 mojibake repairs. Only 3 of 103 real transcripts are
 * affected; these byte sequences never occur in legitimate prose, so applying
 * unconditionally is safe. A blanket latin1→utf8 round-trip is FORBIDDEN —
 * it corrupts the correctly-encoded majority.
 */
const MOJIBAKE: Array<[string, string]> = [
  ["â€”", "—"], // â€” → em dash
  ["â€“", "–"], // â€“ → en dash
  ["â€œ", '"'], // â€œ → left double quote
  ["â€", '"'], // â€ + 9d → right double quote
  ["â€™", "'"], // â€™ → right single quote
  ["â€˜", "'"], // â€˜ → left single quote
  ["â€¦", "…"], // â€¦ → ellipsis
  ["â†’", " to "], // â†’ → mojibake arrow
  ["Ã©", "é"],
  ["Ã¨", "è"],
  ["Ã¼", "ü"],
  ["Ã¶", "ö"],
  ["Ã¤", "ä"],
  ["Ã—", "×"],
  ["Â°", "°"],
  ["Â ", " "],
];

export function fixMojibake(text: string): string {
  let out = text;
  for (const [bad, good] of MOJIBAKE) {
    if (out.includes(bad)) out = out.split(bad).join(good);
  }
  return out;
}

function ensureTerminal(s: string): string {
  const t = s.trimEnd();
  if (!t) return t;
  return /[.!?…:;]$/.test(t) ? t : `${t}.`;
}

function stripFences(text: string, announce: boolean): string {
  const replacement = announce ? "\nCode block.\n" : "\n";
  let out = text.replace(/```[^\n]*\n[\s\S]*?```/g, replacement);
  // Unterminated fence: everything after it is code that never closed.
  const stray = out.indexOf("```");
  if (stray >= 0) {
    out = out.slice(0, stray) + (announce ? "\nCode block.\n" : "\n");
  }
  if (announce) {
    // Consecutive fences collapse to one announcement.
    out = out.replace(/(Code block\.\s*){2,}/g, "Code block.\n");
  }
  return out;
}

function stripTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let run: string[] = [];
  const isTableLine = (l: string) => (l.match(/\|/g) ?? []).length >= 2;
  const flush = () => {
    if (run.length >= 2) {
      out.push("Table omitted.");
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const line of lines) {
    if (isTableLine(line)) {
      run.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

function transformLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let l = line;
      const header = l.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (header) return ensureTerminal(header[1]);
      l = l.replace(/^\s*>\s?/, "");
      const bullet = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (bullet) return ensureTerminal(bullet[1]);
      return l;
    })
    .join("\n");
}

function stripInline(text: string): string {
  let out = text;
  // images before links
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1");
  // bare URLs → hostname
  out = out.replace(/https?:\/\/[^\s)>\]]+/g, (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "link";
    }
  });
  // inline code keeps its content
  out = out.replace(/`([^`\n]*)`/g, "$1");
  // file paths → basename (windows drive paths, then ≥2-separator posix paths)
  out = out.replace(/[A-Za-z]:\\[\w.\\ ()@-]+/g, (p) => lastSegment(p));
  out = out.replace(/(?<![\w/])(?:[\w.@()-]+\/){2,}[\w.@()-]+/g, (p) => lastSegment(p));
  // emphasis / strikethrough markers
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\*([^*\n]+)\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/~~([^~]+)~~/g, "$1");
  // arrows read as "to"
  out = out.replace(/\s*(?:→|->|⇒|=>)\s*/g, " to ");
  // emoji and variation selectors
  out = out.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "");
  return out;
}

function lastSegment(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function capAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  const lastBoundary = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? ")
  );
  const cut = lastBoundary > maxChars * 0.4 ? lastBoundary + 1 : maxChars;
  return `${text.slice(0, cut).trimEnd()} … and more.`;
}

function sentences(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    return Array.from(seg.segment(text), (s) => s.segment).filter((s) => s.trim());
  }
  return text.split(/(?<=[.!?…])\s+/).filter((s) => s.trim());
}

function chunk(text: string, chunkChars: number): string[] {
  if (text.length <= chunkChars) return [text];
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences(text)) {
    if (current && current.length + sentence.length > chunkChars) {
      out.push(current.trim());
      current = "";
    }
    if (sentence.length > chunkChars) {
      // One monster sentence: hard-split at the last space inside the budget.
      let rest = sentence;
      while (rest.length > chunkChars) {
        const cut = rest.lastIndexOf(" ", chunkChars);
        const at = cut > chunkChars * 0.3 ? cut : chunkChars;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      current = rest ? `${rest} ` : "";
    } else {
      current += sentence.endsWith(" ") ? sentence : `${sentence} `;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Full pipeline: raw markdown text block → ordered speakable chunks ([] = drop). */
export function transformForSpeech(
  raw: string,
  opts: TransformOptions = DEFAULT_TRANSFORM
): string[] {
  let text = fixMojibake(raw);
  text = stripFences(text, opts.announceCode);
  text = stripTables(text);
  text = transformLines(text);
  text = stripInline(text);
  text = text.replace(/\s+/g, " ").trim();
  if (!text || !/[a-zA-Z0-9]/.test(text)) return [];
  text = ensureTerminal(text);
  text = capAtSentence(text, opts.maxChars);
  return chunk(text, opts.chunkChars);
}
