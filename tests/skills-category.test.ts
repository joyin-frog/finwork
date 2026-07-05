import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { filterByCategory } from "../app/skills/file-tree.ts";

export const skillsCategoryTestPromise = (async () => {
  // ① 纯逻辑
  const mk = (name: string, source: "bundled" | "user", category: string) => ({ name, source, category });
  const list = [mk("xlsx", "bundled", "file-tool"), mk("payroll-calc", "bundled", "finance"), mk("mine", "user", "")];
  assert.deepEqual(filterByCategory(list, "all").map((s) => s.name), ["xlsx", "payroll-calc", "mine"]);
  assert.deepEqual(filterByCategory(list, "file-tool").map((s) => s.name), ["xlsx"]);
  assert.deepEqual(filterByCategory(list, "finance").map((s) => s.name), ["payroll-calc"]);
  assert.deepEqual(filterByCategory(list, "user").map((s) => s.name), ["mine"]);

  // ② 数据:12 个内置 SKILL.md 的 category 正确
  const FILE_TOOL = ["xlsx", "pdf", "docx", "pptx"];
  const FINANCE = [
    "payroll-calc",
    "reimbursement-check",
    "kingdee-draft",
    "finance-analysis",
    "business-analysis",
    "contract-extract",
    "tax-incentive",
    "rnd-deduction-check",
  ];
  const root = process.cwd();
  const readFm = (n: string) => readFileSync(path.join(root, "agent-skills/skills", n, "SKILL.md"), "utf8");
  for (const n of FILE_TOOL) assert.match(readFm(n), /^category:\s*file-tool\s*$/m, `${n} 应为 file-tool`);
  for (const n of FINANCE) assert.match(readFm(n), /^category:\s*finance\s*$/m, `${n} 应为 finance`);

  console.log("skills-category checks passed ✓");
})();
