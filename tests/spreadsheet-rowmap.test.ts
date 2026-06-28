import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { buildSpreadsheetMirror } from "../lib/knowledge/parsers/index.ts";

// 黄金用例:证明"镜像文本"与"逐行→(工作表,行号)映射"严格对齐且行号准确。
// 这是"搜索命中→跳到原表对应行"功能里最容易错的一环(provenance 漂移),用确定性单测兜住:
// 镜像生成口径一旦改动而映射没跟上,这里立刻红。
export const spreadsheetRowmapTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-rowmap-test-"));
  try {
    const wb = new ExcelJS.Workbook();
    const ws1 = wb.addWorksheet("工资表");
    ws1.addRow(["姓名", "部门", "工资"]); // row 1 (表头)
    ws1.addRow(["张三", "技术", 10000]); // row 2
    ws1.addRow(["李四", "财务", 8000]); //  row 3
    // row 4 故意留空(eachRow 跳过)→ 王五落在 row 5,验证 rowNumber 是"真实原表行号"而非顺序计数
    ws1.getRow(5).values = ["王五", "市场", 9000];

    const ws2 = wb.addWorksheet("备注");
    ws2.addRow(["项目", "说明"]); // row 1
    ws2.addRow(["A", "多行\n说明"]); // row 2,单元格含换行 → 必须被压平成一行

    const filePath = path.join(dir, "样例.xlsx");
    await wb.xlsx.writeFile(filePath);

    const { text, lineMeta } = await buildSpreadsheetMirror(filePath);
    const lines = text.split("\n");

    // ── AC1: 对齐不变量——镜像行数 === lineMeta 长度(整个映射的地基) ──
    assert.equal(lines.length, lineMeta.length, "AC1 FAIL: text 行数与 lineMeta 长度必须一致");

    // ── AC2: `## 工作表名` 标题行的 meta 为 null;数据行非 null ──
    const sheetHeaderIdx = lines.findIndex((l) => l === "## 工资表");
    assert.ok(sheetHeaderIdx >= 0, "AC2 FAIL: 应有「## 工资表」标题行");
    assert.equal(lineMeta[sheetHeaderIdx], null, "AC2 FAIL: 标题行 meta 应为 null");

    // ── AC3: 数据行映射到正确的(工作表,原表行号) ──
    const zhangIdx = lines.findIndex((l) => l.includes("张三"));
    assert.deepEqual(lineMeta[zhangIdx], { sheet: "工资表", row: 2 }, "AC3 FAIL: 张三应映射到 工资表 第2行");
    const liIdx = lines.findIndex((l) => l.includes("李四"));
    assert.deepEqual(lineMeta[liIdx], { sheet: "工资表", row: 3 }, "AC3 FAIL: 李四应映射到 工资表 第3行");

    // ── AC4: 跳过空行后,行号仍是真实原表行号(王五在 row 5,不是 row 4) ──
    const wangIdx = lines.findIndex((l) => l.includes("王五"));
    assert.deepEqual(lineMeta[wangIdx], { sheet: "工资表", row: 5 }, "AC4 FAIL: 空行后行号应为真实行号 5");

    // ── AC5: 含换行的单元格被压平 → 仍是一行,不破坏对齐 ──
    const aIdx = lines.findIndex((l) => l.startsWith("项目: A"));
    assert.ok(aIdx >= 0, "AC5 FAIL: 备注首行应存在");
    assert.ok(!lines[aIdx].includes("\n"), "AC5 FAIL: 单元格换行应被压平");
    assert.ok(lines[aIdx].includes("多行 说明"), "AC5 FAIL: 换行应压成空格");
    assert.deepEqual(lineMeta[aIdx], { sheet: "备注", row: 2 }, "AC5 FAIL: 应映射到 备注 第2行");

    console.log("✓ spreadsheet-rowmap: 镜像↔行号映射对齐且准确(空行跳号/多行单元格压平)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
