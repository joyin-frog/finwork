import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, ".finwork-test", "capability-foundation", "fixtures");

export const capabilityFixturesTestPromise = (async () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "capability-foundation-fixtures.mjs")], {
    cwd: ROOT,
    stdio: "pipe",
  });

  const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")) as {
    anonymous: boolean;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  assert.equal(manifest.anonymous, true);
  assert.equal(manifest.files.length, 6);
  assert.equal(manifest.files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)), true);

  const docx = await JSZip.loadAsync(readFileSync(path.join(FIXTURES, "finance-evidence.docx")));
  assert.ok(docx.file("word/document.xml"), "DOCX fixture must contain a document body");

  const pptx = await JSZip.loadAsync(readFileSync(path.join(FIXTURES, "finance-review.pptx")));
  assert.ok(pptx.file("ppt/slides/slide1.xml"), "PPTX fixture must contain a slide");

  const pdf = await PDFDocument.load(readFileSync(path.join(FIXTURES, "finance-evidence.pdf")));
  assert.equal(pdf.getPageCount(), 1);
  const scanned = await PDFDocument.load(readFileSync(path.join(FIXTURES, "scanned-invoice-ocr.pdf")));
  assert.equal(scanned.getPageCount(), 1);

  const linkedWorkbook = new ExcelJS.Workbook();
  await linkedWorkbook.xlsx.readFile(path.join(FIXTURES, "external-linked-workbook.xlsx"));
  const linkedCell = linkedWorkbook.getWorksheet("External Reference")?.getCell("B1").value;
  assert.equal(typeof linkedCell, "object");
  assert.match(String((linkedCell as { formula?: string }).formula), /external-ledger\.xlsx/);

  const largePath = path.join(FIXTURES, "large-finance-workbook.xlsx");
  assert.ok(statSync(largePath).size >= 5 * 1024 * 1024, "large workbook fixture must cross the 5 MiB gate");
  const largeWorkbook = new ExcelJS.Workbook();
  await largeWorkbook.xlsx.readFile(largePath);
  assert.equal(largeWorkbook.getWorksheet("Trial Balance")?.getCell("A2").value, "Cash");

  console.log("capability-fixtures tests passed");
})();
