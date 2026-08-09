import { basename } from "../shared/format";
import type { ToolInput } from "../shared/types";

/**
 * tool_use → short spoken phrase. Wording lives here (TS) for fast iteration;
 * Rust only classifies.
 */

const SILENT = new Set([
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "ToolSearch",
  "TaskOutput",
  "TaskStop",
  "ReportFindings",
]);

export type BlurbKind =
  | "edit"
  | "write"
  | "read"
  | "run"
  | "search"
  | "web"
  | "agent"
  | "other";

export interface Blurb {
  kind: BlurbKind;
  phrase: string;
}

export function blurbFor(toolName: string, input: ToolInput): Blurb | null {
  if (SILENT.has(toolName)) return null;

  if (toolName.startsWith("mcp__")) {
    const server = toolName.split("__")[1]?.replace(/[_-]+/g, " ") ?? "an external";
    return { kind: "other", phrase: `using ${server} tools` };
  }

  switch (toolName) {
    case "Edit":
    case "NotebookEdit":
      return { kind: "edit", phrase: input.filePath ? `editing ${basename(input.filePath)}` : "editing a file" };
    case "Write":
      return { kind: "write", phrase: input.filePath ? `writing ${basename(input.filePath)}` : "writing a file" };
    case "Read":
      return { kind: "read", phrase: input.filePath ? `reading ${basename(input.filePath)}` : "reading a file" };
    case "Bash":
    case "PowerShell": {
      const desc = input.description?.split(/[.\n]/)[0]?.trim();
      if (desc && desc.split(/\s+/).length <= 8) {
        return { kind: "run", phrase: `running: ${desc.toLowerCase()}` };
      }
      return { kind: "run", phrase: "running a command" };
    }
    case "Grep":
    case "Glob":
      return { kind: "search", phrase: "searching the code" };
    case "WebSearch":
    case "WebFetch":
      return { kind: "web", phrase: "searching the web" };
    case "Agent":
    case "Task":
      return {
        kind: "agent",
        phrase: input.description ? `dispatching an agent: ${input.description.toLowerCase()}` : "dispatching an agent",
      };
    case "Skill":
      return { kind: "other", phrase: input.skill ? `using the ${input.skill} skill` : "using a skill" };
    case "Workflow":
      return { kind: "agent", phrase: "launching a workflow" };
    case "Artifact":
      return { kind: "other", phrase: "publishing an artifact" };
    default:
      return { kind: "other", phrase: `using ${toolName}` };
  }
}

function plural(kind: BlurbKind, n: number): string {
  switch (kind) {
    case "edit":
      return `editing ${n} files`;
    case "write":
      return `writing ${n} files`;
    case "read":
      return `reading ${n} files`;
    case "run":
      return `running ${n} commands`;
    case "search":
      return "searching the code";
    case "web":
      return "searching the web";
    case "agent":
      return `dispatching ${n} agents`;
    default:
      return `${n} tool calls`;
  }
}

interface Pending {
  kind: BlurbKind;
  firstPhrase: string;
  count: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Burst collapser: same-kind blurbs inside a 2.5s window merge ("editing 3 files").
 * A different-kind arrival flushes instantly — a delayed blurb must never play
 * after later prose. `flushAll()` is called by the engine before any prose/error.
 */
export class BlurbCollapser {
  private pending: Pending | null = null;
  private lastFlushed = "";
  private lastFlushedAt = 0;

  constructor(
    private onFlush: (phrase: string) => void,
    private windowMs = 2500,
    private dedupeMs = 10_000,
    private now: () => number = Date.now
  ) {}

  push(toolName: string, input: ToolInput): void {
    const blurb = blurbFor(toolName, input);
    if (!blurb) return;

    if (this.pending) {
      if (this.pending.kind === blurb.kind) {
        this.pending.count += 1;
        return;
      }
      this.flushAll();
    }
    const timer = setTimeout(() => this.flushAll(), this.windowMs);
    this.pending = { kind: blurb.kind, firstPhrase: blurb.phrase, count: 1, timer };
  }

  flushAll(): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    const phrase = p.count === 1 ? p.firstPhrase : plural(p.kind, p.count);
    const t = this.now();
    if (phrase === this.lastFlushed && t - this.lastFlushedAt < this.dedupeMs) {
      return; // identical blurb repeated within the dedupe window — noise
    }
    this.lastFlushed = phrase;
    this.lastFlushedAt = t;
    this.onFlush(phrase);
  }

  reset(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
  }
}
