import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { sanitizeXlsxForPreview } from "../lib/preview/xlsx-sanitize.ts";

// 回归:exceljs 读 openpyxl/Excel 生成的某些附加部件会崩(数据本身没问题):
// - 批注:reading 'comments'(t.comments[n.Target].comments);
// - 绘图(图表/图片):reading 'anchors'(r.anchors)。
// 两个 fixture 由 openpyxl 写入(分别带批注、带图表),复现用户两次预览报错。
// sanitizeXlsxForPreview 剥掉这些部件后应能加载,且单元格数据完整。
export const xlsxSanitizeTestPromise = (async () => {
  const fixtures = [
    { file: "xlsx-with-comments.xlsx", what: "批注(comments)" },
    { file: "xlsx-with-chart.xlsx", what: "图表(drawing/anchors)" },
  ];

  for (const { file, what } of fixtures) {
    const buf = readFileSync(path.join(import.meta.dirname, "fixtures", file));

    // 前提:原始加载会崩(复现报错)
    let rawThrew = false;
    try {
      await new ExcelJS.Workbook().xlsx.load(buf);
    } catch {
      rawThrew = true;
    }
    assert.equal(rawThrew, true, `前提:${what} 的 xlsx,exceljs 直接加载应抛错(否则 fixture 没复现到崩溃)`);

    // sanitize 后应成功加载,且数据完整
    const clean = await sanitizeXlsxForPreview(new Uint8Array(buf));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(clean);
    const ws = wb.getWorksheet(1);
    assert.ok(ws, `${what}:sanitize 后应有工作表`);
    assert.equal(ws!.getCell("A2").value, "财务费用", `${what}:数据应完整(A2 文本)`);
    assert.equal(ws!.getCell("B2").value, 185.84, `${what}:数据应完整(B2 数值)`);
  }

  console.log("xlsx-sanitize: 批注 / 图表 崩溃文件 sanitize 后均可加载且数据完整 ✓");
})();
