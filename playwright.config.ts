import { defineConfig } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// 两种 e2e 模式:
// - 默认 mock 模式(CI 用):确定性模拟 Agent(FINANCE_AGENT_MOCK_AGENT=1),无需 key / 网络 / python,
//   隔离 app-data,跑 e2e/mock/ 下的 journey。
// - 真 key 模式(E2E_REAL=1,手动):真 Agent + 真网关,跑 e2e/ 根下的 journeys.spec(沙箱带真 key)。
const REAL = process.env.E2E_REAL === "1";

const MOCK_APPDATA = path.join(process.cwd(), ".claude", "e2e-mock", "appdata");
const SANDBOX = path.join(process.cwd(), ".claude", "loop-sandbox", "appdata");
const PORT = Number(process.env.PW_PORT || (REAL ? 3998 : 3997));

function realAppDataDir() {
  const root =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
        : process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(root, "finance-agent");
}

// 真 key 模式:镜像真实安装的 python 运行时,worker 类工具能渲染、首启 doctor 不报红。
const realEnv: Record<string, string> = { FINANCE_AGENT_APP_DATA_DIR: SANDBOX };
const realRuntime = path.join(realAppDataDir(), "python-runtime");
if (fs.existsSync(path.join(realRuntime, "bin", "python3")) || fs.existsSync(path.join(realRuntime, "Scripts", "python.exe"))) {
  realEnv.FINANCE_AGENT_PYTHON_RUNTIME_DIR = realRuntime;
}

// mock 模式:隔离 app-data + 开模拟 Agent;不依赖 key / python / 网络。
// SECRET_BACKEND=file:密钥走隔离 app-data 里的文件,绝不碰本机钥匙串(否则会覆盖用户真 key),
// 同时让 apiKeyConfigured 只反映隔离环境(不被钥匙串里的真 key 泄漏污染路由)。
const mockEnv: Record<string, string> = {
  FINANCE_AGENT_APP_DATA_DIR: MOCK_APPDATA,
  FINANCE_AGENT_MOCK_AGENT: "1",
  FINANCE_AGENT_SECRET_BACKEND: "file",
};

const serverEnv = REAL ? realEnv : mockEnv;

export default defineConfig({
  testDir: REAL ? "./e2e" : "./e2e/mock",
  testIgnore: REAL ? ["**/mock/**"] : [],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: REAL ? "./e2e/global-setup.ts" : "./e2e/mock/global-setup.ts",
  use: {
    baseURL: process.env.BASE_URL || `http://127.0.0.1:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
    actionTimeout: 30_000,
  },
  // 给了 BASE_URL 就认为外部已起服务;否则按所选模式自启 next dev。
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: `npx next dev -p ${PORT}`,
        url: `http://127.0.0.1:${PORT}`,
        timeout: 120_000,
        reuseExistingServer: true,
        env: { ...process.env, ...serverEnv, PORT: String(PORT) },
      },
});
