/**
 * E4 — streamInput continuation / delivery timing (AR5 core question).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printBanner, liveGate, getPlatformInfo } from "./lib/env.mjs";
import { createTimeline, writeNotRunTemplate } from "./lib/timeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT = "E4";
printBanner(EXPERIMENT, "streamInput continuation timing");
const gate = liveGate();

const planned = [
  "Open AsyncIterable prompt stream (keep open)",
  "Let model enter a tool phase",
  "Deliver a second user message via Query.streamInput with priority variants",
  "Observe whether input lands in current turn, next turn, or is rejected",
];

const typeContract = {
  streamInput: "Query.streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>",
  promptUnion: "query({ prompt: string | AsyncIterable<SDKUserMessage> })",
  controlPrerequisite: "Control requests only supported when streaming input/output is used",
  priority: "SDKUserMessage.priority?: 'now' | 'next' | 'later' — typed delivery hint, runtime unproven here",
  shouldQuery:
    "SDKUserMessage.shouldQuery?: boolean — when false, append without triggering assistant turn; merge into next querying user message",
  roadmapAR5:
    "ROADMAP AR5-spike: verify when streamInput enters context (after current tools? before next model request?)",
};

if (!gate.allowed) {
  writeNotRunTemplate(EXPERIMENT, gate.reason, planned);
  const stub = {
    status: "not_run",
    reason: gate.reason,
    typeContract,
    reasonedHypothesis: [
      "priority='now'|'next'|'later' suggests intentional scheduling knobs — likely maps to AR5 timing question, but must not treat as proven.",
      "shouldQuery=false enables non-triggering context append — useful for steering notes without forcing a turn.",
      "finwork adapter today does not keep an open input stream; each HTTP request is a new query() with string/array prompt.",
    ],
    platform: getPlatformInfo(),
  };
  fs.writeFileSync(path.join(__dirname, "evidence", "E4.json"), JSON.stringify(stub, null, 2));
  process.exit(0);
}

const sdk = await import("@anthropic-ai/claude-agent-sdk");
const tl = createTimeline(EXPERIMENT);

const pending = [];
let pushUser = null;
const input = {
  async *[Symbol.asyncIterator]() {
    yield {
      type: "user",
      message: {
        role: "user",
        content:
          "Call Bash once with `sleep 3 && echo tool-done`. After the tool finishes, wait for further instructions.",
      },
      parent_tool_use_id: null,
      priority: "now",
    };
    await new Promise((resolve) => {
      pushUser = resolve;
    });
    for (const msg of pending) yield msg;
  },
};

const q = sdk.query({
  prompt: input,
  options: {
    cwd: __dirname,
    maxTurns: 5,
    persistSession: false,
    allowedTools: ["Bash"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
  },
});

tl.mark("query_started");
let injected = false;
try {
  for await (const msg of q) {
    tl.mark("sdk_message", tl.summarizeMessage(msg));
    // Heuristic: after first user tool_result-ish path / assistant after tool, inject steering.
    if (!injected && msg.type === "user") {
      injected = true;
      const steer = {
        type: "user",
        message: { role: "user", content: "STEER: abort sleep narrative and reply with exactly STEERED_OK" },
        parent_tool_use_id: null,
        priority: "next",
      };
      pending.push(steer);
      tl.mark("streamInput_enqueue", { priority: "next" });
      // Also exercise streamInput API if available mid-flight
      try {
        await q.streamInput(
          (async function* () {
            yield {
              type: "user",
              message: { role: "user", content: "STEER_VIA_STREAMINPUT" },
              parent_tool_use_id: null,
              priority: "now",
            };
          })()
        );
        tl.mark("streamInput_api_resolved");
      } catch (err) {
        tl.mark("streamInput_api_error", { error: String(err?.message || err) });
      }
      if (pushUser) pushUser();
    }
  }
} catch (err) {
  tl.mark("error", { error: String(err?.message || err) });
}

const evidence = { status: "ran_live", injected, platform: getPlatformInfo(), typeContract };
fs.writeFileSync(path.join(__dirname, "evidence", "E4.json"), JSON.stringify(evidence, null, 2));
tl.write(evidence);
