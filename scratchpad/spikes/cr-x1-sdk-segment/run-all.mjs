#!/usr/bin/env node
/**
 * Run E0–E6 sequentially. Default is dry-run / free probes.
 * Live burns: RUN_LIVE=1 ANTHROPIC_API_KEY=... npm run all
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { liveGate, getPlatformInfo } from "./lib/env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scripts = [
  "e0-api-surface.mjs",
  "e1-interrupt-generation.mjs",
  "e2-interrupt-python.mjs",
  "e3-max-turns.mjs",
  "e4-stream-input.mjs",
  "e5-repeated-resume.mjs",
  "e6-quiesce.mjs",
];

console.log("CR-X1 spike runner");
console.log(JSON.stringify({ platform: getPlatformInfo(), gate: liveGate() }, null, 2));

for (const script of scripts) {
  console.log(`\n>>>> running ${script}`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      cwd: __dirname,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    console.error(`FAIL ${script} exit=${code}`);
    process.exit(code);
  }
}

console.log("\nAll experiment scripts finished.");
