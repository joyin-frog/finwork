import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildFinanceToolDefinitions } from "@/lib/agent/mcp-tools";
import { createWorkbookBuffer } from "@/lib/workbook-ir";
import { getPythonPath } from "@/lib/runtime/paths";

type ToolResult = {
  isError?: boolean;
  structuredContent?: { filePath?: string; chartCount?: number };
  content?: Array<{ text?: string }>;
};

export const createWorkbookTestPromise = (async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "finwork-create-workbook-"));
  try {
    const definitions = buildFinanceToolDefinitions(temporary);
    const definition = definitions.find((item) => item.name === "create_workbook");
    assert.ok(definition, "create_workbook must be registered in the production catalog");

    const args = {
      outputName: "预算差异.xlsx",
      sheets: [{
        name: "汇总",
        headerRows: 1,
        autoFilter: true,
        rows: [
          ["部门", "预算", "实际", "差异率", "文字公式"],
          ["销售部", 100, 120, { formula: "(C2-B2)/B2", result: 0.2, numberFormat: "0.0%" }, "=保持为文本"],
          ["研发部", 160, 130, { formula: "(C3-B3)/B3", result: -0.1875, numberFormat: "0.0%" }, null],
          ["合计", { formula: "SUM(B2:B3)", result: 260 }, { formula: "SUM(C2:C3)", result: 250 }, null, null],
        ],
        charts: [
          {
            type: "bar",
            title: "预算与实际",
            sourceSheet: "汇总",
            categoryRange: "A2:A3",
            valueRange: "C2:C3",
            direction: "column",
            fromCell: "G2",
            toCell: "N18",
          },
          {
            type: "pie",
            title: "实际结构",
            sourceSheet: "汇总",
            categoryRange: "A2:A3",
            valueRange: "C2:C3",
            fromCell: "G20",
            toCell: "N36",
          },
        ],
      }],
    };

    const first = await definition.handler(args) as ToolResult;
    assert.equal(first.isError, undefined);
    const firstPath = first.structuredContent?.filePath;
    assert.ok(firstPath?.endsWith("预算差异.xlsx"));
    assert.equal(first.structuredContent?.chartCount, 2);
    assert.equal((await stat(firstPath)).mode & 0o777, 0o600);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await readFile(firstPath));
    const sheet = workbook.getWorksheet("汇总");
    assert.ok(sheet);
    assert.equal(sheet.getCell("A1").font.bold, true);
    assert.equal(sheet.getCell("A1").font.name, "Arial");
    assert.equal(sheet.getCell("D2").formula, "(C2-B2)/B2");
    assert.equal(sheet.getCell("D2").result, 0.2);
    assert.equal(sheet.getCell("D2").numFmt, "0.0%");
    assert.equal(sheet.getCell("E2").value, "=保持为文本");
    assert.equal(sheet.views[0]?.state, "frozen");
    assert.ok(sheet.autoFilter);

    const packageZip = await JSZip.loadAsync(await readFile(firstPath));
    assert.ok(packageZip.file("xl/charts/chart1.xml"), "bar chart OOXML must exist");
    assert.ok(packageZip.file("xl/charts/chart2.xml"), "pie chart OOXML must exist");
    assert.ok(packageZip.file("xl/drawings/drawing1.xml"), "drawing OOXML must exist");
    assert.match(
      await packageZip.file("xl/worksheets/sheet1.xml")!.async("string"),
      /<drawing r:id="rId\d+"\/>/,
    );
    const chartProbe = execFileSync(getPythonPath(), [
      "-c",
      "import openpyxl,sys; w=openpyxl.load_workbook(sys.argv[1]); print(len(w['汇总']._charts))",
      firstPath,
    ], { encoding: "utf8" }).trim();
    assert.equal(chartProbe, "2", "openpyxl must recognize both native charts");

    const firstBytes = await readFile(firstPath);
    const second = await definition.handler(args) as ToolResult;
    const secondPath = second.structuredContent?.filePath;
    assert.ok(secondPath?.endsWith("预算差异 (2).xlsx"));
    assert.notEqual(secondPath, firstPath);
    assert.deepEqual(await readFile(firstPath), firstBytes);

    const unsafe = await definition.handler({
      outputName: "unsafe.xlsx",
      sheets: [{ name: "Sheet1", rows: [[{ formula: "WEBSERVICE(\"https://example.com\")" }]] }],
    }) as ToolResult;
    assert.equal(unsafe.isError, true);
    assert.match(unsafe.content?.[0]?.text ?? "", /外部工作簿、网络请求或动态数据连接/);

    const dde = await definition.handler({
      outputName: "dde.xlsx",
      sheets: [{ name: "Sheet1", rows: [[{ formula: "cmd|' /C calc'!A0" }]] }],
    }) as ToolResult;
    assert.equal(dde.isError, true);

    const ambiguous = await definition.handler({
      outputName: "ambiguous.xlsx",
      sheets: [{ name: "Sheet1", rows: [[{ value: 1, formula: "1+1", result: 2 }]] }],
    }) as ToolResult;
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content?.[0]?.text ?? "", /不能同时提供 value 和 formula/);

    await assert.rejects(
      createWorkbookBuffer({
        sheets: [{ name: "重复", rows: [] }, { name: "重复", rows: [] }],
      }),
      /工作表名重复/,
    );

    console.log("create-workbook tests passed");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
})();
