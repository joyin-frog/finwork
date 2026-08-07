import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const nodeBinary = path.join(
  root,
  "src-tauri",
  "resources",
  "node",
  process.platform === "win32" ? "node.exe" : "node",
);
const serverRoot = path.join(root, "src-tauri", "resources", "next-server");
const appData = await mkdtemp(path.join(tmpdir(), "finwork-ar14-packaged-"));
const port = String(41_000 + Math.floor(Math.random() * 1_000));
let output = "";
let child;
try {
  child = spawn(nodeBinary, ["server.js"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: port,
      FINANCE_AGENT_APP_DATA_DIR: appData,
      FINANCE_AGENT_DB_PATH: path.join(appData, "isolated.db"),
      FINANCE_AGENT_SECRET_BACKEND: "file",
      FINANCE_AGENT_SECRET_FILE: path.join(appData, "secret"),
      FINANCE_AGENT_PI_PREFLIGHT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + 20_000;
  while (!output.includes("[pi-preflight]") && Date.now() < deadline) {
    if (child.exitCode != null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const match = output.match(/\[pi-preflight\]\s+(\{[^\n]+\})/);
  const result = match ? JSON.parse(match[1]) : null;
  const assertions = {
    embeddedNodeStarted: child.exitCode == null,
    preflightObserved: Boolean(result),
    serviceLoaded: result?.serviceLoaded === true,
    piEsmLoaded: result?.piEsmLoaded === true,
    // 45 → 49：新增 patch_workbook / check_workbook_ties / detect_data_issues /
    // merge_labeled_tables（见 CONTEXT.md）。
    allToolsFound: result?.toolCount === 49,
    resourceLoaderLoaded: result?.resourceLoaderLoaded === true,
    controlledSessionDir: result?.controlledSessionDir === true,
  };
  const passed = Object.values(assertions).every(Boolean);
  console.log(JSON.stringify({ passed, assertions }, null, 2));
  if (!passed) {
    console.error(output.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]").slice(-2_000));
    process.exitCode = 1;
  }
} finally {
  child?.kill("SIGTERM");
  await rm(appData, { recursive: true, force: true });
}
