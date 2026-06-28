import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

await injectUpdaterPubkey();

// ──────────────────────────────────────────────────────────────────────────────
// § B  Next.js 产物打包到 Tauri resources
//   需要先跑 `npm run build` 生成 .next/standalone。
//   若产物缺失则打印告警并提前退出(dev 或仅注入 pubkey 时不崩)。
// ──────────────────────────────────────────────────────────────────────────────
const nextDir = path.join(root, ".next");
const standaloneDir = path.join(nextDir, "standalone");
const staticDir = path.join(nextDir, "static");
const agentSkillsDir = path.join(root, "agent-skills");
const workersDir = path.join(root, "workers");
const resourcesDir = path.join(root, "src-tauri", "resources");
const serverResourceDir = path.join(resourcesDir, "next-server");
const nodeResourceDir = path.join(resourcesDir, "node");
const placeholderDistDir = path.join(root, "src-tauri", "dist");
const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";

if (!existsSync(standaloneDir)) {
  console.warn(
    "prepare-tauri: [WARN] .next/standalone が見つかりません。先に `npm run build` を実行してください。\n" +
      "  pubkey 注入のみ完了 — Tauri resources の配置はスキップします。"
  );
  process.exit(0);
}

await rm(serverResourceDir, { recursive: true, force: true });
await mkdir(serverResourceDir, { recursive: true });
await cp(standaloneDir, serverResourceDir, { recursive: true });
await mkdir(path.join(serverResourceDir, ".next"), { recursive: true });
await cp(staticDir, path.join(serverResourceDir, ".next", "static"), { recursive: true });
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

// C 方案:Python 运行时归档 workers/python-runtime.tar.gz 随包,首启解压即用(getBundledPythonArchive),免 GitHub 下载。
// CI release 的「Bundle Python runtime archive」步骤按平台拉好;本地打包没有时,首启回退联网下载(python-installer 兜底)。
if (!existsSync(path.join(workersDir, "python-runtime.tar.gz")) && !existsSync(path.join(workersDir, "python-runtime"))) {
  console.warn(
    "⚠ 未发现 workers/python-runtime.tar.gz —— 打包产物不含内嵌 Python,首启将回退联网下载(GitHub,可能慢/失败)。\n" +
    "  本地打包如需内嵌,把对应平台的 python-build-standalone install_only 归档放到 workers/python-runtime.tar.gz。"
  );
}

// 打包 ripgrep 二进制到 bin/(getRgPath() 生产态优先解析 projectRoot/bin/rg);跨平台、不依赖系统安装。
const rgExe = process.platform === "win32" ? "rg.exe" : "rg";
const binResourceDir = path.join(serverResourceDir, "bin");
await mkdir(binResourceDir, { recursive: true });
if (existsSync(rgPath)) {
  await cp(rgPath, path.join(binResourceDir, rgExe));
} else {
  console.warn(`⚠ 未找到 ripgrep 二进制(${rgPath});知识库搜索在产物中将不可用。`);
}

await rm(nodeResourceDir, { recursive: true, force: true });
await mkdir(nodeResourceDir, { recursive: true });
await cp(process.execPath, path.join(nodeResourceDir, nodeBinaryName));

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
