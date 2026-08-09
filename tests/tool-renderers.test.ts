import assert from "node:assert/strict";
import { getToolSummary, hasToolSummary, formatToolLabel } from "../lib/agent/tools/renderers.ts";
import { TOOL_REGISTRY } from "../lib/agent/tools/registry.ts";

function main() {
  // ── AC7: registry 中全部财务工具必须有中文摘要,不落英文兜底 ──
  const financeTools = TOOL_REGISTRY.filter((t) => t.category === "finance");
  assert.ok(financeTools.length >= 10, "AC7 FAIL: registry 财务工具数量异常");
  for (const tool of financeTools) {
    assert.ok(hasToolSummary(tool.name), `AC7 FAIL: ${tool.name} 缺少摘要条目`);
    const summary = getToolSummary(tool.name, {});
    assert.notEqual(summary, formatToolLabel(tool.name), `AC7 FAIL: ${tool.name} 落入英文兜底`);
    assert.ok(/[一-鿿]/.test(summary), `AC7 FAIL: ${tool.name} 摘要应为中文,实际:${summary}`);
  }

  // 摘要应携带业务上下文(抽查关键工具)
  assert.equal(
    getToolSummary("calculate_payroll_batch", { year: 2026, month: 6, employees: [{}, {}, {}] }),
    "计算 2026年6月 工资(3 人)"
  );
  assert.equal(getToolSummary("confirm_payroll_period", { year: 2026, month: 6 }), "确认 2026年6月 工资生效");
  assert.equal(getToolSummary("check_reimbursement_batch", { items: [{}, {}] }), "核对报销单(2 条)");
  assert.equal(getToolSummary("search_knowledge", { query: "差旅标准" }), "检索知识库：差旅标准");
  assert.ok(getToolSummary("tax_calculator", { type: "vat", amount: 11300 }).includes("增值税"));
  assert.ok(getToolSummary("export_kingdee_draft", { period: "2026-06" }).includes("2026-06"));

  // 错误态沿用统一文案
  assert.ok(getToolSummary("calculate_payroll_batch", {}, "失败原因\n详情", true).startsWith("错误："));

  assert.equal(getToolSummary("analyze_tabular", { rows: [{}, {}], groupBy: ["department"] }), "整理表格数据（按 department 分组）：2 行");
  assert.equal(getToolSummary("Bash", { command: "mkdir -p /tmp/report && ls /tmp/report" }), "准备输出目录并查看文件");
  assert.equal(getToolSummary("Bash", "python3 -c 'print(1)'"), "执行 Python 脚本");
  // 注:roleMode 不再驱动 UI(过程展示对所有人一致),原 AC9(daily/tech 显示策略)已移除。

  console.log("tool-renderers: all checks passed ✓");
}

main();
