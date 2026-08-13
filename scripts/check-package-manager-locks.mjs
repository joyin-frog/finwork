#!/usr/bin/env node

/**
 * pnpm 是项目的默认包管理器，但仓库同时保留 package-lock.json 供 npm 使用。
 * 这里校验两个锁文件的根依赖声明都与 package.json 一致，防止兼容锁静默漂移。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readJson("package.json");
const npmLock = readJson("package-lock.json");
const pnpmLockText = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
const sections = ["dependencies", "devDependencies", "optionalDependencies"];
const failures = [];

if (!String(manifest.packageManager ?? "").startsWith("pnpm@")) {
  failures.push("package.json 必须通过 packageManager 声明默认 pnpm 版本");
}

const npmRoot = npmLock.packages?.[""] ?? {};
const pnpmRoot = parsePnpmRootImporter(pnpmLockText);

for (const section of sections) {
  compareSection(`package-lock.json#packages[\"\"].${section}`, manifest[section], npmRoot[section]);
  compareSection(`pnpm-lock.yaml#importers[\".\"].${section}`, manifest[section], pnpmRoot[section]);
}

if (failures.length > 0) {
  console.error("包管理器锁文件不一致：");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("更新依赖后请同时运行 pnpm install 和 npm install --package-lock-only。 ");
  process.exit(1);
}

console.log(`包管理器校验通过：${manifest.packageManager} 为默认，npm 锁文件保持兼容。`);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function compareSection(label, expected = {}, actual = {}) {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  for (const key of new Set([...expectedKeys, ...actualKeys])) {
    if (!(key in expected)) failures.push(`${label} 多出 ${key}`);
    else if (!(key in actual)) failures.push(`${label} 缺少 ${key}`);
    else if (String(actual[key]) !== String(expected[key])) {
      failures.push(`${label} 的 ${key} 应为 ${expected[key]}，实际为 ${actual[key]}`);
    }
  }
}

function parsePnpmRootImporter(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  let inRootImporter = false;
  let section = null;
  let dependency = null;

  for (const line of lines) {
    if (!inRootImporter) {
      if (line === "  .:") inRootImporter = true;
      continue;
    }
    if (line && !line.startsWith("    ")) break;

    const sectionMatch = line.match(/^    (dependencies|devDependencies|optionalDependencies):\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      result[section] = {};
      dependency = null;
      continue;
    }
    const dependencyMatch = line.match(/^      (.+):\s*$/);
    if (dependencyMatch && section) {
      dependency = unquoteYaml(dependencyMatch[1]);
      continue;
    }
    const specifierMatch = line.match(/^        specifier:\s*(.+)\s*$/);
    if (specifierMatch && section && dependency) {
      result[section][dependency] = unquoteYaml(specifierMatch[1]);
    }
  }
  return result;
}

function unquoteYaml(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
