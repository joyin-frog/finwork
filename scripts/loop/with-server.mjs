// Boots `next dev` on the isolated sandbox env, waits until it answers, runs the
// given child command (with BASE_URL set), then tears the server down. Reusable
// wrapper so the loop's server-bound checks are self-contained.
//
//   node scripts/loop/with-server.mjs -- node scripts/loop/api-smoke.mjs
//   node scripts/loop/with-server.mjs --port 3997 -- npx playwright test
import { spawn } from "node:child_process";
import { prepareSandbox } from "./sandbox-env.mjs";

const argv = process.argv.slice(2);
const portIdx = argv.indexOf("--port");
const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 3997;
const sep = argv.indexOf("--");
const childCmd = sep >= 0 ? argv.slice(sep + 1) : [];
if (childCmd.length === 0) {
  console.error("usage: with-server.mjs [--port N] -- <cmd...>");
  process.exit(2);
}
const BASE = `http://127.0.0.1:${port}`;

let shuttingDown = false;
let serverPid = null;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (serverPid) process.kill(-serverPid, "SIGTERM"); } catch { /* gone */ }
  try { spawn("pkill", ["-f", `next dev -p ${port}`]); } catch { /* ok */ }
  setTimeout(() => process.exit(code), 600);
}
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

async function waitReady(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(BASE + "/", { redirect: "manual" });
      if (res.status > 0 && res.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const { env, appDataDir, model, apiUrl } = await prepareSandbox({ reset: false });
console.error(`[with-server] sandbox=${appDataDir} model=${model} apiUrl=${apiUrl}`);
console.error(`[with-server] starting next dev on :${port} ...`);

const server = spawn("npx", ["next", "dev", "-p", String(port)], {
  env: { ...env, PORT: String(port) },
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
});
serverPid = server.pid;
server.on("exit", (code) => {
  if (!shuttingDown) { console.error(`[with-server] dev server exited early (${code})`); shutdown(1); }
});

if (!(await waitReady())) {
  console.error("[with-server] server never became ready");
  shutdown(1);
} else {
  console.error(`[with-server] ready — running: ${childCmd.join(" ")}`);
  const child = spawn(childCmd[0], childCmd.slice(1), {
    env: { ...env, BASE_URL: BASE },
    stdio: "inherit",
  });
  child.on("exit", (code) => shutdown(code ?? 1));
}
