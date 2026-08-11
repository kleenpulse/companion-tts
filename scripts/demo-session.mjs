#!/usr/bin/env node
/**
 * Marketing demo session — a scripted, camera-ready Claude Code session that
 * shows off every companion feature in ~90 seconds: narration, tool blurbs,
 * plan approval, a question, a permission alert (urgent triple ping), and the
 * turn-complete chime.
 *
 * Emits transcript JSONL to %USERPROFILE%\.claude\projects\d--demo-checkout\
 * and the permission notification to the app's notifications.jsonl (same file
 * the real Claude Code hook writes) — the app can't tell it from a real session.
 *
 * Usage: node scripts/demo-session.mjs
 * Flags:
 *   --speed 1.5   run faster (divides every wait; slower with 0.8)
 *   --loop        repeat forever (fresh session id each pass)
 *
 * Recording tips:
 *   - Waits are tuned for Piper at default rate — each spoken line finishes
 *     before the next lands, so the typewriter reveal never queues up.
 *   - The permission act stays silent for 6s on purpose: alerts arm a 2.5s
 *     grace window that fresh transcript activity cancels.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

const SPEED = opt("speed", 1);
const LOOP = flag("loop");

const transcriptDir = join(homedir(), ".claude", "projects", "d--demo-checkout");
mkdirSync(transcriptDir, { recursive: true });

// Same file attention.rs tails; the real Notification hook appends here too.
const notificationsFile = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "com.vxrcel.companion-tts",
  "notifications.jsonl"
);

const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));

/* ---------- line builders (shapes parser.rs classifies) ---------- */

const text = (sessionId, msgId, body, stopReason = null) =>
  JSON.stringify({
    type: "assistant",
    uuid: uuid(),
    isSidechain: false,
    timestamp: now(),
    sessionId,
    message: {
      id: msgId,
      role: "assistant",
      model: "claude-fable-5",
      stop_reason: stopReason,
      content: [{ type: "text", text: body }],
    },
  });

const tool = (sessionId, msgId, name, input = {}) =>
  JSON.stringify({
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

const thinkingEnd = (sessionId, msgId) =>
  JSON.stringify({
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

/* ---------- the screenplay ---------- */

// Each step: { line } appended to the transcript, { notify } appended to
// notifications.jsonl, then `wait` ms (scaled by --speed) before the next.
function screenplay(sessionId) {
  const m = (i) => `msg_demo_${i}`;
  const t = (id, body, stop) => ({ line: text(sessionId, id, body, stop) });
  const u = (id, name, input) => ({ line: tool(sessionId, id, name, input) });

  return [
    { line: JSON.stringify({ type: "ai-title", sessionId, aiTitle: "Fix double-charge on payment retry" }), wait: 800 },

    // Act 1 — narration + tool blurbs while "you" work on something else.
    { ...t(m(1), "Taking a look at the checkout flow. I'll trace how payment retries are handled before touching anything."), wait: 9000 },
    { ...u(m(1), "Read", { file_path: "D:\\shop\\src\\checkout\\payment.ts" }), wait: 2200 },
    { ...u(m(1), "Grep", { pattern: "retryPayment" }), wait: 2200 },
    { ...u(m(1), "Read", { file_path: "D:\\shop\\src\\checkout\\session.ts" }), wait: 2600 },
    { ...t(m(2), "Found it. Retries fire from two places, and the second path drops the idempotency key. That's the double charge."), wait: 9500 },

    // Act 2 — plan approval (announced straight from the transcript).
    { ...u(m(2), "ExitPlanMode", {}), wait: 8000 },
    { ...t(m(3), "Plan approved. Implementing the fix now."), wait: 5000 },
    { ...u(m(3), "Edit", { file_path: "D:\\shop\\src\\checkout\\payment.ts" }), wait: 2200 },
    { ...u(m(3), "Edit", { file_path: "D:\\shop\\src\\checkout\\retry.ts" }), wait: 2200 },
    { ...u(m(3), "Write", { file_path: "D:\\shop\\src\\checkout\\retry.test.ts" }), wait: 2600 },

    // Act 3 — Claude has a question.
    { ...u(m(4), "AskUserQuestion", {}), wait: 8000 },
    { ...t(m(5), "Good call. Capping retries at three with exponential backoff."), wait: 7000 },

    // Act 4 — permission prompt: the transcript goes silent, the companion
    // pings. This is the moment the whole product exists for.
    { notify: { session_id: sessionId, message: "Claude needs your permission to use Bash" }, wait: 8000 },
    { ...t(m(6), "Thanks. Running the test suite."), wait: 4500 },
    { ...u(m(6), "Bash", { command: "npm test", description: "Run the checkout test suite" }), wait: 3500 },

    // Act 5 — finale: end_turn pair (thinking + text share msgId, chime once).
    { line: thinkingEnd(sessionId, m(7)), wait: 300 },
    { ...t(m(7), "All green. Retries now reuse the idempotency key, backoff is capped, and the double-charge path is gone.", "end_turn"), wait: 2000 },
  ];
}

/* ---------- run ---------- */

async function run() {
  do {
    const sessionId = uuid();
    const file = join(transcriptDir, `${sessionId}.jsonl`);
    console.log(`demo session ${sessionId}`);
    console.log(`  transcript     ${file}`);
    console.log(`  notifications  ${notificationsFile}`);

    let step = 0;
    for (const s of screenplay(sessionId)) {
      step += 1;
      if (s.line) {
        appendFileSync(file, `${s.line}\n`, "utf8");
        console.log(`  [${step}] transcript line`);
      }
      if (s.notify) {
        appendFileSync(notificationsFile, `${JSON.stringify(s.notify)}\n`, "utf8");
        console.log(`  [${step}] permission notification — expect the triple ping`);
      }
      await sleep(s.wait ?? 2000);
    }
    console.log("scene complete");
  } while (LOOP);
}

run();
