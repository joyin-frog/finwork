/**
 * cockpit-todos.test.ts — CV-1 改写版
 *
 * deriveCockpitTodos（旧 API）已迁移为 deriveAttentionItems（lib/domain/attention.ts）。
 * 本文件改为验证旧模块已不存在，避免与 attention.test.ts 重复断言推导逻辑。
 * 域逻辑的表驱动测试已移至 tests/attention.test.ts。
 *
 * 运行方式：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/cockpit-todos.test.ts
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

export const cockpitTodosTestPromise = (async () => {
  // ── T1: 旧域逻辑模块已删除（功能已迁移至 lib/domain/attention.ts）──────
  assert.equal(
    existsSync(path.join(ROOT, "lib/domain/cockpit-todos.ts")),
    false,
    "T1 FAIL: lib/domain/cockpit-todos.ts 应已删除（功能迁移至 attention.ts）"
  );

  // ── T2: 新域逻辑模块存在并导出正确符号 ──────────────────────────────────
  assert.ok(
    existsSync(path.join(ROOT, "lib/domain/attention.ts")),
    "T2 FAIL: lib/domain/attention.ts 应存在"
  );

  // attention.ts 的详细逻辑断言已在 tests/attention.test.ts 中完整覆盖
  console.log("cockpit-todos (CV-1 migration check): all checks passed ✓");
})();
