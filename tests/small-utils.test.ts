import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { cn } from "../lib/utils.ts";
import { INDUSTRY_OPTIONS } from "../lib/profile/industry-options.ts";
import { getRgPath } from "../lib/knowledge/rg-binary.ts";
import { openFinanceDatabase, initializeFinanceDatabase } from "../lib/db/sqlite.ts";
import { initializeSchema, addColumnIfMissing } from "../lib/db/schema.ts";

export const smallUtilsTestPromise = (async () => {
  // ════ cn():className 合并 ════════════════════════════════════════════
  // 同组冲突取最后一个
  assert.equal(cn("p-2", "p-4"), "p-4", "同属性冲突应取最后一个");
  // clsx 条件:false 段被丢弃
  assert.equal(cn("a", false && "b", "c"), "a c", "假值条件应被忽略");
  // 自定义字阶组:不同字阶互斥,取最后一个
  assert.equal(cn("text-body", "text-title"), "text-title", "不同字阶应取最后一个");
  // 关键回归(见 utils.ts 注释):字阶与文字颜色不应互相挤掉
  {
    const out = cn("text-title", "text-red-500");
    assert.ok(out.includes("text-title"), "字阶 text-title 不应被颜色类挤掉");
    assert.ok(out.includes("text-red-500"), "颜色类应保留");
  }

  // ════ INDUSTRY_OPTIONS:行业预设静态表 ═══════════════════════════════
  assert.ok(Array.isArray(INDUSTRY_OPTIONS) && INDUSTRY_OPTIONS.length > 0, "行业预设应非空");
  assert.ok(INDUSTRY_OPTIONS.every((s) => typeof s === "string" && s.length > 0), "每项应为非空字符串");
  assert.equal(new Set(INDUSTRY_OPTIONS).size, INDUSTRY_OPTIONS.length, "行业预设不应有重复");

  // ════ getRgPath():ripgrep 二进制解析优先级 ══════════════════════════
  const origRg = process.env.FINANCE_AGENT_RG_PATH;
  const origRoot = process.env.FINANCE_AGENT_PROJECT_ROOT;
  const rgDir = mkdtempSync(path.join(tmpdir(), "finance-agent-rg-test-"));
  try {
    // 1) env 覆盖最高优先
    process.env.FINANCE_AGENT_RG_PATH = "/custom/rg";
    assert.equal(getRgPath(), "/custom/rg", "FINANCE_AGENT_RG_PATH 应最高优先");

    // 2) 无 env、有打包 bin/<exe> → 用打包二进制
    delete process.env.FINANCE_AGENT_RG_PATH;
    process.env.FINANCE_AGENT_PROJECT_ROOT = rgDir;
    const exe = process.platform === "win32" ? "rg.exe" : "rg";
    mkdirSync(path.join(rgDir, "bin"), { recursive: true });
    const bundled = path.join(rgDir, "bin", exe);
    writeFileSync(bundled, "#!/bin/sh\n");
    assert.equal(getRgPath(), bundled, "存在打包 bin/<exe> 时应优先用它");

    // 3) 无 env、无打包 → 回落 @vscode/ripgrep 预编译路径(存在的真实文件)
    process.env.FINANCE_AGENT_PROJECT_ROOT = path.join(rgDir, "empty");
    const fallback = getRgPath();
    assert.ok(fallback.includes("ripgrep"), "回落路径应来自 @vscode/ripgrep");
  } finally {
    if (origRg === undefined) delete process.env.FINANCE_AGENT_RG_PATH;
    else process.env.FINANCE_AGENT_RG_PATH = origRg;
    if (origRoot === undefined) delete process.env.FINANCE_AGENT_PROJECT_ROOT;
    else process.env.FINANCE_AGENT_PROJECT_ROOT = origRoot;
    rmSync(rgDir, { recursive: true, force: true });
  }

  // ════ schema:initializeSchema 建表 + 幂等;addColumnIfMissing ════════
  {
    const db = openFinanceDatabase(":memory:");
    initializeSchema(db);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name)
    );
    for (const t of ["audit_logs", "tool_executions", "business_metrics", "chat_conversations", "app_settings", "app_errors", "payroll_records"]) {
      assert.ok(tables.has(t), `schema 应建表 ${t}`);
    }
    // 幂等:二次 initializeSchema 不应抛错(全是 IF NOT EXISTS)
    assert.doesNotThrow(() => initializeSchema(db), "initializeSchema 应可重复执行");

    // addColumnIfMissing:补列后存在,二次调用为 no-op
    const cols = () =>
      (db.prepare("PRAGMA table_info(app_settings)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols().includes("test_extra_col"), "前置:列不应已存在");
    addColumnIfMissing(db, "app_settings", "test_extra_col", "TEXT");
    assert.ok(cols().includes("test_extra_col"), "addColumnIfMissing 应补上缺失列");
    assert.doesNotThrow(() => addColumnIfMissing(db, "app_settings", "test_extra_col", "TEXT"), "已存在列时应为 no-op");
    db.close();
  }

  // initializeFinanceDatabase(:memory:) 端到端也应可用(schema+migrations)
  {
    const db = initializeFinanceDatabase(openFinanceDatabase(":memory:"));
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.ok(v.user_version >= 0, "迁移后 user_version 应已设置");
    db.close();
  }

  console.log("small-utils: all checks passed ✓");
})();
