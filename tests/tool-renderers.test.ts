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
    getToolSummary("mcp__finance_worker__calculate_payroll_batch", { year: 2026, month: 6, employees: [{}, {}, {}] }),
    "计算 2026年6月 工资(3 人)"
  );
  assert.equal(getToolSummary("mcp__finance_worker__confirm_payroll_period", { year: 2026, month: 6 }), "确认 2026年6月 工资生效");
  assert.equal(getToolSummary("mcp__finance_worker__check_reimbursement_batch", { items: [{}, {}] }), "核对报销单(2 条)");
  assert.equal(getToolSummary("mcp__finance_worker__search_knowledge", { query: "差旅标准" }), "检索知识库「差旅标准」");
  assert.ok(getToolSummary("mcp__finance_worker__tax_calculator", { type: "vat", amount: 11300 }).includes("增值税"));
  assert.ok(getToolSummary("mcp__kingdee_worker__export_kingdee_draft", { period: "2026-06" }).includes("2026-06"));

  // 错误态沿用统一文案
  assert.ok(getToolSummary("mcp__finance_worker__calculate_payroll_batch", {}, "失败原因\n详情", true).startsWith("错误："));

  // ── run_python 摘要要看得懂在干嘛,而不是死板的"执行成功" ──
  // 生成单个文件 → 显示文件名
  assert.equal(
    getToolSummary("mcp__finance_worker__run_python", { code: "..." }, "生成的文件:\n- 报表.xlsx (application/x, 1234 bytes)"),
    "生成文件 报表.xlsx"
  );
  // 未生成文件、且看不出具体目的(变量路径、非具名文件)→ 回落「执行 Python」(UI 兜底「运行代码」),不硬露原始代码
  assert.equal(
    getToolSummary(
      "mcp__finance_worker__run_python",
      { code: "import openpyxl\n# 读取\nwb = openpyxl.load_workbook(path)" },
      "Python 代码执行成功，未生成新文件。"
    ),
    "执行 Python"
  );

  // ── 修复 4: 报错摘要变人话 ──
  // exit code 127 → 命令未找到
  assert.equal(
    getToolSummary("Bash", { command: "python x.py" }, "/bin/sh: python: command not found\nExit code 127", true),
    "错误：命令未找到"
  );
  // Python 异常行优先(exit code 1 不在 byCode 表,取末行异常 ModuleNotFoundError)
  assert.ok(
    getToolSummary(
      "mcp__finance__run_python",
      { code: "..." },
      "Traceback...\nModuleNotFoundError: No module named 'office'\nPython 执行出错 (exit code 1)",
      true
    ).startsWith("错误：ModuleNotFoundError"),
    "修复4 FAIL: 应取末行异常行作为错误摘要"
  );
  // 无可识别信息 → 执行失败
  assert.equal(
    getToolSummary("Bash", { command: "x" }, "something went wrong", true),
    "错误：执行失败"
  );

  // ── 修复 5B: 收紧 pythonCodeIntent ──
  // 引用文件名 → 处理《X》
  assert.equal(
    getToolSummary("mcp__finance_worker__run_python", { code: "path='/x/2030年预测表 1.xlsx'\nwb=openpyxl.load_workbook(path)" }),
    "运行 Python:处理《2030年预测表 1》"
  );
  // 无文件、无动作(纯赋值)→ 回落「执行 Python」
  assert.equal(
    getToolSummary("mcp__finance_worker__run_python", { code: "x = 1\ny = 2" }),
    "执行 Python"
  );
  // 生成文件类不受影响
  assert.ok(
    getToolSummary("mcp__finance_worker__run_python", { code: "..." }, "生成的文件:\n- 报表.xlsx (application/x, 1234 bytes)").includes("生成文件"),
    "修复5B FAIL: 生成文件路径应仍走原逻辑"
  );

  // 注:roleMode 不再驱动 UI(过程展示对所有人一致),原 AC9(daily/tech 显示策略)已移除。

  console.log("tool-renderers: all checks passed ✓");
}

main();
