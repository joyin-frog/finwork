/**
 * E5 — Repeated resume of the same session (3×).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printBanner, liveGate, getPlatformInfo } from "./lib/env.mjs";
import { createTimeline, writeNotRunTemplate } from "./lib/timeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT = "E5";
printBanner(EXPERIMENT, "Repeated resume ×3");
const gate = liveGate();

const planned = [
  "Create session with short prompt, persistSession true",
  "Resume same sessionId three times with incremental prompts",
  "Check context continuity, usage accumulation, tool idempotency, session invalidation",
];

const typeContract = {
  resume: "options.resume?: string",
  forkSession: "options.forkSession?: boolean — fork to new session id rather than continue",
  sessionIdOption: "options.sessionId?: string — mutually exclusive with resume unless forkSession",
  listSessions: "SDK exports listSessions / getSessionInfo / getSessionMessages",
  adapterPattern:
    "claude-adapter: resumeSession + claudeSessionId; on stale 'No conversation found' rebuilds with new sessionId + full history",
};

if (!gate.allowed) {
  writeNotRunTemplate(EXPERIMENT, gate.reason, planned);
  const stub = {
    status: "not_run",
    reason: gate.reason,
    typeContract,
    reasonedRisks: [
      "Repeated resume is the intended product path for explicit user continue — adapter already does single-step resume.",
      "Triple resume without live proof of transcript integrity / tool double-exec remains a risk for auto-segmentation.",
      "forkSession exists if continue-in-place is unsafe; would break 'same runId' continuity claims.",
    ],
    platform: getPlatformInfo(),
  };
  fs.writeFileSync(path.join(__dirname, "evidence", "E5.json"), JSON.stringify(stub, null, 2));
  process.exit(0);
}

const sdk = await import("@anthropic-ai/claude-agent-sdk");
const tl = createTimeline(EXPERIMENT);

async function runOnce(label, opts, prompt) {
  const q = sdk.query({ prompt, options: opts });
  let sessionId = null;
  let result = null;
  for await (const msg of q) {
    tl.mark(`${label}_msg`, tl.summarizeMessage(msg));
    if (msg.session_id) sessionId = msg.session_id;
    if (msg.type === "result") result = tl.summarizeMessage(msg);
  }
  return { sessionId, result };
}

const baseOpts = {
  cwd: __dirname,
  persistSession: true,
  maxTurns: 2,
  allowedTools: [],
};

const first = await runOnce("seed", baseOpts, "Reply with exactly SEED_OK and remember the token CRX1-TOKEN.");
tl.mark("seed_done", first);

let sessionId = first.sessionId;
const resumes = [];
for (let i = 1; i <= 3; i++) {
  if (!sessionId) break;
  const r = await runOnce(
    `resume${i}`,
    { ...baseOpts, resume: sessionId },
    `Resume check ${i}: reply with CRX1-TOKEN if you still remember it, else say FORGOT.`
  );
  resumes.push(r);
  sessionId = r.sessionId || sessionId;
}

const evidence = { status: "ran_live", first, resumes, platform: getPlatformInfo(), typeContract };
fs.writeFileSync(path.join(__dirname, "evidence", "E5.json"), JSON.stringify(evidence, null, 2));
tl.write(evidence);
