#!/usr/bin/env node

/**
 * 用启动当前命令的包管理器继续运行组合 script。
 * pnpm 是项目默认；通过 npm run 启动时仍全程使用 npm。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const separator = process.argv.indexOf("--", 2);
const scriptNames = process.argv.slice(2, separator === -1 ? undefined : separator);
const forwardedArgs = separator === -1 ? [] : process.argv.slice(separator + 1);

if (scriptNames.length === 0) {
  console.error("run-package-script: 至少需要一个 package script 名称");
  process.exit(2);
}
if (forwardedArgs.length > 0 && scriptNames.length !== 1) {
  console.error("run-package-script: 只有运行单个 script 时才能传递 -- 后的参数");
  process.exit(2);
}

function currentRunner() {
  const execPath = process.env.npm_execpath;
  if (execPath && existsSync(execPath)) {
    const isNodeCli = /\.(?:c?js|mjs)$/i.test(execPath);
    return isNodeCli
      ? { command: process.execPath, prefix: [execPath] }
      : { command: execPath, prefix: [] };
  }

  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const declared = String(manifest.packageManager ?? "pnpm").split("@")[0] || "pnpm";
  return { command: declared, prefix: [] };
}

const runner = currentRunner();
for (const scriptName of scriptNames) {
  const args = [...runner.prefix, "run", scriptName];
  if (forwardedArgs.length > 0) args.push("--", ...forwardedArgs);
  const result = spawnSync(runner.command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`run-package-script: 无法启动 ${runner.command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
