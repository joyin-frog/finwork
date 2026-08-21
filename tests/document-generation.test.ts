import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateDocx, type DocumentReport } from "@/lib/document-generation";
import { parseDocumentFile } from "@/lib/document-ir";
import { validateDocxFile } from "@/lib/deliverable/validators/docx";

const report: DocumentReport = {
  schemaVersion: 1,
  title: "薪税申报复核",
  subtitle: "确定性交付测试",
  metadata: [
    { label: "主体", value: "测试企业" },
    { label: "期间", value: "2026-07" },
  ],
  sections: [{
    id: "review",
    heading: "复核结论",
    paragraphs: ["申报资料已完成结构化复核。"],
    tables: [{
      caption: "规则结果",
      columns: ["规则", "状态"],
      rows: [["税率基础校验", "通过"], ["薪资基础校验", "通过"]],
    }],
  }],
  footer: "由 Finwork 生成",
};

export const documentGenerationTestPromise = (async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "finwork-document-generation-"));
  try {
    const first = await generateDocx({ report, outputRoot: root, outputName: "first.docx" });
    const second = await generateDocx({ report, outputRoot: root, outputName: "second.docx" });
    assert.equal(first.sha256, second.sha256, "same semantic report must produce byte-identical DOCX");
    assert.deepEqual(await readFile(first.outputPath), await readFile(second.outputPath));

    const validation = await validateDocxFile({
      filePath: first.outputPath,
      fileName: "first.docx",
      expectedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      expectedSha256: first.sha256,
      qualityProfile: "generic",
    });
    assert.equal(validation.status, "passed", JSON.stringify(validation, null, 2));
    const parsed = await parseDocumentFile(first.outputPath, "docx");
    const text = parsed.nodes.map((node) => node.text ?? "").join("\n");
    assert.match(text, /薪税申报复核/);
    assert.match(text, /申报资料已完成结构化复核/);
    assert.ok(parsed.nodes.some((node) => node.kind === "table" && node.text?.includes("税率基础校验")));

    await assert.rejects(
      () => generateDocx({ report, outputRoot: root, outputName: "../escaped.docx" }),
      /document_generation_invalid_output_name/,
    );
    await assert.rejects(
      () => generateDocx({ report, outputRoot: root, outputName: "first.docx" }),
      /document_generation_output_exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("document-generation: deterministic generation, path confinement and DOCX round-trip passed ✓");
})();
