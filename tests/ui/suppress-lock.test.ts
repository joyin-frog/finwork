/**
 * suppress-lock.test.ts — WP-E 第 4 条
 *
 * 统计 app/**\/\*.tsx 中 `eslint-disable-next-line no-restricted-syntax` 的出现次数，
 * 断言 <= 锁定上限（只准降不准升）。
 *
 * 锁定值 109 = WP-E 完成时的实际计数（checklist-card.tsx 那条 suppress 因同行
 * 含 border 存量触发而必须保留，见下方常量注释）。
 *
 * 护栏意图：任何新增 suppress 都会让测试变红，迫使作者有意识地调高上限并解释原因。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 只准降不准升——如实际数低于此值，将上限同步下调。
// 109 = WP-E 完成时实际计数：checklist-card.tsx 那条 suppress 仍需保留（
// 该行同时含 border 存量，仅 rounded-[var( 部分因正则修复豁免，suppress 本身未消除）。
const SUPPRESS_LIMIT = 109;

export const suppressLockTestPromise = (async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, "../..");
  const appDir = path.join(repoRoot, "app");

  // 递归收集 app/**/*.tsx（Node 18+ fs.readdirSync recursive）
  const allEntries = fs.readdirSync(appDir, { recursive: true, encoding: "utf8" });
  const tsxFiles = allEntries
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => path.join(appDir, f));

  assert.ok(tsxFiles.length > 0, "suppress-lock: 未找到任何 app/**/*.tsx 文件");

  let count = 0;
  for (const filePath of tsxFiles) {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.includes("eslint-disable-next-line no-restricted-syntax")) {
        count++;
      }
    }
  }

  assert.ok(
    count <= SUPPRESS_LIMIT,
    `suppress-lock FAIL: 当前 suppress 数 ${count} 超过上限 ${SUPPRESS_LIMIT}。` +
    `请先收敛现有 no-restricted-syntax suppress，或有充分理由时才调高上限（附注释说明原因）。`
  );

  console.log(`suppress-lock: ${count} suppress(es) in app/**/*.tsx — within limit ${SUPPRESS_LIMIT} ✓`);
})();
