/**
 * E3 — maxTurns boundary.
 * Documents error_max_turns subtype from types; live run optional.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printBanner, liveGate, getPlatformInfo } from "./lib/env.mjs";
import { createTimeline, writeNotRunTemplate } from "./lib/timeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT = "E3";
printBanner(EXPERIMENT, "maxTurns boundary");
const gate = liveGate();

const planned = [
  "query with maxTurns: 1 (or 2) and a task that needs more turns",
  "Capture result subtype (expect error_max_turns) and session_id",
  "Resume same session WITHOUT injecting a fake user 'continue' if possible",
  "Compare resume vs new sessionId rebuild (adapter already retries stale resume)",
];

const typeContract = {
  option: "Options.maxTurns?: number — Maximum number of conversation turns before the query stops",
  resultSubtype: "SDKResultError.subtype includes 'error_max_turns'",
  terminalReason: "TerminalReason includes 'max_turns'",
  sessionField: "SDKResultError includes session_id: string — type allows resume attempt after max turns",
  resumeApi: "options.resume?: string loads conversation history",
  resumeSessionAt: "options.resumeSessionAt?: string for message-uuid scoped resume",
  openQuestion:
    "Types do not prove whether resume after error_max_turns continues cleanly without a synthetic user continue message — needs live E3.",
};

if (!gate.allowed) {
  writeNotRunTemplate(EXPERIMENT, gate.reason, planned);
  const stub = {
    status: "not_run",
    reason: gate.reason,
    typeContract,
    adapterToday: {
      maxTurns: 30,
      resume: "claude-adapter passes resume: claudeSessionId when resumeSession true",
      staleRetry: "shouldRetryStaleSession rebuilds on 'No conversation found'",
    },
    platform: getPlatformInfo(),
  };
  fs.writeFileSync(path.join(__dirname, "evidence", "E3.json"), JSON.stringify(stub, null, 2));
  process.exit(0);
}

const sdk = await import("@anthropic-ai/claude-agent-sdk");
const tl = createTimeline(EXPERIMENT);
const q = sdk.query({
  prompt:
    "You must use the Bash tool at least 3 separate times to echo step1, step2, step3. Between each Bash call, briefly say what you will do next.",
  options: {
    cwd: __dirname,
    maxTurns: 1,
    persistSession: true,
    allowedTools: ["Bash"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
});

let result = null;
let sessionId = null;
try {
  for await (const msg of q) {
    tl.mark("sdk_message", tl.summarizeMessage(msg));
    if (msg.session_id) sessionId = msg.session_id;
    if (msg.type === "result") result = tl.summarizeMessage(msg);
  }
} catch (err) {
  tl.mark("error", { error: String(err?.message || err) });
}

tl.mark("max_turns_result", { result, sessionId });

let resumeResult = null;
if (sessionId) {
  tl.mark("resume_attempt", { sessionId });
  const q2 = sdk.query({
    prompt: "", // empty — test whether resume alone continues; may fail
    options: {
      cwd: __dirname,
      resume: sessionId,
      maxTurns: 2,
      persistSession: true,
      allowedTools: ["Bash"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });
  try {
    for await (const msg of q2) {
      tl.mark("resume_message", tl.summarizeMessage(msg));
      if (msg.type === "result") resumeResult = tl.summarizeMessage(msg);
    }
  } catch (err) {
    tl.mark("resume_error", { error: String(err?.message || err) });
  }
}

const evidence = {
  status: "ran_live",
  typeContract,
  result,
  sessionId,
  resumeResult,
  platform: getPlatformInfo(),
};
fs.writeFileSync(path.join(__dirname, "evidence", "E3.json"), JSON.stringify(evidence, null, 2));
tl.write(evidence);
