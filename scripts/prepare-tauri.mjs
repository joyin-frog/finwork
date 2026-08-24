import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rgPath } from "@vscode/ripgrep";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");

// ──────────────────────────────────────────────────────────────────────────────
// § A  Updater pubkey 构建期注入
//   优先读 TAURI_SIGNING_PUBLIC_KEY(CI/local env),
//   次读 src-tauri/updater-pubkey.txt(本地文件,已加入 .gitignore),
//   两者均缺则保留占位并打印告警(不崩)。
// ──────────────────────────────────────────────────────────────────────────────
const PUBKEY_PLACEHOLDER = "NEEDS_TAURI_SIGNING_PUBLIC_KEY_SEE_RUNBOOK";
const pubkeyTxtPath = path.join(root, "src-tauri", "updater-pubkey.txt");

async function injectUpdaterPubkey() {
  let pubkey = process.env.TAURI_SIGNING_PUBLIC_KEY?.trim() ?? "";
  if (!pubkey && existsSync(pubkeyTxtPath)) {
    pubkey = (await readFile(pubkeyTxtPath, "utf-8")).trim();
  }

  const conf = JSON.parse(await readFile(tauriConfPath, "utf-8"));

  if (pubkey) {
    conf.plugins ??= {};
    conf.plugins.updater ??= {};
    conf.plugins.updater.pubkey = pubkey;
    await writeFile(tauriConfPath, JSON.stringify(conf, null, 2) + "\n", "utf-8");
    console.log("prepare-tauri: updater pubkey injected from env/file.");
  } else {
    // 确保 conf 里不残留旧 PLACEHOLDER_FILL_... 字符串;改用可识别的占位符
    if (
      typeof conf.plugins?.updater?.pubkey === "string" &&
      (conf.plugins.updater.pubkey.startsWith("PLACEHOLDER_") ||
        conf.plugins.updater.pubkey === PUBKEY_PLACEHOLDER)
    ) {
      conf.plugins.updater.pubkey = PUBKEY_PLACEHOLDER;
      await writeFile(tauriConfPath, JSON.stringify(conf, null, 2) + "\n", "utf-8");
    }
    console.warn(
      "prepare-tauri: [WARN] TAURI_SIGNING_PUBLIC_KEY 未设置,且 src-tauri/updater-pubkey.txt 不存在。\n" +
        "  updater pubkey 保留占位符 — 打包产物的自动更新签名校验将不可用。\n" +
        "  生产发版前请按 docs/runbook-signed-release.md § 1 生成密钥并配置。"
    );
  }
}

if (process.env.FINWORK_SKIP_TAURI_UPDATER !== "1") {
  await injectUpdaterPubkey();
}

// ──────────────────────────────────────────────────────────────────────────────
// § B  Next.js 产物打包到 Tauri resources
//   需要先跑 `pnpm run build` 生成 .next/standalone。
//   若产物缺失则打印告警并提前退出(dev 或仅注入 pubkey 时不崩)。
// ──────────────────────────────────────────────────────────────────────────────
const nextDir = path.join(root, ".next");
const standaloneDir = path.join(nextDir, "standalone");
const staticDir = path.join(nextDir, "static");
const agentSkillsDir = path.join(root, "agent-skills");
const workersDir = path.join(root, "workers");
const runtimeLockDir = path.join(root, "runtime-lock");
const libreOfficeRuntimeSource = process.env.FINWORK_LIBREOFFICE_RUNTIME_DIR
  ? path.resolve(process.env.FINWORK_LIBREOFFICE_RUNTIME_DIR)
  : path.join(root, "vendor", "libreoffice-runtime");
const resourcesDir = path.join(root, "src-tauri", "resources");
const serverResourceDir = path.join(resourcesDir, "next-server");
const nodeResourceDir = path.join(resourcesDir, "node");
const placeholderDistDir = path.join(root, "src-tauri", "dist");
const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";

if (!existsSync(standaloneDir)) {
  console.warn(
    "prepare-tauri: [WARN] .next/standalone が見つかりません。先に `pnpm run build` を実行してください。\n" +
      "  pubkey 注入のみ完了 — Tauri resources の配置はスキップします。"
  );
  process.exit(0);
}

await rm(serverResourceDir, { recursive: true, force: true });
await mkdir(serverResourceDir, { recursive: true });
await cp(standaloneDir, serverResourceDir, {
  recursive: true,
  // 防止旧构建曾追踪进 standalone 的 Tauri resources 被再次嵌套复制。
  filter: (src) =>
    !src.includes(`${path.sep}src-tauri${path.sep}resources${path.sep}`),
});
await mkdir(path.join(serverResourceDir, ".next"), { recursive: true });
await cp(staticDir, path.join(serverResourceDir, ".next", "static"), { recursive: true });
// Next `output: standalone` 在 Windows 上 nft 文件追踪偶发不全(构建日志的 "Failed to copy traced
// files … ENOENT mkdir …\\C:\\Users\\…"):依赖被解析成绝对/特殊路径,拷进 .next/standalone 失败,
// 连带漏拷 .next/server/chunks/*.js → 运行期 require('./chunks/XXXX.js') MODULE_NOT_FOUND → 每个
// SSR/路由 500、前端只见"网络错误"。用完整的 .next/server 覆盖 standalone 的不全子集,确保 server
// chunk 齐全(同一次 build 的产物,叠加是超集,安全)。
await cp(path.join(nextDir, "server"), path.join(serverResourceDir, ".next", "server"), { recursive: true });
// layout.tsx 在 SSR 时读取 highlight.js 的明暗主题 CSS。Next 的 outputFileTracingIncludes
// 在 Windows 会受上面的绝对路径 trace 缺陷影响，CSS 可能没有进入 standalone，导致聊天页
// 运行时 ENOENT 并落入错误边界。这里把两个运行时文件显式复制，并由 resource smoke 校验。
// electron-builder ignores nested directories named node_modules even under
// extraResources, so keep runtime-only assets in an explicit product folder.
const highlightStylesDir = path.join(serverResourceDir, "runtime-assets", "highlight");
await mkdir(highlightStylesDir, { recursive: true });
for (const theme of ["atom-one-light.css", "atom-one-dark.css"]) {
  await cp(
    path.join(root, "node_modules", "highlight.js", "styles", theme),
    path.join(highlightStylesDir, theme),
  );
}
// SDK 原生 skill 的内置 plugin:生产态 getBundledPluginRoot() = next-server/agent-skills。
await cp(agentSkillsDir, path.join(serverResourceDir, "agent-skills"), { recursive: true });
// 系统提示静态前缀(A 段):生产态 getBundledSystemPromptPath() = next-server/lib/agent/SYSTEM_PROMPT.md。
// 已去内置常量兜底,SYSTEM_PROMPT.md 是唯一来源,必须打进资源,否则打包后无系统提示。
await mkdir(path.join(serverResourceDir, "lib", "agent"), { recursive: true });
await cp(path.join(root, "lib", "agent", "SYSTEM_PROMPT.md"), path.join(serverResourceDir, "lib", "agent", "SYSTEM_PROMPT.md"));
// 拷 workers/(finance_worker.py + 首启用的 python-runtime.tar.gz 等),排除 dev 的 .venv/__pycache__,避免把开发依赖打进包。
await cp(workersDir, path.join(serverResourceDir, "workers"), {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}.venv`) && !src.includes("__pycache__"),
});
// 安装器首启 pip 读 getProjectRoot()/requirements.txt;生产态 projectRoot = next-server,故把根 requirements 拷过去。
await cp(path.join(root, "requirements.txt"), path.join(serverResourceDir, "requirements.txt"));
// 同一路径下还必须有平台锁；缺失会让安装器静默退回未锁定 requirements.txt，丢失哈希校验与可复现性。
await cp(runtimeLockDir, path.join(serverResourceDir, "runtime-lock"), { recursive: true });

// Optional product-managed LibreOffice provider. Release CI supplies a platform-specific,
// license-audited runtime at FINWORK_LIBREOFFICE_RUNTIME_DIR; development builds may omit it.
if (existsSync(libreOfficeRuntimeSource)) {
  const target = path.join(serverResourceDir, "runtimes", "libreoffice");
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(libreOfficeRuntimeSource, target, { recursive: true });
  console.log("prepare-tauri: bundled managed LibreOffice provider.");
} else {
  console.warn("⚠ 未提供产品 LibreOffice runtime；打包后 Preflight 将尝试已安装/受管 Provider 并明确报告缺失。");
}

// C 方案:Python 运行时归档 workers/python-runtime.tar.gz 随包,首启解压即用(getBundledPythonArchive),免 GitHub 下载。
// CI release 的「Bundle Python runtime archive」步骤按平台拉好;本地打包没有时,首启回退联网下载(python-installer 兜底)。
if (!existsSync(path.join(workersDir, "python-runtime.tar.gz")) && !existsSync(path.join(workersDir, "python-runtime"))) {
  console.warn(
    "⚠ 未发现 workers/python-runtime.tar.gz —— 打包产物不含内嵌 Python,首启将回退联网下载(GitHub,可能慢/失败)。\n" +
    "  本地打包如需内嵌,把对应平台的 python-build-standalone install_only 归档放到 workers/python-runtime.tar.gz。"
  );
}

// 打包 ripgrep 给 Pi grep 使用；知识检索本身走 SQLite FTS5/BM25。
const rgExe = process.platform === "win32" ? "rg.exe" : "rg";
const binResourceDir = path.join(serverResourceDir, "bin");
await mkdir(binResourceDir, { recursive: true });
if (existsSync(rgPath)) {
  await cp(rgPath, path.join(binResourceDir, rgExe));
} else {
  console.warn(`⚠ 未找到 ripgrep 二进制(${rgPath});Pi grep 在产物中将不可用。`);
}

// Windows 11 dynamic-code sandbox. Keep the final package lean: the npm
// package contains several architectures/backends, but Finwork only needs the
// current-architecture wxc-exec process-container runner and its MIT license.
if (process.platform === "win32") {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`prepare-tauri: MXC 不支持 Windows ${process.arch}`);
  }
  const mxcPackageDir = path.join(root, "node_modules", "@microsoft", "mxc-sdk");
  const mxcSource = path.join(mxcPackageDir, "bin", process.arch, "wxc-exec.exe");
  const mxcTargetDir = path.join(binResourceDir, "mxc");
  if (!existsSync(mxcSource)) {
    throw new Error("prepare-tauri: @microsoft/mxc-sdk 缺少当前架构的 wxc-exec.exe");
  }
  await mkdir(mxcTargetDir, { recursive: true });
  await cp(mxcSource, path.join(mxcTargetDir, "wxc-exec.exe"));
  await cp(path.join(mxcPackageDir, "LICENSE.md"), path.join(mxcTargetDir, "LICENSE.Microsoft-MXC.md"));
}

await rm(nodeResourceDir, { recursive: true, force: true });
await mkdir(nodeResourceDir, { recursive: true });
await cp(process.execPath, path.join(nodeResourceDir, nodeBinaryName));

// 校验内嵌 Node 能加载 node:sqlite —— 用与运行期 `node server.js`(lib.rs,无 --experimental-sqlite)
// 完全一致的方式探测刚拷进去的二进制。打进过旧的 Node(node:sqlite 仍需 flag 或缺失)会让用户机上每个
// 碰 DB 的路由 500,而零依赖的 /api/health 仍 200 → UI 出来但一点就「网络错误」。这里在打包期直接拦掉,
// 不靠硬编码版本号(经验式探测,避免 node:sqlite 解禁版本边界判断错)。
const bundledNode = path.join(nodeResourceDir, nodeBinaryName);
const sqliteProbe = spawnSync(
  bundledNode,
  ["-e", "new (require('node:sqlite').DatabaseSync)(':memory:').close()"],
  { encoding: "utf-8" }
);
if (sqliteProbe.status !== 0) {
  const detail = (sqliteProbe.stderr || sqliteProbe.stdout || sqliteProbe.error?.message || "").trim().slice(0, 500);
  throw new Error(
    `prepare-tauri: 内嵌 Node(${process.version})无法加载 node:sqlite —— 该版本不被支持。\n` +
      "  运行期用裸 `node server.js`(无 --experimental-sqlite),需要 node:sqlite 已稳定可用的 Node 版本;\n" +
      "  否则打包产物会出现「UI 能开但一点就网络错误」。请用更新的 Node 重新打包。\n" +
      `  探测输出:${detail}`
  );
}
console.log(`prepare-tauri: 内嵌 Node ${process.version} 已通过 node:sqlite 可用性校验。`);

await rm(placeholderDistDir, { recursive: true, force: true });
await mkdir(placeholderDistDir, { recursive: true });
await writeFile(
  path.join(placeholderDistDir, "index.html"),
  [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Finance Agent1</title>",
    "</head>",
    "<body>",
    "<main>Finance Agent desktop server is starting...</main>",
    "</body>",
    "</html>"
  ].join("\n"),
  "utf-8"
);

console.log(`Prepared Tauri resources at ${path.relative(root, serverResourceDir)}`);
