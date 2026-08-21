import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createInspectDocumentStructureTool,
  createPatchDocumentTool,
} from "@/lib/agent/mcp-tools/document-operations";
import type { SdkLike } from "@/lib/agent/mcp-tools/sdk-types";
import { parseDocumentFile } from "@/lib/document-ir";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureSdk(handlers: Map<string, Handler>): SdkLike {
  return {
    tool(name, _description, _schema, handler) {
      handlers.set(name, handler as Handler);
      return { name };
    },
  };
}

export const documentOperationsToolTestPromise = (async () => {
  const root = process.cwd();
  execFileSync(process.execPath, [path.join(root, "scripts", "capability-foundation-fixtures.mjs")], {
    cwd: root,
    stdio: "pipe",
  });
  const fixtureRoot = path.join(root, ".finwork-test", "capability-foundation", "fixtures");
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "finwork-document-tools-"));
  try {
    const handlers = new Map<string, Handler>();
    const sdk = captureSdk(handlers);
    createInspectDocumentStructureTool(sdk, { outputDir, allowedReadRoots: [fixtureRoot] });
    createPatchDocumentTool(sdk, { outputDir, allowedReadRoots: [fixtureRoot] });
    const inspect = handlers.get("inspect_document_structure");
    const patch = handlers.get("patch_document");
    assert.ok(inspect && patch, "document tools must expose handlers");

    const sourcePath = path.join(fixtureRoot, "finance-evidence.docx");
    const sourceBytes = await readFile(sourcePath);
    const inspected = await inspect({ sourcePath, offset: 0, limit: 20 });
    assert.equal(inspected.isError, undefined);
    const structure = JSON.parse(inspected.content[0].text) as {
      format: string;
      sourceSha256: string;
      blocked: boolean;
      page: { returned: number; total: number; nextOffset: number | null };
      nodes: Array<{ text: string | null; locator: Record<string, unknown> }>;
    };
    assert.equal(structure.format, "docx");
    assert.equal(structure.blocked, false);
    assert.match(structure.sourceSha256, /^[a-f0-9]{64}$/);
    assert.ok(structure.page.returned > 0 && structure.page.returned <= 20);
    const paragraph = structure.nodes.find((node) => node.locator.kind === "paragraph" && node.text);
    assert.ok(paragraph, "inspection must return an editable paragraph locator");

    const patched = await patch({
      sourcePath,
      outputName: "finance-evidence-patched.docx",
      expectedSourceSha256: structure.sourceSha256,
      operations: [{ kind: "replace_text", locator: paragraph.locator, text: "已由受控文档工具修改" }],
    });
    assert.equal(patched.isError, undefined);
    const report = JSON.parse(patched.content[0].text) as {
      targetPath: string;
      sourceSha256: string;
      targetSha256: string;
      changedEntries: string[];
      operationCount: number;
      visualVerificationRequired: boolean;
    };
    assert.equal(path.dirname(report.targetPath), outputDir);
    assert.equal(report.sourceSha256, structure.sourceSha256);
    assert.notEqual(report.targetSha256, report.sourceSha256);
    assert.deepEqual(report.changedEntries, ["word/document.xml"]);
    assert.equal(report.operationCount, 1);
    assert.equal(report.visualVerificationRequired, true);
    assert.deepEqual(await readFile(sourcePath), sourceBytes, "source document must never be overwritten");
    const reparsed = await parseDocumentFile(report.targetPath);
    assert.ok(reparsed.nodes.some((node) => node.text?.includes("已由受控文档工具修改")));

    const stale = await patch({
      sourcePath,
      outputName: "stale.docx",
      expectedSourceSha256: "0".repeat(64),
      operations: [{ kind: "replace_text", locator: paragraph.locator, text: "禁止写入" }],
    });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /document_source_changed/);

    const xlsx = await patch({
      sourcePath: path.join(fixtureRoot, "external-linked-workbook.xlsx"),
      outputName: "wrong-engine.xlsx",
      expectedSourceSha256: structure.sourceSha256,
      operations: [{ kind: "replace_text", locator: paragraph.locator, text: "禁止写入" }],
    });
    assert.equal(xlsx.isError, true);
    assert.match(xlsx.content[0].text, /document_format_requires_workbook_patch_engine/);

    const traversal = await inspect({ sourcePath: "/etc/hosts", offset: 0, limit: 10 });
    assert.equal(traversal.isError, true);
    assert.match(traversal.content[0].text, /document_source_outside_allowed_roots/);

    const invalidOutput = await patch({
      sourcePath,
      outputName: "../escape.docx",
      expectedSourceSha256: structure.sourceSha256,
      operations: [{ kind: "replace_text", locator: paragraph.locator, text: "禁止写入" }],
    });
    assert.equal(invalidOutput.isError, true);
    assert.match(invalidOutput.content[0].text, /document_output_name_invalid/);

    console.log("document-operations-tool tests passed");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
})();
