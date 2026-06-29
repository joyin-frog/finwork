// 打包态运行时 smoke:启动「prepare-tauri 组装好的」next-server(= 用户机上真正跑的那份),打几个端点,
// 然后扫描服务端 stdout/stderr 里有没有「Windows 打包运行时」那几类致命签名。
//
// 为什么这么测:这些 bug(standalone 漏 chunk、平台二进制顶层 import、SDK 原生 CLI 缺失、stdio 编码)
// 在 mac 开发 / mock / Linux CI 默认 UTF-8 下都照不到 —— 只有「在目标平台跑真实组装产物」才暴露。
// 详见项目记忆 windows-runtime-test-blindspot。本脚本平台无关(Windows CI 跑它逮真问题;本地也能跑验证逻辑)。
//
// 用法:node scripts/windows-smoke.mjs   (需先 npm run build && npm run tauri:prepare)

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const serverDir = path.join(root, "src-tauri", "resources", "next-server");
const nodeBin = path.join(root, "src-tauri", "resources", "node", isWin ? "node.exe" : "node");
const serverEntry = path.join(serverDir, "server.js");

// 用户机上一旦命中即「整体网络错误/聊天报错」的致命签名 —— 出现任意一条即判定打包产物坏掉。
const FATAL = [
  "Cannot find module", // standalone 漏拷 .next/server/chunks/*.js
  "MODULE_NOT_FOUND",
  "Native CLI binary", // @anthropic-ai/claude-agent-sdk 原生 CLI 没打包
  "Could not find @vscode/ripgrep", // ripgrep 平台包顶层 import
  "surrogates not allowed", // worker stdio 非 UTF-8
  "UnhandledSchemeError", // edge runtime 误打 node: 内建
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fa-smoke-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";

  const child = spawn(nodeBin, [serverEntry], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      FINANCE_AGENT_PROJECT_ROOT: serverDir,
      FINANCE_AGENT_BUNDLED_PLUGIN_DIR: path.join(serverDir, "agent-skills"),
      FINANCE_AGENT_APP_DATA_DIR: dataDir, // DB/日志落临时目录,不污染
      FINANCE_AGENT_MOCK_AGENT: "1", // 不需要真 key/模型:只验证路由加载与产物完整
      PYTHONUTF8: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const cleanup = () => {
    try { child.kill(); } catch { /* ok */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
  };
  const fail = (msg) => {
    console.error(`\n[windows-smoke] FAIL: ${msg}\n----- next-server 输出 -----\n${log}\n---------------------------`);
    cleanup();
    process.exit(1);
  };

  child.on("exit", (code) => {
    if (code && code !== 0 && code !== null) fail(`next-server 进程提前退出 code=${code}`);
  });

  // 1) 等就绪:/api/health 是零依赖探针,但 server.js 自身要能加载(漏 chunk 会让它起不来 → 永不 200)。
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  if (!ready) fail("/api/health 90s 内未返回 200(next-server 没起来,通常是 standalone 漏 chunk)");

  // 2) 打一圈端点,触发各路由模块加载(漏 chunk / 顶层 import 抛错会在此现形并落日志)。
  const hit = async (method, p, body) => {
    try {
      await fetch(`${base}${p}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch { /* 状态码/超时不强校验:真正的判据是下面的致命签名扫描 */ }
  };
  await hit("GET", "/api/health?deep=1"); // DB 打开 + 网关可达(deep health)
  await hit("GET", "/api/cockpit/summary"); // 总览(读 DB,载入 finance-store 那批 chunk)
  await hit("POST", "/api/agent/query?stream=false", { prompt: "你好" }); // agent 路由模块加载(mock,不需 key)

  await sleep(800); // 给异步错误日志一点落地时间

  // 3) 判据:服务端输出里不得出现任何致命签名。
  const hits = FATAL.filter((sig) => log.includes(sig));
  if (hits.length) fail(`检测到打包产物致命错误签名:${hits.join(" | ")}`);

  console.log(`[windows-smoke] PASS — next-server 在 ${process.platform} 起得来、关键路由加载无致命错误。`);
  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error("[windows-smoke] 脚本异常:", e);
  process.exit(1);
});
