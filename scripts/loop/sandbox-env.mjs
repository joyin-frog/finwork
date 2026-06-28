// Isolated runtime sandbox for the whole-system harden loop.
// Redirects ALL app data (DB / files / knowledge / memory) to a throwaway dir,
// but carries the REAL gateway + apiKey from local-settings.json so LLM calls are genuine.
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Lives under .claude/ which is fully gitignored — the real apiKey copy never gets committed.
export const SANDBOX_DIR = path.join(REPO_ROOT, ".claude", "loop-sandbox", "appdata");

function realSettingsPath() {
  if (process.env.FINANCE_AGENT_REAL_SETTINGS) return process.env.FINANCE_AGENT_REAL_SETTINGS;
  const root =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
        : process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(root, "finance-agent", "local-settings.json");
}

export async function prepareSandbox({ reset = false } = {}) {
  if (reset) await fs.rm(SANDBOX_DIR, { recursive: true, force: true });
  await fs.mkdir(SANDBOX_DIR, { recursive: true });

  const realPath = realSettingsPath();
  let raw;
  try {
    raw = await fs.readFile(realPath, "utf-8");
  } catch {
    throw new Error(`找不到真实设置(含 apiKey):${realPath}`);
  }
  const parsed = JSON.parse(raw);
  const claude = parsed.claude ?? parsed;
  if (!claude.apiKey || !String(claude.apiKey).trim()) {
    throw new Error(`真实设置里没有 apiKey:${realPath}`);
  }
  // 测试用模型覆盖(只改沙箱副本,不动真实设置):换更强模型验证 complex 等是否模型上限。
  // routerModel 保持不变(意图分类用快模型即可)。
  if (process.env.FINANCE_AGENT_TEST_MODEL) {
    claude.model = process.env.FINANCE_AGENT_TEST_MODEL;
    claude.mainModel = process.env.FINANCE_AGENT_TEST_MODEL;
    claude.subagentModel = process.env.FINANCE_AGENT_TEST_MODEL;
  }
  await fs.writeFile(
    path.join(SANDBOX_DIR, "local-settings.json"),
    JSON.stringify({ claude }, null, 2) + "\n",
    "utf-8",
  );

  // Seed the demo reimbursement CSV (used by upload journeys) if the real install has one.
  try {
    await fs.copyFile(
      path.join(path.dirname(realPath), "demo_reimbursements.csv"),
      path.join(SANDBOX_DIR, "demo_reimbursements.csv"),
    );
  } catch {
    /* optional seed */
  }

  // Reuse a healthy python runtime from the real install so worker-backed tools/skills
  // (xlsx/pdf/docx/pptx, analyze/parse) actually run and the first-run doctor gate stays quiet.
  const extraEnv = { FINANCE_AGENT_APP_DATA_DIR: SANDBOX_DIR };
  const realRuntime = path.join(path.dirname(realPath), "python-runtime");
  if (existsSync(path.join(realRuntime, "bin", "python3")) || existsSync(path.join(realRuntime, "Scripts", "python.exe"))) {
    extraEnv.FINANCE_AGENT_PYTHON_RUNTIME_DIR = realRuntime;
  }

  return {
    appDataDir: SANDBOX_DIR,
    settingsPath: path.join(SANDBOX_DIR, "local-settings.json"),
    model: claude.model || "(default)",
    apiUrl: claude.apiUrl || "https://api.anthropic.com",
    pythonRuntime: extraEnv.FINANCE_AGENT_PYTHON_RUNTIME_DIR ?? null,
    env: { ...process.env, ...extraEnv },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reset = process.argv.includes("--reset");
  const s = await prepareSandbox({ reset });
  console.error(`[sandbox] ready: ${s.appDataDir}`);
  console.error(`[sandbox] model=${s.model} apiUrl=${s.apiUrl} (key carried from real settings)`);
  console.error(`[sandbox] pythonRuntime=${s.pythonRuntime ?? "(none — first-run gate may show)"}`);
  console.log(`export FINANCE_AGENT_APP_DATA_DIR='${s.appDataDir}'`);
  if (s.pythonRuntime) console.log(`export FINANCE_AGENT_PYTHON_RUNTIME_DIR='${s.pythonRuntime}'`);
}
