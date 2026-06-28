import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { parseDocument } from "../lib/knowledge/parsers/index.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS_MIME = "application/vnd.ms-excel";

// 知识库 Excel 解析(server 侧 exceljs)。生成 Excel 已迁到 SDK skill + run_python,
// 本测试只覆盖「知识库能正确读回 .xlsx」这条独立路径。
export const excelRoundtripTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-xlsx-test-"));

  try {
    // 直接用 exceljs 造一张样例 .xlsx(不再经已删除的 generate_excel_report 工具)
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("六月报销");
    ws.addRow(["姓名", "类目", "金额"]);
    ws.addRow(["张三", "差旅", 1200]);
    ws.addRow(["李四", "餐饮", 300]);
    ws.addRow(["合计", "", 1500]);
    const filePath = path.join(dir, "报销汇总.xlsx");
    await wb.xlsx.writeFile(filePath);

    // ── AC: 知识库解析能正确读回生成的 .xlsx ───────────────────────────────
    const parsed = await parseDocument(filePath, XLSX_MIME);
    assert.ok(parsed.includes("## 六月报销"), "AC FAIL: 解析应含 sheet 标题");
    assert.ok(parsed.includes("姓名: 张三") && parsed.includes("金额: 1200"), "AC FAIL: 解析应含 表头:值");

    // 旧版 .xls 不再用有漏洞的解析库,显式提示另存(安全取舍)
    await assert.rejects(() => parseDocument(filePath, XLS_MIME), /另存为 \.xlsx/, "AC FAIL: .xls 应提示另存为 xlsx");

    console.log("excel-roundtrip: all checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
