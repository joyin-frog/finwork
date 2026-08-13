import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  assertPreservationPolicy,
  applyOfficeDocumentOperations,
  assertDocumentPatchPlan,
  createDocumentPatchPlan,
  diffDocumentIr,
  parseDocumentBytes,
  parseDocumentFile,
  preserveRoundTrip,
} from "@/lib/document-ir";

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, ".finwork-test", "capability-foundation", "fixtures");

async function decoratedDocx(sourcePath: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await readFile(sourcePath));
  const documentXml = (await zip.file("word/document.xml")?.async("text")) ?? "";
  zip.file(
    "word/document.xml",
    documentXml.replace(
      "</w:body>",
      '<w:p><w:r><w:t>保留测试</w:t></w:r><w:ins w:id="1"><w:r><w:t>修订内容</w:t></w:r></w:ins></w:p></w:body>',
    ),
  );
  zip.file("word/comments.xml", '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"><w:p><w:r><w:t>复核意见</w:t></w:r></w:p></w:comment></w:comments>');
  zip.file("word/footnotes.xml", '<?xml version="1.0"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>脚注</w:t></w:r></w:p></w:footnote></w:footnotes>');
  zip.file("word/media/evidence.png", Buffer.from([137, 80, 78, 71]));
  return zip.generateAsync({ type: "uint8array" });
}

async function policyBlockedXlsx(sourcePath: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await readFile(sourcePath));
  zip.file("xl/vbaProject.bin", Buffer.from("quarantined-fixture"));
  zip.file("xl/embeddings/oleObject1.bin", Buffer.from("embedded-fixture"));
  zip.file("_xmlsignatures/sig1.xml", "<Signature />");
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rExt" Type="externalLink" Target="https://example.invalid/ledger.xlsx" TargetMode="External"/></Relationships>',
  );
  return zip.generateAsync({ type: "uint8array" });
}

export const documentIrTestPromise = (async () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "capability-foundation-fixtures.mjs")], { cwd: ROOT, stdio: "pipe" });

  const docxPath = path.join(FIXTURES, "finance-evidence.docx");
  const pdfPath = path.join(FIXTURES, "finance-evidence.pdf");
  const scannedPdfPath = path.join(FIXTURES, "scanned-invoice-ocr.pdf");
  const pptxPath = path.join(FIXTURES, "finance-review.pptx");
  const xlsxPath = path.join(FIXTURES, "external-linked-workbook.xlsx");

  const [docx, pdf, scannedPdf, pptx, xlsx] = await Promise.all([
    parseDocumentFile(docxPath),
    parseDocumentFile(pdfPath),
    parseDocumentFile(scannedPdfPath),
    parseDocumentFile(pptxPath),
    parseDocumentFile(xlsxPath),
  ]);
  assert.ok(docx.nodes.some((item) => item.kind === "paragraph" && item.text?.includes("财务证据文档")));
  assert.ok(docx.nodes.some((item) => item.kind === "table"));
  assert.ok(pdf.nodes.some((item) => item.kind === "text_block" && item.locator.kind === "bbox"));
  assert.equal(pdf.manifest.blocked, false);
  assert.ok(scannedPdf.nodes.some((item) => item.kind === "ocr_region"));
  assert.equal(scannedPdf.manifest.features.find((item) => item.feature === "ocr_required")?.disposition, "block");
  assert.ok(pptx.nodes.some((item) => item.kind === "slide"));
  assert.ok(pptx.nodes.some((item) => item.kind === "shape"));
  assert.ok(xlsx.nodes.some((item) => item.kind === "sheet" && item.locator.kind === "sheet_range"));

  const decorated = await parseDocumentBytes("docx", await decoratedDocx(docxPath));
  assert.deepEqual(
    decorated.manifest.features.filter((item) => ["comments", "revisions", "footnotes", "images"].includes(item.feature)).map((item) => item.feature).sort(),
    ["comments", "footnotes", "images", "revisions"],
  );
  assert.ok(decorated.nodes.some((item) => item.kind === "run" && item.parentId));
  assert.ok(decorated.nodes.some((item) => item.kind === "table_row" && item.parentId));
  assert.ok(decorated.nodes.some((item) => item.kind === "table_cell" && item.parentId));
  assert.ok(decorated.nodes.some((item) => item.kind === "comment" && item.text === "复核意见"));
  assert.ok(decorated.nodes.some((item) => item.kind === "footnote" && item.text === "脚注"));
  assert.ok(decorated.nodes.some((item) => item.kind === "revision" && item.text?.includes("修订内容")));
  assert.ok(decorated.nodes.some((item) => item.kind === "image"));

  const blocked = await parseDocumentBytes("xlsx", await policyBlockedXlsx(xlsxPath));
  for (const feature of ["macros", "external_links", "embedded_objects", "digital_signatures"] as const) {
    assert.ok(blocked.manifest.features.some((item) => item.feature === feature), `must detect ${feature}`);
  }
  assert.throws(() => assertPreservationPolicy(blocked.manifest), /document_preservation_blocked/);

  const temporary = await mkdtemp(path.join(os.tmpdir(), "finwork-document-ir-"));
  try {
    const targetPath = path.join(temporary, "roundtrip.docx");
    const roundTrip = await preserveRoundTrip(docxPath, targetPath, docx.manifest);
    assert.equal(roundTrip.byteIdentical, true);
    const reparsed = await parseDocumentFile(targetPath);
    const diff = diffDocumentIr(docx, reparsed, 1);
    assert.equal(diff.structureSimilarity, 1);
    assert.equal(diff.visualSimilarity, 1);

    const blockedPath = path.join(temporary, "blocked.xlsm");
    await writeFile(blockedPath, await policyBlockedXlsx(xlsxPath));
    await assert.rejects(() => preserveRoundTrip(blockedPath, path.join(temporary, "blocked-copy.xlsm"), blocked.manifest), /document_preservation_blocked/);

    const editableDocx = path.join(temporary, "editable.docx");
    await writeFile(editableDocx, await decoratedDocx(docxPath));
    const editedDocx = path.join(temporary, "edited.docx");
    const editableDocxIr = await parseDocumentFile(editableDocx);
    const paragraph = editableDocxIr.nodes.find((item) => item.kind === "paragraph" && item.locator.kind === "paragraph");
    assert.ok(paragraph && paragraph.locator.kind === "paragraph");
    const docxPlan = createDocumentPatchPlan(editableDocxIr, [
      { kind: "replace_text", locator: paragraph.locator, text: "已定位修改的财务证据" },
    ]);
    assert.equal(docxPlan.executable, true);
    assert.deepEqual(docxPlan.impact.packageEntries, ["word/document.xml"]);
    assert.equal(docxPlan.rollbackOperations[0]?.kind, "replace_text");
    assert.doesNotThrow(() => assertDocumentPatchPlan(editableDocxIr, docxPlan));
    const docxReport = await applyOfficeDocumentOperations({
      sourcePath: editableDocx,
      targetPath: editedDocx,
      expectedSourceSha256: editableDocxIr.sourceSha256,
      plan: docxPlan,
    });
    assert.deepEqual(docxReport.changedEntries, ["word/document.xml"]);
    assert.equal(docxReport.visualVerificationRequired, true);
    assert.ok(docxReport.preservedEntryCount > 0);
    assert.equal(docxReport.plan.planId, docxPlan.planId);
    const editedDocxIr = await parseDocumentFile(editedDocx);
    assert.ok(editedDocxIr.nodes.some((item) => item.text?.includes("已定位修改的财务证据")));
    assert.deepEqual(
      editedDocxIr.manifest.features.filter((item) => ["comments", "revisions", "footnotes", "images"].includes(item.feature)).map((item) => item.feature).sort(),
      ["comments", "footnotes", "images", "revisions"],
    );

    const editablePptxIr = await parseDocumentFile(pptxPath);
    const shape = editablePptxIr.nodes.find((item) => item.kind === "shape" && item.locator.kind === "node");
    assert.ok(shape && shape.locator.kind === "node");
    const editedPptx = path.join(temporary, "edited.pptx");
    const pptxReport = await applyOfficeDocumentOperations({
      sourcePath: pptxPath,
      targetPath: editedPptx,
      operations: [{ kind: "replace_text", locator: shape.locator, text: "已定位修改的演示文稿" }],
      visualSimilarity: 0.99,
    });
    assert.match(pptxReport.changedEntries[0] ?? "", /^ppt\/slides\/slide\d+\.xml$/);
    assert.equal(pptxReport.visualVerificationRequired, false);
    const editedPptxIr = await parseDocumentFile(editedPptx);
    assert.ok(editedPptxIr.nodes.some((item) => item.text?.includes("已定位修改的演示文稿")));

    await assert.rejects(() => applyOfficeDocumentOperations({
      sourcePath: pdfPath,
      targetPath: path.join(temporary, "edited.pdf"),
      operations: [{ kind: "replace_text", locator: { kind: "page", page: 1 }, text: "禁止" }],
    }), /document_format_read_only:pdf/);
    await assert.rejects(() => applyOfficeDocumentOperations({
      sourcePath: xlsxPath,
      targetPath: path.join(temporary, "edited.xlsx"),
      operations: [{ kind: "replace_text", locator: { kind: "sheet_range", sheet: "资产负债表", range: "A1" }, text: "禁止" }],
    }), /document_format_requires_workbook_patch_engine:xlsx/);
    await assert.rejects(() => applyOfficeDocumentOperations({
      sourcePath: editableDocx,
      targetPath: path.join(temporary, "stale.docx"),
      expectedSourceSha256: "0".repeat(64),
      operations: [{ kind: "replace_text", locator: paragraph.locator, text: "禁止" }],
    }), /document_source_changed/);
    await assert.rejects(() => applyOfficeDocumentOperations({
      sourcePath: editableDocx,
      targetPath: path.join(temporary, "unsupported.docx"),
      operations: [{ kind: "delete_node", locator: paragraph.locator }],
    }), /document_operation_unsupported:docx:delete_node/);
    const stalePlan = structuredClone(docxPlan);
    stalePlan.preconditions[0]!.expectedText = "不存在的旧文本";
    assert.throws(() => assertDocumentPatchPlan(editableDocxIr, stalePlan), /document_patch_precondition_text_mismatch/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  console.log("document-ir tests passed");
})();
