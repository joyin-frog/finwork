/**
 * E1 — Interrupt during model generation.
 * Dry-run by default; set RUN_LIVE=1 + ANTHROPIC_API_KEY to burn a short generation.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printBanner, liveGate, getPlatformInfo } from "./lib/env.mjs";
import { createTimeline, writeNotRunTemplate } from "./lib/timeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT = "E1";
printBanner(EXPERIMENT, "Interrupt during model generation");
const gate = liveGate();

const planned = [
  "Start query with streaming AsyncIterable prompt (required for interrupt semantics)",
  "Ask model to emit a long continuous response",
  "After first partial/assistant event, call query.interrupt()",
  "Record last event type/subtype, result subtype, session_id",
  "Attempt resume with options.resume = session_id",
];

if (!gate.allowed) {
  writeNotRunTemplate(EXPERIMENT, gate.reason, planned);
  const stub = {
    status: "not_run",
    reason: gate.reason,
    typeExpectations: {
      interrupt: "Query.interrupt(): Promise<void> — streaming input/output only",
      abortAlt: "Options.abortController also cancels query",
      terminalReasons: ["aborted_streaming", "aborted_tools"],
      adapterToday: "claude-adapter wires AbortController from request signal; does not call interrupt()",
    },
    platform: getPlatformInfo(),
  };
  fs.writeFileSync(path.join(__dirname, "evidence", "E1.json"), JSON.stringify(stub, null, 2));
  process.exit(0);
}

const sdk = await import("@anthropic-ai/claude-agent-sdk");
const tl = createTimeline(EXPERIMENT);

async function* openStream(initialText) {
  yield {
    type: "user",
    message: { role: "user", content: initialText },
    parent_tool_use_id: null,
  };
  // Keep stream open briefly so control channel stays valid; then end.
  await new Promise((r) => setTimeout(r, 60_000));
}

const abortController = new AbortController();
const q = sdk.query({
  prompt: openStream(
    "Write a very long essay about accounting month-end close, at least 2000 words. Do not use tools."
  ),
  options: {
    cwd: __dirname,
    abortController,
    persistSession: true,
    maxTurns: 3,
    allowedTools: [],
    includePartialMessages: true,
  },
});

tl.mark("query_started");
let last = null;
let sessionId = null;
let interrupted = false;

try {
  for await (const msg of q) {
    last = msg;
    if (msg.session_id) sessionId = msg.session_id;
    tl.mark("sdk_message", tl.summarizeMessage(msg));
    if (!interrupted && (msg.type === "stream_event" || msg.type === "assistant" || msg.type === "stream")) {
      interrupted = true;
      tl.mark("calling_interrupt");
      await q.interrupt();
      tl.mark("interrupt_resolved");
    }
  }
  tl.mark("iterator_done", { last: tl.summarizeMessage(last), sessionId });
} catch (err) {
  tl.mark("iterator_error", { error: String(err?.message || err), sessionId });
}

const evidence = {
  status: "ran_live",
  last: last ? tl.summarizeMessage(last) : null,
  sessionId,
  interrupted,
  platform: getPlatformInfo(),
};
fs.writeFileSync(path.join(__dirname, "evidence", "E1.json"), JSON.stringify(evidence, null, 2));
tl.write(evidence);
