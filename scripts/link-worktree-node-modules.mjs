#!/usr/bin/env node
/**
 * git worktree 没有自己的 node_modules(依赖都装在主仓库里)。
 * dev/build 前自动跑一遍:worktree 里缺 node_modules 就软链到主仓库那份,不用每次手动问。
 * 不是 worktree、或主仓库也没装依赖时什么都不做。
 */

import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const cwd = process.cwd();
const nodeModulesPath = path.join(cwd, "node_modules");

if (existsSync(nodeModulesPath)) process.exit(0); // 已有可用的 node_modules(含指向有效目标的软链)

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
