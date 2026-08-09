#!/usr/bin/env node
/**
 * Deterministic fake Claude Code session emitter — appends scripted JSONL lines
 * to %USERPROFILE%\.claude\projects\d--test-companion\<id>.jsonl so the
 * companion can be tested without burning a real session.
 *
 * Flags:
 *   --interval 1500     ms between lines (default 1500)
 *   --split-writes      write half a line, fsync, complete it 300ms later (tailer proof)
 *   --truncate-at N     truncate the file after N lines (rotation proof)
 *   --sessions 2        run N interleaved sessions (follow/hysteresis proof)
 *   --loop              repeat the script forever
 */
import { appendFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

const INTERVAL = opt("interval", 1500);
const SESSIONS = opt("sessions", 1);
const TRUNCATE_AT = opt("truncate-at", 0);
const SPLIT = flag("split-writes");
const LOOP = flag("loop");

const dir = join(homedir(), ".claude", "projects", "d--test-companion");
mkdirSync(dir, { recursive: true });

const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

const now = () => new Date().toISOString();

function assistantText(sessionId, msgId, text, stopReason = null) {
  return JSON.stringify({
    type: "assistant",
    uuid: uuid(),
    parentUuid: uuid(),
    isSidechain: false,
    timestamp: now(),
    sessionId,
    message: {
      id: msgId,
      role: "assistant",
      model: "claude-fable-5",
      stop_reason: stopReason,
      content: [{ type: "text", text }],
    },
  });
}

function assistantTool(sessionId, msgId, name, input) {
  return JSON.stringify({
    type: "assistant",
    uuid: uuid(),
    isSidechain: false,
    timestamp: now(),
    sessionId,
    message: {
      id: msgId,
      role: "assistant",
      model: "claude-fable-5",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: `t_${uuid().slice(0, 8)}`, name, input }],
    },
  });
}

function assistantThinkingEnd(sessionId, msgId) {
  return JSON.stringify({
    type: "assistant",
    uuid: uuid(),
    isSidechain: false,
    timestamp: now(),
    sessionId,
    message: {
      id: msgId,
      role: "assistant",
      model: "claude-fable-5",
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "", signature: "sig" }],
    },
  });
}

function script(sessionId, n) {
  const m = (i) => `msg_fake_${n}_${i}`;
  return [
    JSON.stringify({ type: "ai-title", sessionId, aiTitle: `Fake session ${n} — narration test` }),
    assistantText(sessionId, m(1), "Scanning the repository structure before making changes."),
    assistantTool(sessionId, m(1), "Read", { file_path: "D:\\proj\\src\\index.ts" }),
    assistantTool(sessionId, m(2), "Edit", { file_path: "D:\\proj\\src\\alpha.ts" }),
    assistantTool(sessionId, m(2), "Edit", { file_path: "D:\\proj\\src\\beta.ts" }),
    assistantTool(sessionId, m(2), "Edit", { file_path: "D:\\proj\\src\\gamma.ts" }),
    assistantText(
      sessionId,
      m(3),
      "The **auth middleware** is a named character here â€” see [the docs](https://example.com/auth) and `src/lib/auth.ts`.\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- first point\n- second point"
    ),
    JSON.stringify({
      type: "system",
      subtype: "api_error",
      timestamp: now(),
      sessionId,
      retryInMs: 3000,
      retryAttempt: 1,
      error: { message: "raw", formatted: "Unable to connect to API (ECONNRESET)" },
    }),
    // The end_turn pair: thinking + text share msgId — chime must fire ONCE.
    assistantThinkingEnd(sessionId, m(4)),
    assistantText(sessionId, m(4), "All changes are complete. The tests pass and the build is green.", "end_turn"),
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeLine(file, line, splitWrites) {
  const payload = `${line}\n`;
  if (!splitWrites) {
    appendFileSync(file, payload, "utf8");
    return;
  }
  const half = Math.floor(payload.length / 2);
  const fd = openSync(file, "a");
  writeSync(fd, payload.slice(0, half));
  fsyncSync(fd);
  await sleep(300);
  writeSync(fd, payload.slice(half));
  fsyncSync(fd);
  closeSync(fd);
}

async function run() {
  const sessions = Array.from({ length: SESSIONS }, (_, i) => {
    const id = uuid();
    return { id, file: join(dir, `${id}.jsonl`), lines: script(id, i + 1), written: 0 };
  });
  console.log(`emitting to ${dir}`);
  sessions.forEach((s) => console.log(`  session ${s.id}`));

  do {
    const pending = sessions.map((s) => ({ ...s, queue: [...s.lines] }));
    let anyLeft = true;
    while (anyLeft) {
      anyLeft = false;
      for (const s of pending) {
        const line = s.queue.shift();
        if (line === undefined) continue;
        anyLeft = anyLeft || s.queue.length > 0;
        await writeLine(s.file, line, SPLIT);
        s.written += 1;
        console.log(`[${s.id.slice(0, 8)}] line ${s.written}`);
        if (TRUNCATE_AT && s.written === TRUNCATE_AT) {
          console.log(`[${s.id.slice(0, 8)}] TRUNCATE`);
          truncateSync(s.file, 0);
        }
        await sleep(INTERVAL);
      }
    }
  } while (LOOP);
  console.log("done");
}

run();
