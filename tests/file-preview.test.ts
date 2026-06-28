import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function main() {
  const previewComponent = fs.readFileSync(
    path.join(import.meta.dirname, "../app/shared/file-preview-page.tsx"), "utf-8"
  );
  const previewRoute = fs.readFileSync(
    path.join(import.meta.dirname, "../app/preview/page.tsx"), "utf-8"
  );
  const packageJson = fs.readFileSync(
    path.join(import.meta.dirname, "../package.json"), "utf-8"
  );
  const tauriConfig = fs.readFileSync(
    path.join(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf-8"
  );
  const capability = fs.readFileSync(
    path.join(import.meta.dirname, "../src-tauri/capabilities/default.json"), "utf-8"
  );
  const cargoToml = fs.readFileSync(
    path.join(import.meta.dirname, "../src-tauri/Cargo.toml"), "utf-8"
  );

  assert.ok(previewComponent.includes("@tauri-apps/plugin-dialog"), "preview page should use plugin-dialog");
  assert.ok(previewComponent.includes("@tauri-apps/plugin-fs"), "preview page should use plugin-fs");
  assert.ok(previewComponent.includes("@tauri-apps/plugin-shell"), "preview page should use plugin-shell for open-with actions");
  assert.ok(previewComponent.includes("DocxPreviewWrapper"), "preview page should render docx via docx-preview");
  assert.ok(previewComponent.includes("wb.xlsx.load"), "preview page should parse excel via exceljs");
  assert.ok(!previewComponent.includes('from "xlsx"'), "preview page should no longer depend on the vulnerable xlsx lib");
  assert.ok(previewComponent.includes("extractCellStyle"), "preview page should extract cell fill colors from excel styles");
  assert.ok(previewComponent.includes('import("react-pdf")'), "preview page should load react-pdf dynamically");
  assert.ok(previewComponent.includes("ensurePromiseWithResolvers"), "preview page should polyfill Promise.withResolvers for pdfjs compatibility");
  assert.ok(previewComponent.includes("<pdfComponents.Document file={preview.src}"), "preview page should render pdf via react-pdf");
  assert.ok(previewComponent.includes("<iframe src={preview.src}"), "preview page should fall back to native iframe pdf preview");
  assert.ok(previewComponent.includes("打开方式"), "preview page should expose open-with actions in the header");
  assert.ok(previewComponent.includes("preview-head-card"), "preview page should render a single header card for file name and open-with");
  assert.ok(previewComponent.includes("preview-head-title"), "preview page should render the file name inline in the header card");
  assert.ok(previewComponent.includes("preview-text-page"), "preview page should render txt content inside a plain document-like page container");
  assert.ok(previewComponent.includes("<DocxPreviewWrapper"), "preview page should render docx via docx-preview wrapper");
  assert.ok(previewComponent.includes("preview-excel-page"), "preview page should render excel content inside a worksheet-like page container");
  assert.ok(previewComponent.includes("preview-excel-grid-scroll"), "preview page should wrap excel content in a horizontal scroll container");
  assert.ok(previewComponent.includes("preview-excel-formula-bar"), "preview page should render an excel-like formula bar");
  assert.ok(previewComponent.includes("preview-excel-sheet-tabs"), "preview page should render workbook sheet tabs");
  assert.ok(previewComponent.includes("buildExcelSheet"), "preview page should build a richer excel worksheet model");
  assert.ok(previewComponent.includes("toExcelColumnLabel"), "preview page should derive excel column labels");
  assert.ok(previewComponent.includes("buildExcelColumnWidths"), "preview page should compute excel column widths");
  assert.ok(previewComponent.includes("toggleOpenWithMenu"), "preview page should manage an open-with menu");
  assert.ok(previewComponent.includes("openCurrentFile"), "preview page should open the current file through open-with actions");
  assert.ok(previewComponent.includes("打开文件"), "preview page should keep the local file picker action when no selection exists");
  assert.ok(previewComponent.includes('currentSelection.kind === "draft"'), "preview page should special-case draft selections");
  assert.ok(previewComponent.includes("decodeDataUrlToBytes"), "preview page should decode in-memory draft data URLs");
  assert.ok(previewComponent.includes("readTextFile"), "preview page should read text files");
  assert.ok(previewComponent.includes("readFile"), "preview page should read binary files");
  console.log("✓ PASS: preview component covers all requested loaders");

  assert.ok(previewRoute.includes("独立预览页"), "preview route should exist as standalone page");
  console.log("✓ PASS: standalone preview route exists");

  assert.ok(packageJson.includes("@tauri-apps/plugin-dialog"), "package.json should include plugin-dialog");
  assert.ok(packageJson.includes("@tauri-apps/plugin-fs"), "package.json should include plugin-fs");
  assert.ok(packageJson.includes("mammoth"), "package.json should include mammoth");
  assert.ok(packageJson.includes("react-pdf"), "package.json should include react-pdf");
  console.log("✓ PASS: package dependencies declared");

  assert.ok(tauriConfig.includes("\"scope\""), "tauri.conf.json should configure asset/fs scope");
  // 文件预览靠 capabilities 的 fs:allow-read-file "**"(读用户任选路径);plan 023 把
  // tauri.conf.json 的 assetProtocol scope 收窄为 [](asset:// 未使用),故宽作用域在此校验。
  assert.ok(capability.includes("\"**\""), "capability fs:allow-read-file should keep broad scope for file preview");
  assert.ok(capability.includes("dialog:allow-open"), "capability should allow dialog open");
  assert.ok(capability.includes("fs:allow-read-file"), "capability should allow fs reads");
  assert.ok(capability.includes("\"soffice\""), "capability should allow soffice execution");
  assert.ok(cargoToml.includes("tauri-plugin-dialog"), "Cargo.toml should include tauri dialog plugin");
  assert.ok(cargoToml.includes("tauri-plugin-fs"), "Cargo.toml should include tauri fs plugin");
  console.log("✓ PASS: Tauri permissions/plugins declared");

  console.log("\n✅ All file preview tests passed!");
}

main();
