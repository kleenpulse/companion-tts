/**
 * Phrasing for "Claude needs you" alerts. Input is the Notification hook's
 * message (e.g. "Claude needs your permission to use Bash") or a transcript
 * tool name for the prompts that never reach the hook (AskUserQuestion,
 * ExitPlanMode). Output is clean speech — no transform pass needed.
 */

const TOOL_PHRASES: Record<string, string> = {
  bash: "run a command",
  powershell: "run a command",
  edit: "edit a file",
  write: "write a file",
  notebookedit: "edit a notebook",
  read: "read a file",
  glob: "search files",
  grep: "search files",
  webfetch: "fetch a web page",
  websearch: "search the web",
  agent: "dispatch an agent",
  task: "dispatch an agent",
  skill: "use a skill",
};

function phraseForTool(tool: string): string {
  const key = tool.trim().toLowerCase();
  if (key.startsWith("mcp__")) {
    const server = key.split("__")[1] ?? "external";
    return `use ${server} tools`;
  }
  return TOOL_PHRASES[key] ?? `use ${tool.trim()}`;
}

/** True for permission-style notifications — these get the short grace window. */
export function isPermissionMessage(message: string): boolean {
  return /permission/i.test(message);
}

export function attentionText(message: string): string {
  const perm = message.match(/permission to use (.+?)\.?$/i);
  if (perm) return `Claude needs your approval to ${phraseForTool(perm[1])}.`;
  if (/waiting for your input/i.test(message)) {
    return "Claude is waiting for your input.";
  }
  const clean = message.trim().replace(/\.$/, "");
  return `Claude needs your attention. ${clean}.`;
}

/** Transcript-side prompts that never fire the Notification hook. */
export function toolAttentionText(toolName: string): string | null {
  if (toolName === "AskUserQuestion") return "Claude has a question for you.";
  if (toolName === "ExitPlanMode") return "Claude drafted a plan and awaits your approval.";
  return null;
}
