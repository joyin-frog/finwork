#!/usr/bin/env node
/**
 * git worktree 没有自己的 node_modules(依赖都装在主仓库里)。
 * dev/build 前自动跑一遍:worktree 里缺 node_modules 就软链到主仓库那份,不用每次手动问。
 * 不是 worktree、或主仓库也没装依赖时什么都不做。
 *
 * 只判「node_modules 存在」是不够的(2026-07-30 实测):worktree 与主检出可以在不同分支,
 * 各自的 package.json 依赖不同。改依赖的分支(如 Claude SDK → Pi 迁移)拿到主检出那棵树后,
 * 报错是 `TS2307 Cannot find module '@earendil-works/...'`——长得像代码错误,实际是环境错误,
 * 排查成本极高。因此软链前后都要校验树是否满足本 worktree 的 package.json;不满足就
 * 显式失败并给出修复命令,绝不静默交出一棵错的树。
 */

import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const cwd = process.cwd();
const nodeModulesPath = path.join(cwd, "node_modules");

/** 直接依赖会被 pnpm 链接到 node_modules 顶层；scoped 名字要按 / 拆开再拼，兼容 Windows。 */
function installedManifest(nodeModulesDir, name) {
  const manifest = path.join(nodeModulesDir, ...name.split("/"), "package.json");
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, "utf-8"));
  } catch {
    return null;
  }
}

function readRequiredDeps(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"));
  // optionalDependencies 允许缺失(平台相关),不纳入校验。
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

/**
 * 校验一棵 node_modules 是否满足本 worktree 的 package.json。
 * 缺包一定报；版本只在「精确锁定」(如 pi 三包的 0.82.1)时报漂移——范围声明交给 pnpm 判定。
 */
function findProblems(nodeModulesDir, required) {
  const missing = [];
  const drifted = [];
  for (const [name, spec] of Object.entries(required)) {
    const installed = installedManifest(nodeModulesDir, name);
    if (!installed) {
      missing.push(name);
      continue;
    }
    if (/^\d+\.\d+\.\d+$/.test(spec) && installed.version !== spec) {
      drifted.push(`${name}@${installed.version}(需 ${spec})`);
    }
  }
  return { missing, drifted };
}

function fail(nodeModulesDir, { missing, drifted }, linked) {
  const where = linked ? `软链指向的 ${nodeModulesDir}` : nodeModulesDir;
  console.error(`[link-worktree-node-modules] ${where} 不满足本 worktree 的 package.json：`);
  if (missing.length) {
    console.error(`  缺少 ${missing.length} 个依赖：${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);
  }
  if (drifted.length) {
    console.error(`  版本漂移：${drifted.slice(0, 8).join(", ")}${drifted.length > 8 ? " …" : ""}`);
  }
  console.error("");
  console.error("  本 worktree 与主检出的依赖不同(常见于改了 package.json 的分支)。");
  console.error("  修复：在本 worktree 里做一次独立安装——");
  console.error("    rm node_modules   # 只删软链，不动主检出那棵树");
  console.error("    pnpm install");
  process.exit(1);
}

const required = readRequiredDeps(cwd);

// 已有 node_modules(真实目录，或指向有效目标的软链):不重建，但必须校验它能用。
if (existsSync(nodeModulesPath)) {
  const resolved = realpathSync(nodeModulesPath);
  const problems = findProblems(resolved, required);
  if (problems.missing.length || problems.drifted.length) {
    fail(resolved, problems, resolved !== nodeModulesPath);
  }
  process.exit(0);
}

let commonDir;
try {
  commonDir = execSync("git rev-parse --git-common-dir", { cwd, encoding: "utf-8" }).trim();
} catch {
  process.exit(0); // 不在 git 仓库里
}

const gitDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
const mainRoot = path.dirname(gitDir); // .git 的上一级就是主仓库根目录
if (path.resolve(mainRoot) === path.resolve(cwd)) process.exit(0); // 本来就是主仓库,不是 worktree

const mainNodeModules = path.join(mainRoot, "node_modules");
if (!existsSync(mainNodeModules)) process.exit(0); // 主仓库也没装,帮不上忙

// 主仓库那棵树满足不了本分支时不要软链:交出一棵错的树比不软链更难排查。
const problems = findProblems(mainNodeModules, required);
if (problems.missing.length || problems.drifted.length) {
  fail(mainNodeModules, problems, false);
}

// node_modules 路径本身可能是失效的软链(existsSync 对失效软链返回 false),先清掉再重建。
try {
  const stat = lstatSync(nodeModulesPath);
  if (stat.isSymbolicLink()) unlinkSync(nodeModulesPath);
  else process.exit(0); // 是个真实文件/目录但读不出来,不确定情况下不动它
} catch {
  // 完全不存在,直接建
}

symlinkSync(path.relative(cwd, mainNodeModules), nodeModulesPath, "dir");
console.log(`[link-worktree-node-modules] 已软链接 node_modules -> ${mainNodeModules}`);
