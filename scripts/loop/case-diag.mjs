// Case-level parallel diagnostic: runs each given golden case as its own worker
// (isolated seeded sandbox copy), captures per-case toolCalls + scores. Lets you
// SEE what tools the agent actually uses per case, to calibrate expected_tool_calls
// to reality — and verify each change by real run, in parallel for speed.
//
//   node scripts/loop/case-diag.mjs complex-001,complex-002,...   (default: all complex)
//   CONC=5 node scripts/loop/case-diag.mjs <ids>
// Prereq: base sandbox (.claude/loop-sandbox/appdata) reset + KB-seeded.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = path.join(REPO, ".claude", "loop-sandbox", "appdata");
const PYRT = process.env.FINANCE_AGENT_PYTHON_RUNTIME_DIR
  || path.join(os.homedir(), "Library", "Application Support", "finance-agent", "python-runtime");

const DEFAULT = Array.from({ length: 10 }, (_, i) => `complex-${String(i + 1).padStart(3, "0")}`).join(",");
const ids = (process.argv[2] || DEFAULT).split(",").map((s) => s.trim()).filter(Boolean);
const CONC = Number(process.env.CONC || 5);

async function runCase(id) {
  const dir = path.join(REPO, ".claude", "loop-sandbox", `case-${id}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.cp(BASE, dir, { recursive: true });
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "tests/golden/run.ts"], {
      cwd: REPO,
      env: { ...process.env, FINANCE_AGENT_APP_DATA_DIR: dir, FINANCE_AGENT_PYTHON_RUNTIME_DIR: PYRT, GOLDEN_CASE_ID: id },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    child.on("exit", () => {
      try {
        const start = out.indexOf('{\n  "summary"');
        const j = JSON.parse(out.slice(start, out.lastIndexOf("}") + 1)); // 截到 JSON 末尾,排除后面的 PASS/FAIL 行
        const r = j.results?.[0] ?? {};
        resolve({ id, secs: Math.round((Date.now() - started) / 1000), score: r.score, tool: r.toolScore, kw: r.keywordScore, judge: r.judgeScore, calls: r.toolCalls || [], err: r.error, resp: (r.response || "").replace(/\s+/g, " ").slice(0, 100) });
      } catch {
        resolve({ id, error: "parse fail", tail: out.split("\n").slice(-3).join(" ") });
      }
    });
  });
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const t0 = Date.now();
console.error(`[case-diag] ${ids.length} 例,并发 ${CONC},各用独立已种库副本…`);
const results = await pool(ids, CONC, runCase);
console.log(`\n━━━ 逐例诊断(墙钟 ${Math.round((Date.now() - t0) / 1000)}s)━━━`);
let pass = 0;
for (const r of results) {
  if (r.error) { console.log(`  ${r.id}: ERROR ${r.error} | ${r.tail || ""}`); continue; }
  if (r.score >= 0.75) pass++;
  console.log(`  ${r.id}  score=${r.score?.toFixed(2)} tool=${r.tool} kw=${r.kw} judge=${r.judge} (${r.secs}s)\n     calls=[${r.calls.join(", ") || "无"}]${r.err ? " err=" + r.err : ""}`);
}
console.log(`\n  通过(≥0.75): ${pass}/${results.length}`);
for (const id of ids) await fs.rm(path.join(REPO, ".claude", "loop-sandbox", `case-${id}`), { recursive: true, force: true }).catch(() => {});
