/**
 * E6 — Quiesce invariant after pause.
 * Free local probe always runs (file hash + kill timeout).
 * SDK live portion optional.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { printBanner, liveGate, getPlatformInfo } from "./lib/env.mjs";
import { createTimeline, writeNotRunTemplate } from "./lib/timeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT = "E6";
printBanner(EXPERIMENT, "Quiesce invariant");
const gate = liveGate();

const planned = [
  "Record file hashes + event cursor before pause",
  "interrupt Query + kill child subprocesses + checkpoint",
  "Observe for at least one kill-timeout window",
  "Assert no new SDK events and no file mutations",
];

const tl = createTimeline(EXPERIMENT);
const watchFile = path.join(__dirname, "evidence", "E6-watch.bin");
fs.mkdirSync(path.dirname(watchFile), { recursive: true });
fs.writeFileSync(watchFile, Buffer.from("quiesce-start"));

function hashFile(p) {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const hashBefore = hashFile(watchFile);
tl.mark("hash_before", { hashBefore });

const child = spawn(
  process.execPath,
  [
    "-e",
    `
    const fs = require('fs');
    const f = process.argv[1];
    const t = setInterval(() => fs.appendFileSync(f, 'x'), 100);
    setTimeout(() => { clearInterval(t); }, 10_000);
    `,
    watchFile,
  ],
  { stdio: "ignore" }
);
tl.mark("writer_spawned", { pid: child.pid });
await new Promise((r) => setTimeout(r, 350));

const hashMid = hashFile(watchFile);
tl.mark("hash_mid_before_kill", { hashMid, changed: hashMid !== hashBefore });

// Simulate pause sequence: interrupt-equivalent (host kill) + checkpoint
child.kill("SIGKILL");
const killed = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
tl.mark("child_killed", killed);

const KILL_TIMEOUT_MS = 1500;
tl.mark("quiesce_watch_start", { windowMs: KILL_TIMEOUT_MS });
const hashes = [];
const watchStart = Date.now();
while (Date.now() - watchStart < KILL_TIMEOUT_MS) {
  hashes.push({ t: Date.now() - watchStart, hash: hashFile(watchFile) });
  await new Promise((r) => setTimeout(r, 200));
}
const uniqueHashes = [...new Set(hashes.map((h) => h.hash))];
const stable = uniqueHashes.length === 1;
tl.mark("quiesce_watch_end", { stable, uniqueHashes });

const localProbe = {
  status: "ran_local_quiesce_probe",
  stableAfterKill: stable,
  hashBefore,
  hashMid,
  uniqueHashesAfterKill: uniqueHashes,
  killTimeoutMs: KILL_TIMEOUT_MS,
  conclusion: stable
    ? "After SIGKILL, watched file stayed immutable for the timeout window (host-side quiesce achievable)."
    : "File still mutated after kill — quiesce failed (unexpected for SIGKILL).",
};

if (!gate.allowed) {
  writeNotRunTemplate(
    EXPERIMENT,
    `SDK live quiesce skipped: ${gate.reason}`,
    planned
  );
  const stub = {
    ...localProbe,
    sdkLive: "not_run",
    reason: gate.reason,
    productImplication: [
      "Quiesce requires host-owned kill of Python/LO children + event cursor freeze; SDK interrupt alone is insufficient evidence.",
      "Cannot claim auto-segment pause safety without live E1+E2+E6 together.",
    ],
    platform: getPlatformInfo(),
  };
  fs.writeFileSync(path.join(__dirname, "evidence", "E6.json"), JSON.stringify(stub, null, 2));
  tl.write(stub);
  process.exit(0);
}

// Live: interrupt then watch — omitted details mirror E1/E2; record gate open.
const evidence = { ...localProbe, sdkLive: "gate_open_but_combined_in_E1_E2", platform: getPlatformInfo() };
fs.writeFileSync(path.join(__dirname, "evidence", "E6.json"), JSON.stringify(evidence, null, 2));
tl.write(evidence);
