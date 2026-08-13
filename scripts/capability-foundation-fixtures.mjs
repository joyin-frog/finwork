#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import pptxgen from "pptxgenjs";
import sharp from "sharp";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, ".finwork-test", "capability-foundation", "fixtures");
const LARGE_BYTES = 5 * 1024 * 1024 + 256 * 1024;

async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeDocumentFixture() {
  const target = path.join(OUTPUT_DIR, "finance-evidence.docx");
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: "财务证据文档", bold: true })],
          }),
          new Paragraph("主体：示例公司；期间：2026 年第二季度；币种：CNY。"),
          new Table({
            rows: [
              new TableRow({
                children: [new TableCell({ children: [new Paragraph("科目")] }), new TableCell({ children: [new Paragraph("金额")] })],
              }),
              new TableRow({
                children: [new TableCell({ children: [new Paragraph("货币资金")] }), new TableCell({ children: [new Paragraph("139895.87")] })],
              }),
            ],
          }),
        ],
      },
    ],
  });
  await writeFile(target, await Packer.toBuffer(document));
  return target;
}

async function writePdfFixture() {
  const target = path.join(OUTPUT_DIR, "finance-evidence.pdf");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Finance evidence fixture", { x: 48, y: 780, size: 18, font });
  page.drawText("Entity: Example Co. | Period: 2026 Q2 | Currency: CNY", { x: 48, y: 748, size: 11, font });
  page.drawRectangle({ x: 48, y: 670, width: 300, height: 48, borderWidth: 1, borderColor: rgb(0.5, 0.5, 0.5) });
  page.drawText("Cash", { x: 60, y: 694, size: 11, font });
  page.drawText("139,895.87", { x: 220, y: 694, size: 11, font });
  await writeFile(target, await pdf.save());
  return target;
}

async function writeScannedPdfFixture() {
  const target = path.join(OUTPUT_DIR, "scanned-invoice-ocr.pdf");
  const png = await sharp({
    create: { width: 1200, height: 1600, channels: 3, background: "#ffffff" },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="1200" height="1600" xmlns="http://www.w3.org/2000/svg">
            <text x="80" y="130" font-size="52" font-family="sans-serif">SCANNED INVOICE FIXTURE</text>
            <text x="80" y="240" font-size="36" font-family="sans-serif">Invoice No: FIN-2026-0001</text>
            <text x="80" y="320" font-size="36" font-family="sans-serif">Amount: CNY 12,345.67</text>
            <rect x="70" y="380" width="980" height="480" fill="none" stroke="#333" stroke-width="4"/>
          </svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(png);
  const page = pdf.addPage([600, 800]);
  page.drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
  await writeFile(target, await pdf.save());
  return target;
}

async function writePresentationFixture() {
  const target = path.join(OUTPUT_DIR, "finance-review.pptx");
  const presentation = new pptxgen();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "Finwork fixture generator";
  presentation.subject = "Anonymous finance capability fixture";
  const slide = presentation.addSlide();
  slide.addText("2026 Q2 财务复核", { x: 0.7, y: 0.6, w: 6.2, h: 0.5, fontSize: 24, bold: true });
  slide.addText("资产 = 负债 + 所有者权益", { x: 0.7, y: 1.5, w: 5.5, h: 0.4, fontSize: 18 });
  slide.addText("41,432,798.71", { x: 0.7, y: 2.2, w: 3.5, h: 0.5, fontSize: 26, color: "2563EB" });
  await presentation.writeFile({ fileName: target });
  return target;
}

async function createWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Finwork fixture generator";
  const sheet = workbook.addWorksheet("Trial Balance");
  sheet.addRow(["Account", "Debit", "Credit", "Source"]);
  sheet.addRow(["Cash", 139895.87, 0, "TB!A2"]);
  sheet.addRow(["Equity", 0, 139895.87, "TB!A3"]);
  sheet.getRow(1).font = { bold: true };
  return workbook;
}

async function writeExternalLinkFixture() {
  const target = path.join(OUTPUT_DIR, "external-linked-workbook.xlsx");
  const workbook = await createWorkbook();
  const sheet = workbook.addWorksheet("External Reference");
  sheet.getCell("A1").value = "External source value";
  sheet.getCell("B1").value = {
    formula: "'[external-ledger.xlsx]Ledger'!$B$2",
    result: 139895.87,
  };
  await workbook.xlsx.writeFile(target);
  return target;
}

async function writeLargeWorkbookFixture() {
  const target = path.join(OUTPUT_DIR, "large-finance-workbook.xlsx");
  const workbook = await createWorkbook();
  const buffer = await workbook.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(buffer);
  zip.file("xl/finwork-large-fixture.bin", Buffer.alloc(LARGE_BYTES, 0xa5), {
    binary: true,
    compression: "STORE",
  });
  await writeFile(target, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return target;
}

await mkdir(OUTPUT_DIR, { recursive: true });
const generated = await Promise.all([
  writeDocumentFixture(),
  writePdfFixture(),
  writeScannedPdfFixture(),
  writePresentationFixture(),
  writeExternalLinkFixture(),
  writeLargeWorkbookFixture(),
]);

const files = [];
for (const filePath of generated) {
  files.push({
    path: path.relative(ROOT, filePath),
    bytes: (await stat(filePath)).size,
    sha256: await hashFile(filePath),
  });
}
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  anonymous: true,
  files,
};
await writeFile(path.join(OUTPUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ outputDir: path.relative(ROOT, OUTPUT_DIR), files: files.length }));
