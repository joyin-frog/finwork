/**
 * E0 — Free API-surface probe (no paid LLM).
 * Documents Query/Options symbols that CR-X1 depends on.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { printBanner, getPlatformInfo, liveGate } from "./lib/env.mjs";
import { createTimeline } from "./lib/timeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sdkPkgPath = path.join(__dirname, "node_modules/@anthropic-ai/claude-agent-sdk/package.json");
const sdkTypesPath = path.join(__dirname, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts");

printBanner("E0", "API surface / type inspection");
const tl = createTimeline("E0");
const info = getPlatformInfo();
tl.mark("platform", info);

const types = fs.readFileSync(sdkTypesPath, "utf8");

const requiredSnippets = [
  { id: "Query.interrupt", re: /interrupt\(\): Promise<void>;/ },
  { id: "Query.streamInput", re: /streamInput\(stream: AsyncIterable<SDKUserMessage>\): Promise<void>;/ },
  { id: "Query.close", re: /close\(\): void;/ },
  { id: "Options.maxTurns", re: /maxTurns\?: number;/ },
  { id: "Options.resume", re: /resume\?: string;/ },
  { id: "Options.abortController", re: /abortController\?: AbortController;/ },
  { id: "Options.persistSession", re: /persistSession\?: boolean;/ },
  { id: "Options.forkSession", re: /forkSession\?: boolean;/ },
  { id: "SDKResultError.error_max_turns", re: /'error_max_turns'/ },
  { id: "TerminalReason.max_turns", re: /'max_turns'/ },
  { id: "TerminalReason.aborted_streaming", re: /'aborted_streaming'/ },
  { id: "TerminalReason.aborted_tools", re: /'aborted_tools'/ },
  { id: "SDKUserMessage.priority", re: /priority\?: 'now' \| 'next' \| 'later';/ },
  { id: "SDKUserMessage.shouldQuery", re: /shouldQuery\?: boolean;/ },
  { id: "control_requires_streaming_input", re: /Only available in streaming input mode\./ },
  {
    id: "control_requests_streaming_io",
    // Comment in sdk.d.ts may wrap across lines.
    re: /only supported when[\s\S]{0,40}streaming input\/output is used\./,
  },
];

const surface = {};
for (const item of requiredSnippets) {
  const ok = item.re.test(types);
  surface[item.id] = ok;
  tl.mark(ok ? "type_present" : "type_missing", { id: item.id });
}

// Extract Query method names from d.ts (rough)
const queryBlock = types.match(/export declare interface Query extends AsyncGenerator[\s\S]*?\n\}/);
const queryMethods = [];
if (queryBlock) {
  for (const m of queryBlock[0].matchAll(/^\s{4}([a-zA-Z_][a-zA-Z0-9_]*)\(/gm)) {
    queryMethods.push(m[1]);
  }
}
tl.mark("query_methods_from_types", { methods: queryMethods });

const sdk = await import("@anthropic-ai/claude-agent-sdk");
tl.mark("sdk_imported", { exports: Object.keys(sdk).filter((k) => !k.startsWith("_")).sort() });

// Runtime method presence: build a Query with string prompt (no LLM consume if we never iterate deeply).
// Mirror tests/skill-plugin.test.ts: control-channel only + interrupt cleanup.
let runtimeMethods = null;
let controlProbe = { status: "skipped", detail: null };
try {
  const q = sdk.query({
    prompt: "noop",
    options: {
      cwd: __dirname,
      tools: [],
      persistSession: false,
      maxTurns: 1,
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "sk-noop-test" },
    },
  });
  runtimeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(q))
    .filter((n) => n !== "constructor")
    .sort();
  tl.mark("runtime_query_methods", { methods: runtimeMethods });

  // Free-ish: try supportedCommands then interrupt (may spawn CLI; should not bill a model turn if we don't consume assistant stream meaningfully).
  try {
    const cmds = await Promise.race([
      q.supportedCommands(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("supportedCommands timeout 15s")), 15_000)),
    ]);
    controlProbe = {
      status: "ok",
      detail: { commandCount: Array.isArray(cmds) ? cmds.length : null },
    };
    tl.mark("supportedCommands_ok", controlProbe.detail);
  } catch (err) {
    controlProbe = { status: "failed", detail: String(err?.message || err) };
    tl.mark("supportedCommands_failed", { error: controlProbe.detail });
  } finally {
    try {
      await q.interrupt();
      tl.mark("interrupt_called");
    } catch (err) {
      tl.mark("interrupt_throw", { error: String(err?.message || err) });
    }
    try {
      q.close();
      tl.mark("close_called");
    } catch (err) {
      tl.mark("close_throw", { error: String(err?.message || err) });
    }
  }
} catch (err) {
  tl.mark("query_construct_failed", { error: String(err?.message || err) });
}

const evidence = {
  status: "ran",
  platform: info,
  liveGate: liveGate(),
  sdkPackage: require(sdkPkgPath),
  typeSurface: surface,
  queryMethodsFromTypes: queryMethods,
  runtimeMethods,
  controlProbe,
  notes: [
    "Control requests (interrupt/setModel/...) docs say: only supported when streaming input/output is used.",
    "Current finwork claude-adapter uses string prompt + AbortController, not Query.interrupt / streamInput.",
    "SDKUserMessage.priority ('now'|'next'|'later') and shouldQuery exist — type-level hint for streamInput delivery, live timing still unknown.",
    "error_max_turns is an SDKResultError subtype; TerminalReason includes max_turns / aborted_streaming / aborted_tools.",
  ],
};

const evidencePath = path.join(__dirname, "evidence", "E0-api-surface.json");
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
tl.write({ status: "ran", evidencePath });
console.log("E0 complete →", evidencePath);
