import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

type Json = Record<string, unknown>;
const root = path.resolve(process.cwd());
const fixtures = [
  process.env.ARTIFACT_SPIKE_XLSX_1 ?? path.join(root, "real-fixtures/个税/新建 XLSX 工作表.backup-20260521-个税写入前.xlsx"),
  process.env.ARTIFACT_SPIKE_XLSX_2 ?? path.join(root, "real-fixtures/dusen2/都森2026-2030年预测表.xlsx"),
];

let mod: any;
try {
  const packagePath = process.env.ARTIFACT_TOOL_PATH;
  mod = packagePath
    ? createRequire(path.join(packagePath, "package.json"))("@oai/artifact-tool")
    : createRequire(import.meta.url)("@oai/artifact-tool");
} catch (error) {
  console.log(JSON.stringify({
    provider: "artifact_tool",
    status: "unavailable",
    reason: "dependency_not_installed",
    detail: String(error),
    fixtures,
  }, null, 2));
  process.exit(0);
}

const result: Json = {
  provider: "artifact_tool",
  status: "available",
  exportedKeys: Object.keys(mod),
  fixtures,
  fixtureResults: [],
};

// Always test the documented create/inspect/formula/render/export path.
const workbook = mod.Workbook.create();
const sheet = workbook.worksheets.add("Spike");
sheet.getRange("A1:B2").values = [["Input", "Formula"], [2, "=A2*2"]];
const inspect = await workbook.inspect({ kind: "table", range: "Spike!A1:B2", include: "values,formulas" });
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
});
const rendered = await workbook.render({ sheetName: "Spike", autoCrop: "all", scale: 1, format: "png" });
const exportBlob = await mod.SpreadsheetFile.exportXlsx(workbook);
const exportPath = path.join(root, ".tmp-artifact-tool-spike.xlsx");
await exportBlob.save(exportPath);
const renderedBytes = new Uint8Array(await rendered.arrayBuffer());
result.createPath = {
  inspect: inspect.ndjson,
  errors: errors.ndjson,
  renderedBytes: renderedBytes.byteLength,
  exportedBytes: (await fs.stat(exportPath)).size,
};

// Import APIs differ between artifact-tool versions. Discover the capability
// without claiming support when the installed version does not expose it.
const importFn = mod.SpreadsheetFile?.importXlsx ?? mod.SpreadsheetFile?.fromXlsx;
if (typeof importFn !== "function") {
  result.importStatus = "unsupported_by_installed_version";
} else {
  result.importStatus = "available";
  result.importFixtures = [];
  for (const file of fixtures) {
    try {
      const imported = await importFn(new Uint8Array(await fs.readFile(file)));
      const sheetNames = imported.worksheets.items?.map((item: { name: string }) => item.name) ?? [];
      const firstSheet = sheetNames[0];
      const table = firstSheet
        ? await imported.inspect({
            kind: "table",
            range: `${firstSheet}!A1:H5`,
            include: "values,formulas",
            tableMaxRows: 5,
            tableMaxCols: 8,
          })
        : null;
      const formulaErrors = await imported.inspect({
        kind: "match",
        searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
        options: { useRegex: true, maxResults: 100 },
      });
      result.importFixtures.push({
        file,
        sheetNames,
        firstTable: table?.ndjson ?? null,
        formulaErrors: formulaErrors.ndjson,
      });
    } catch (error) {
      result.importFixtures.push({ file, error: String(error) });
    }
  }
}

await fs.rm(exportPath, { force: true });
console.log(JSON.stringify(result, null, 2));
