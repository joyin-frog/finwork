/**
 * E2 — Interrupt during a long local subprocess (stand-in for run_python).
 * Dry-run documents ownership: SDK interrupt vs host kill.
 * Live mode starts Bash sleep via tools, then interrupt + optional host kill.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { printBanner, liveGate, getPlatformInfo } from "./lib/env.mjs";
import { createTimeline, writeNotRunTemplate } from "./lib/timeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT = "E2";
printBanner(EXPERIMENT, "Interrupt during long Python/Bash subprocess");
const gate = liveGate();

const planned = [
  "Start SDK query that launches a long-running Bash/Python tool",
  "Call Query.interrupt() while tool runs",
  "Observe whether child pid exits, continues, or keeps writing files",
  "Separately host-kill the child and compare",
  "Record who owns kill semantics",
];

// Always run a free local subprocess probe (no LLM) to document host-side kill ownership.
const tl = createTimeline(EXPERIMENT);
const marker = path.join(__dirname, "evidence", "E2-marker.txt");
fs.mkdirSync(path.dirname(marker), { recursive: true });
if (fs.existsSync(marker)) fs.unlinkSync(marker);

const child = spawn(
  process.execPath,
  [
    "-e",
    `
    const fs = require('fs');
    const marker = process.argv[1];
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      fs.appendFileSync(marker, 'tick-' + n + '\\n');
      if (n >= 30) { clearInterval(t); process.exit(0); }
    }, 200);
    `,
    marker,
  ],
  { stdio: "ignore" }
);
tl.mark("local_child_spawned", { pid: child.pid });
await new Promise((r) => setTimeout(r, 600));
const beforeKill = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
tl.mark("before_kill", { bytes: beforeKill.length, preview: beforeKill.trim() });
child.kill("SIGTERM");
const exitCode = await new Promise((resolve) => {
  child.on("exit", (code, signal) => resolve({ code, signal }));
});
await new Promise((r) => setTimeout(r, 400));
const afterKill = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
tl.mark("after_kill", { exitCode, bytes: afterKill.length, grew: afterKill.length > beforeKill.length });

const localProbe = {
  status: "ran_local_only",
  conclusion:
    "Host owns subprocess lifecycle. SDK interrupt type docs do not claim to kill tool child processes; finwork must kill run_python / Bash children for quiesce.",
  exitCode,
  beforeBytes: beforeKill.length,
  afterBytes: afterKill.length,
};

if (!gate.allowed) {
  writeNotRunTemplate(EXPERIMENT, `SDK tool interrupt live skipped: ${gate.reason}`, planned);
  const stub = {
    ...localProbe,
    sdkLive: "not_run",
    reason: gate.reason,
    typeNotes: [
      "Query.interrupt stops query processing; no typed guarantee about in-flight Bash/Python children.",
      "Query.stopTask / backgroundTasks exist for task control, separate from interrupt.",
      "TerminalReason includes aborted_tools — suggests abort path aware of tools, still not a kill contract.",
    ],
    platform: getPlatformInfo(),
  };
  fs.writeFileSync(path.join(__dirname, "evidence", "E2.json"), JSON.stringify(stub, null, 2));
  tl.write(stub);
  process.exit(0);
}

const sdk = await import("@anthropic-ai/claude-agent-sdk");
tl.mark("live_sdk_start");
const q = sdk.query({
  prompt:
    "Run a single Bash command: `python3 -c \"import time; open('evidence/E2-sdk-py.txt','a').write('start\\\\n'); time.sleep(120); open('evidence/E2-sdk-py.txt','a').write('done\\\\n')\"`. Do nothing else.",
  options: {
    cwd: __dirname,
    persistSession: false,
    maxTurns: 2,
    allowedTools: ["Bash"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
});

let sawTool = false;
try {
  for await (const msg of q) {
    tl.mark("sdk_message", tl.summarizeMessage(msg));
    if (!sawTool && msg.type === "assistant") {
      sawTool = true;
      await new Promise((r) => setTimeout(r, 1500));
      tl.mark("calling_interrupt_during_tool");
      await q.interrupt();
    }
  }
} catch (err) {
  tl.mark("live_error", { error: String(err?.message || err) });
}

const evidence = { ...localProbe, sdkLive: "ran", sawTool, platform: getPlatformInfo() };
fs.writeFileSync(path.join(__dirname, "evidence", "E2.json"), JSON.stringify(evidence, null, 2));
tl.write(evidence);
