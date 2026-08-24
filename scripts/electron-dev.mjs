import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const port = Number.parseInt(process.env.FINANCE_AGENT_DESKTOP_PORT || "3000", 10);
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const electronBinary = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const children = new Set();

function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stop(code = 0) {
  for (const child of children) child.kill();
  process.exit(code);
}

function healthReady() {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 800 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await healthReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Next dev server did not become ready on port ${port}`);
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

const next = run(packageManager, ["run", "web:dev", "--port", String(port)], {
  ...process.env,
  FINANCE_AGENT_DESKTOP_PORT: String(port),
});
next.once("exit", (code) => stop(code ?? 1));

try {
  await waitForServer();
  const electron = run(electronBinary, ["."], { ...process.env, FINANCE_AGENT_DESKTOP_PORT: String(port) });
  electron.once("exit", (code) => stop(code ?? 0));
} catch (error) {
  console.error(`[electron-dev] ${error instanceof Error ? error.message : error}`);
  stop(1);
}
