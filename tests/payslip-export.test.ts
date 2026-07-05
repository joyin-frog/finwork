import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// 工资条导出测试:
//   ① 纯函数（confirmed 选择/draft 跳过/合计/精度/空）
//   ② Python 脚本（execFileSync 调 export-payslips-xlsx、openpyxl 读回校验）
//   ③ 源码契约（工具只读库、无 PII payload、redact、注册 medium、角色白名单、Python 分发存在）

import { getPythonPath } from "../lib/runtime/paths";
const PYTHON_PATH = getPythonPath();
const PROJECT_ROOT = path.resolve(new URL("../", import.meta.url).pathname);

// ─────────────────────────────────────────────
// ① 纯函数测试
// ─────────────────────────────────────────────
import { buildPayslipExport } from "../lib/domain/payslip-export";
import type { StoredPayrollRecord } from "../lib/db/finance-store";

function makeRecord(
  employeeName: string,
  status: "draft" | "confirmed",
  overrides: Partial<StoredPayrollRecord> = {}
): StoredPayrollRecord {
  return {
    id: 1,
    employeeName,
    year: 2026,
    month: 6,
    grossPay: 10000,
    socialInsurance: 1000,
    housingFund: 500,
    specialDeduction: 200,
    monthsEmployed: 6,
    grossCum: 60000,
    socialCum: 6000,
    fundCum: 3000,
    specialCum: 1200,
    taxableIncomeCum: 49800,
    taxDueCum: 1000,
    taxCurrent: 300,
    taxWithheldCum: 1000,
    netPay: 8000,
    taxConfigVersion: "2024",
    status,
    createdAt: "2026-06-01T00:00:00Z",
    confirmedAt: status === "confirmed" ? "2026-06-05T00:00:00Z" : null,
    ...overrides,
  };
}

export const payslipExportTestPromise = (async () => {
  // ── A1: 混合 draft/confirmed → 只导 confirmed，draft 进 skipped ──
  {
    const records = [
      makeRecord("张三", "confirmed"),
      makeRecord("李四", "draft"),
      makeRecord("王五", "confirmed", { grossPay: 12000, socialInsurance: 1200, housingFund: 600, specialDeduction: 300, taxCurrent: 450, netPay: 9450 }),
    ];
    const ex = buildPayslipExport(records, 2026, 6);
    assert.equal(ex.rows.length, 2, "A1 FAIL: 应只有 2 条 confirmed");
    assert.ok(ex.rows.every((r) => ["张三", "王五"].includes(r.employeeName)), "A1 FAIL: confirmed 员工名不对");
    assert.deepEqual(ex.skippedDrafts, ["李四"], "A1 FAIL: 李四应在 skippedDrafts");
    assert.ok(ex.hasConfirmed, "A1 FAIL: hasConfirmed 应为 true");
    console.log("payslip-export A1: 混合 draft/confirmed 过滤 ✓");
  }

  // ── A2: 合计正确（整数分累加口径）──
  {
    const records = [
      makeRecord("张三", "confirmed", { grossPay: 10000.1, netPay: 8000.1, taxCurrent: 300, socialInsurance: 1000, housingFund: 500, specialDeduction: 200 }),
      makeRecord("李四", "confirmed", { grossPay: 10000.1, netPay: 8000.1, taxCurrent: 300, socialInsurance: 1000, housingFund: 500, specialDeduction: 200 }),
    ];
    const ex = buildPayslipExport(records, 2026, 6);
    // 2 * 10000.1 = 20000.2，直接 JS 浮点加法可能有误差
    assert.equal(ex.totals.grossPay, 20000.2, "A2 FAIL: grossPay 合计应为 20000.20");
    assert.equal(ex.totals.netPay, 16000.2, "A2 FAIL: netPay 合计应为 16000.20");
    assert.equal(ex.numericWarnings.length, 0, "A2 FAIL: 应无勾稽告警");
    console.log("payslip-export A2: 合计精度（整数分口径）✓");
  }

  // ── A3: .1 精度边界（3 人 × 0.1 元 = 0.3，浮点加法会出问题但分累加不会）──
  {
    const records = [1, 2, 3].map((i) =>
      makeRecord(`员工${i}`, "confirmed", { grossPay: 0.1, socialInsurance: 0, housingFund: 0, specialDeduction: 0, taxCurrent: 0, netPay: 0.1 })
    );
    const ex = buildPayslipExport(records, 2026, 6);
    // 0.1 + 0.1 + 0.1 = 0.3（浮点直接加会得 0.30000000000000004）
    assert.equal(ex.totals.grossPay, 0.3, "A3 FAIL: 0.1*3 应恰好等于 0.30（整数分累加）");
    assert.equal(ex.totals.netPay, 0.3, "A3 FAIL: netPay 0.1*3 应为 0.30");
    assert.equal(ex.numericWarnings.length, 0, "A3 FAIL: 0.3 合计应无告警");
    console.log("payslip-export A3: .1 精度边界 ✓");
  }

  // ── A4: 空 confirmed → hasConfirmed=false，提示信息 ──
  {
    const records = [makeRecord("张三", "draft")];
    const ex = buildPayslipExport(records, 2026, 6);
    assert.equal(ex.rows.length, 0, "A4 FAIL: 无 confirmed 时 rows 应为空");
    assert.equal(ex.hasConfirmed, false, "A4 FAIL: hasConfirmed 应为 false");
    assert.deepEqual(ex.skippedDrafts, ["张三"], "A4 FAIL: 草稿员工应在 skippedDrafts");
    console.log("payslip-export A4: 空 confirmed 处理 ✓");
  }

  // ── A5: 全 confirmed 无 skipped ──
  {
    const records = [makeRecord("张三", "confirmed")];
    const ex = buildPayslipExport(records, 2026, 6);
    assert.deepEqual(ex.skippedDrafts, [], "A5 FAIL: 全 confirmed 时 skippedDrafts 应为空");
    console.log("payslip-export A5: 全 confirmed 无 skipped ✓");
  }

  // ─────────────────────────────────────────────
  // ② Python 脚本测试
  // ─────────────────────────────────────────────
  const outputDir = path.join(os.tmpdir(), `payslip-test-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  try {
    // ── B1: 正常路径 → 生成 xlsx，openpyxl 读回表头 + 某人实发 + 合计一致 ──
    const testRows = [
      { employeeName: "张三", grossPay: 10000, socialInsurance: 1000, housingFund: 500, specialDeduction: 200, taxCurrent: 300, netPay: 8000 },
      { employeeName: "李四", grossPay: 12000, socialInsurance: 1200, housingFund: 600, specialDeduction: 300, taxCurrent: 450, netPay: 9450 },
    ];
    const testTotals = {
      grossPay: 22000,
      socialInsurance: 2200,
      housingFund: 1100,
      specialDeduction: 500,
      taxCurrent: 750,
      netPay: 17450,
    };
    const outputPath = path.join(outputDir, "工资明细-2026年06月.xlsx");
    const workerPath = path.join(PROJECT_ROOT, "workers", "finance_worker.py");

    const pyOut = execFileSync(PYTHON_PATH, [workerPath, "export-payslips-xlsx"], {
      input: JSON.stringify({ outputPath, year: 2026, month: 6, rows: testRows, totals: testTotals }),
      encoding: "utf-8",
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      timeout: 30_000,
    }).trim();

    const pyResult = JSON.parse(pyOut) as { filePath: string };
    assert.ok(pyResult.filePath, "B1 FAIL: worker 应回显 filePath");
    assert.ok(existsSync(pyResult.filePath), `B1 FAIL: xlsx 文件应存在：${pyResult.filePath}`);

    // openpyxl 读回校验
    const verifyCode = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(r"${pyResult.filePath}")
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
# row 0: 期间标注，row 1: 表头，row 2: 张三，row 3: 李四，row 4: 合计
header = list(rows[1]) if len(rows) > 1 else []
zhang_san = list(rows[2]) if len(rows) > 2 else []
total_row = list(rows[-1]) if rows else []
print(json.dumps({
  "sheet_name": ws.title,
  "row_count": len(rows),
  "header": header,
  "zhang_san_net_pay": zhang_san[6] if len(zhang_san) > 6 else None,
  "total_net_pay": total_row[6] if len(total_row) > 6 else None,
  "title_row": list(rows[0]) if rows else [],
}))
`;
    const verifyOut = execFileSync(PYTHON_PATH, ["-c", verifyCode], {
      encoding: "utf-8",
      env: { ...process.env, PYTHONUTF8: "1" },
    }).trim();
    const v = JSON.parse(verifyOut) as {
      sheet_name: string;
      row_count: number;
      header: string[];
      zhang_san_net_pay: number | null;
      total_net_pay: number | null;
      title_row: (string | null)[];
    };

    assert.equal(v.sheet_name, "工资明细", `B1 FAIL: sheet 名应为「工资明细」，实际：${v.sheet_name}`);
    assert.ok(v.row_count >= 5, `B1 FAIL: 应有 ≥5 行（标注+表头+2人+合计），实际 ${v.row_count} 行`);
    assert.ok(v.header.includes("姓名"), `B1 FAIL: 表头应含「姓名」，实际：${JSON.stringify(v.header)}`);
    assert.ok(v.header.includes("实发工资"), `B1 FAIL: 表头应含「实发工资」，实际：${JSON.stringify(v.header)}`);
    assert.equal(v.zhang_san_net_pay, 8000, `B1 FAIL: 张三实发应为 8000，实际 ${v.zhang_san_net_pay}`);
    assert.equal(v.total_net_pay, 17450, `B1 FAIL: 实发合计应为 17450，实际 ${v.total_net_pay}`);
    assert.ok(
      v.title_row.some((c) => typeof c === "string" && c.includes("2026年6月")),
      `B1 FAIL: 第1行应含「2026年6月月工资明细」，实际：${JSON.stringify(v.title_row)}`
    );
    console.log("payslip-export B1: Python xlsx 生成 + openpyxl 读回校验 ✓");

    // ── B2: 同名重复导出 → 版本化 _v2，不覆盖第一份 ──
    const py2Out = execFileSync(PYTHON_PATH, [workerPath, "export-payslips-xlsx"], {
      input: JSON.stringify({ outputPath, year: 2026, month: 6, rows: testRows, totals: testTotals }),
      encoding: "utf-8",
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      timeout: 30_000,
    }).trim();
    const py2Result = JSON.parse(py2Out) as { filePath: string };
    assert.ok(py2Result.filePath.includes("_v2"), `B2 FAIL: 第二次导出应版本化 _v2，实际 ${py2Result.filePath}`);
    assert.ok(existsSync(py2Result.filePath), "B2 FAIL: _v2 文件应存在");
    assert.ok(existsSync(pyResult.filePath), "B2 FAIL: 第一份文件不应被覆盖");
    console.log("payslip-export B2: 防覆盖版本化 ✓");

  } finally {
    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ─────────────────────────────────────────────
  // ③ 源码契约测试
  // ─────────────────────────────────────────────

  // ── C1: payroll.ts 的 export_payslips 工具体不写库（无 savePayrollDraft）──
  {
    const payrollSrc = readFileSync(
      path.join(PROJECT_ROOT, "lib/agent/tools/finance/payroll.ts"),
      "utf-8"
    );
    // export_payslips 工具体不应调用 savePayrollDraft
    const exportFnStart = payrollSrc.indexOf("export_payslips");
    const exportFnBody = payrollSrc.slice(exportFnStart, exportFnStart + 3000);
    assert.ok(
      !exportFnBody.includes("savePayrollDraft"),
      "C1 FAIL: export_payslips 工具体不应调用 savePayrollDraft（只读库）"
    );
    console.log("payslip-export C1: export_payslips 不写库 ✓");
  }

  // ── C2: payload 不含 PII 字段 ──
  {
    const payrollSrc = readFileSync(
      path.join(PROJECT_ROOT, "lib/agent/tools/finance/payroll.ts"),
      "utf-8"
    );
    assert.ok(!payrollSrc.includes("idCard"), "C2 FAIL: payroll.ts 不得含 idCard 字段");
    assert.ok(!payrollSrc.includes("bankCard"), "C2 FAIL: payroll.ts 不得含 bankCard 字段");
    assert.ok(!payrollSrc.includes("身份证"), "C2 FAIL: payroll.ts payload 不得含「身份证」");
    console.log("payslip-export C2: 无 PII payload ✓");
  }

  // ── C3: 输出走 redact ──
  {
    const payrollSrc = readFileSync(
      path.join(PROJECT_ROOT, "lib/agent/tools/finance/payroll.ts"),
      "utf-8"
    );
    const exportFnStart = payrollSrc.indexOf("export_payslips");
    const exportFnBody = payrollSrc.slice(exportFnStart, exportFnStart + 3000);
    assert.ok(exportFnBody.includes("redact("), "C3 FAIL: export_payslips 文本输出应经 redact()");
    console.log("payslip-export C3: 文本经 redact() ✓");
  }

  // ── C4: registry.ts 该工具为 medium ──
  {
    const regSrc = readFileSync(
      path.join(PROJECT_ROOT, "lib/agent/tools/registry.ts"),
      "utf-8"
    );
    assert.ok(
      regSrc.includes("mcp__finance_worker__export_payslips"),
      "C4 FAIL: registry.ts 缺少 export_payslips 注册"
    );
    const idx = regSrc.indexOf("mcp__finance_worker__export_payslips");
    const snippet = regSrc.slice(idx, idx + 200);
    assert.ok(snippet.includes("medium"), `C4 FAIL: export_payslips 应为 medium，实际：${snippet}`);
    console.log("payslip-export C4: registry.ts medium 注册 ✓");
  }

  // ── C5: roles/registry.ts payroll-officer 含裸名 export_payslips ──
  {
    const rolesSrc = readFileSync(
      path.join(PROJECT_ROOT, "lib/agent/roles/registry.ts"),
      "utf-8"
    );
    assert.ok(
      rolesSrc.includes('"export_payslips"'),
      "C5 FAIL: roles/registry.ts payroll-officer 工具白名单缺 export_payslips"
    );
    console.log("payslip-export C5: roles/registry.ts 白名单含 export_payslips ✓");
  }

  // ── C6: finance_worker.py 含 export-payslips-xlsx 分发 ──
  {
    const workerSrc = readFileSync(
      path.join(PROJECT_ROOT, "workers/finance_worker.py"),
      "utf-8"
    );
    assert.ok(
      workerSrc.includes("export-payslips-xlsx"),
      "C6 FAIL: finance_worker.py 缺少 export-payslips-xlsx 分发"
    );
    assert.ok(
      workerSrc.includes("cmd_export_payslips_xlsx"),
      "C6 FAIL: finance_worker.py 缺少 cmd_export_payslips_xlsx 函数"
    );
    console.log("payslip-export C6: finance_worker.py 分发存在 ✓");
  }

  // ── C7: resolveRoleAllowedTools 含 export_payslips（注册原子性验证）──
  {
    const { resolveRoleAllowedTools } = await import("../lib/agent/roles/registry.ts");
    const tools = resolveRoleAllowedTools("payroll-officer");
    assert.ok(
      tools.includes("mcp__finance_worker__export_payslips"),
      `C7 FAIL: resolveRoleAllowedTools(payroll-officer) 未含 export_payslips，实际：${tools.join(", ")}`
    );
    console.log("payslip-export C7: resolveRoleAllowedTools 含 export_payslips ✓");
  }

  // ── C8: renderers.ts 含 export_payslips 摘要 ──
  {
    const renderersSrc = readFileSync(
      path.join(PROJECT_ROOT, "lib/agent/tools/renderers.ts"),
      "utf-8"
    );
    assert.ok(
      renderersSrc.includes("export_payslips"),
      "C8 FAIL: renderers.ts 缺少 export_payslips 摘要"
    );
    console.log("payslip-export C8: renderers.ts 含 export_payslips 摘要 ✓");
  }

  // ── C9: mcp-tools/index.ts 传 outputDir 给 createPayrollTools ──
  {
    const indexSrc = readFileSync(
      path.join(PROJECT_ROOT, "lib/agent/mcp-tools/index.ts"),
      "utf-8"
    );
    assert.ok(
      indexSrc.includes("createPayrollTools(sdk, outputDir)"),
      "C9 FAIL: mcp-tools/index.ts 未传 outputDir 给 createPayrollTools"
    );
    console.log("payslip-export C9: mcp-tools/index.ts 传 outputDir ✓");
  }

  console.log("payslip-export: 所有测试通过 ✓");
})();
