// Category-parallel golden eval. Each category runs as its own worker process
// against an isolated sandbox COPY (seeded KB included), so writes don't contend
// and the slow categories run concurrently instead of sequentially.
//
// Prereq: the base sandbox (.claude/loop-sandbox/appdata) is reset + KB-seeded.
//   node scripts/loop/sandbox-env.mjs --reset
//   node scripts/loop/with-server.mjs -- node scripts/loop/seed-knowledge.mjs
//   node scripts/loop/golden-parallel.mjs [cat1,cat2,...] [--concurrency N]
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = path.join(REPO, ".claude", "loop-sandbox", "appdata"); // reset + seeded
const PYRT = process.env.FINANCE_AGENT_PYTHON_RUNTIME_DIR
  || path.join(os.homedir(), "Library", "Application Support", "finance-agent", "python-runtime");

const args = process.argv.slice(2);
const concIdx = args.indexOf("--concurrency");
const CONC = concIdx >= 0 ? Number(args[concIdx + 1]) : 5;
const catArg = args.find((a) => !a.startsWith("--") && a !== String(CONC));
const CATS = (catArg || "greeting,trivial_qa,tool_task,rag_qa,complex_workflow").split(",").map((s) => s.trim()).filter(Boolean);

async function runCat(cat) {
  const dir = path.join(REPO, ".claude", "loop-sandbox", `cat-${cat}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.cp(BASE, dir, { recursive: true });
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "tests/golden/run.ts"], {
      cwd: REPO,
      env: { ...process.env, FINANCE_AGENT_APP_DATA_DIR: dir, FINANCE_AGENT_PYTHON_RUNTIME_DIR: PYRT, GOLDEN_CATEGORY: cat },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    child.on("exit", () => {
      const total = out.match(/Total: (\d+)\/(\d+)/);
      const avg = out.match(/Average Score: ([\d.]+)/);
      const fails = (out.match(/💥|❌ 0\.\d+/g) || []).length;
      resolve({ cat, passed: total ? +total[1] : 0, n: total ? +total[2] : 0, avg: avg ? +avg[1] : null, secs: Math.round((Date.now() - started) / 1000) });
    });
  });
}

// simple concurrency pool
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

const t0 = Date.now();
console.error(`[golden-parallel] ${CATS.length} 类,并发 ${CONC},各用独立已种库沙箱副本…`);
const results = await pool(CATS, CONC, runCat);

let P = 0, N = 0, scoreSum = 0, scoreN = 0;
console.log(`\n━━━ 分类并行 golden(墙钟 ${Math.round((Date.now() - t0) / 1000)}s)━━━`);
for (const r of results) {
  console.log(`  ${r.cat.padEnd(18)} ${r.passed}/${r.n}  avg=${r.avg ?? "?"}  (${r.secs}s)`);
  P += r.passed; N += r.n; if (r.avg != null) { scoreSum += r.avg * r.n; scoreN += r.n; }
}
console.log(`  ${"合计".padEnd(16)} ${P}/${N}  加权avg=${scoreN ? (scoreSum / scoreN).toFixed(3) : "?"}`);

// cleanup copies
for (const cat of CATS) {
  await fs.rm(path.join(REPO, ".claude", "loop-sandbox", `cat-${cat}`), { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify({ total: `${P}/${N}`, weightedAvg: scoreN ? +(scoreSum / scoreN).toFixed(3) : null, perCategory: results }, null, 2));
