import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import {
  type DocumentDiff,
  type DocumentFormat,
  type DocumentOperation,
  type DocumentPatchPlan,
} from "./contracts";
import { parseDocumentBytes } from "./adapters";
import { assertDocumentPatchPlan, createDocumentPatchPlan } from "./patch-plan";
import { assertPreservationPolicy, diffDocumentIr } from "./round-trip";
import { attributeValue, replaceOoxmlText, tagBlocks } from "./xml";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inferFormat(filePath: string): DocumentFormat {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (!(["docx", "pptx", "pdf", "xlsx"] as string[]).includes(extension)) {
    throw new Error(`document_format_unsupported:${extension || "unknown"}`);
  }
  return extension as DocumentFormat;
}

function replaceNthBlock(xml: string, qualifiedTag: string, index: number, update: (block: string) => string): string {
  const escaped = qualifiedTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi");
  let current = 0;
  let matched = false;
  const result = xml.replace(expression, (block) => {
    current += 1;
    if (current !== index) return block;
    matched = true;
    return update(block);
  });
  if (!matched) throw new Error(`document_locator_stale:${qualifiedTag}:${index}`);
  return result;
}

async function applyDocxOperation(zip: JSZip, operation: DocumentOperation): Promise<string> {
  if (operation.kind !== "replace_text") throw new Error(`document_operation_unsupported:docx:${operation.kind}`);
  if (operation.locator.kind !== "paragraph") throw new Error("document_locator_unsupported:docx:paragraph_required");
  const match = /^docx-paragraph-(\d+)$/.exec(operation.locator.nodeId);
  if (!match) throw new Error(`document_locator_invalid:${operation.locator.nodeId}`);
  const entry = "word/document.xml";
  const xml = await zip.file(entry)?.async("text");
  if (xml === undefined) throw new Error(`document_package_invalid:missing:${entry}`);
  zip.file(entry, replaceNthBlock(xml, "w:p", Number(match[1]), (block) => replaceOoxmlText(block, "w:t", operation.text)));
  return entry;
}

async function applyPptxOperation(zip: JSZip, operation: DocumentOperation): Promise<string> {
  if (operation.kind !== "replace_text") throw new Error(`document_operation_unsupported:pptx:${operation.kind}`);
  if (operation.locator.kind !== "node") throw new Error("document_locator_unsupported:pptx:shape_required");
  const match = /^pptx-shape-(\d+)-(\d+)$/.exec(operation.locator.nodeId);
  if (!match) throw new Error(`document_locator_invalid:${operation.locator.nodeId}`);
  const [, slideNumber, shapeId] = match;
  const entry = `ppt/slides/slide${slideNumber}.xml`;
  const xml = await zip.file(entry)?.async("text");
  if (xml === undefined) throw new Error(`document_package_invalid:missing:${entry}`);
  let found = false;
  const updated = xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/gi, (block) => {
    const cNvPr = block.match(/<p:cNvPr\b[^>]*>/i)?.[0] ?? "";
    if (attributeValue(cNvPr, "id") !== shapeId) return block;
    found = true;
    return replaceOoxmlText(block, "a:t", operation.text);
  });
  if (!found) throw new Error(`document_locator_stale:${operation.locator.nodeId}`);
  zip.file(entry, updated);
  return entry;
}

async function entryHashes(zip: JSZip): Promise<Map<string, string>> {
  const entries = await Promise.all(Object.entries(zip.files).map(async ([name, entry]) => {
    if (entry.dir) return [name, "directory"] as const;
    return [name, sha256(await entry.async("uint8array"))] as const;
  }));
  return new Map(entries);
}

export interface ApplyOfficeOperationsInput {
  sourcePath: string;
  targetPath: string;
  operations?: readonly DocumentOperation[];
  plan?: DocumentPatchPlan;
  expectedSourceSha256?: string;
  visualSimilarity?: number | null;
}

export interface OfficePatchReport {
  format: "docx" | "pptx";
  sourceSha256: string;
  targetSha256: string;
  changedEntries: string[];
  preservedEntryCount: number;
  operationCount: number;
  plan: DocumentPatchPlan;
  diff: DocumentDiff;
  visualVerificationRequired: boolean;
}

/**
 * Apply verified, locator-based OOXML edits. Unsupported formats and
 * operations are blocked instead of being rewritten through a lossy library.
 */
export async function applyOfficeDocumentOperations(input: ApplyOfficeOperationsInput): Promise<OfficePatchReport> {
  const format = inferFormat(input.sourcePath);
  if (format === "pdf") throw new Error("document_format_read_only:pdf");
  if (format === "xlsx") throw new Error("document_format_requires_workbook_patch_engine:xlsx");
  if (path.resolve(input.sourcePath) === path.resolve(input.targetPath)) throw new Error("document_target_must_not_overwrite_source");
  const sourceBytes = await readFile(input.sourcePath);
  const sourceSha256 = sha256(sourceBytes);
  if (input.expectedSourceSha256 && input.expectedSourceSha256 !== sourceSha256) {
    throw new Error(`document_source_changed:${input.expectedSourceSha256}:${sourceSha256}`);
  }
  const sourceIr = await parseDocumentBytes(format, sourceBytes);
  assertPreservationPolicy(sourceIr.manifest);
  if (input.plan && input.operations) throw new Error("document_patch_plan_and_operations_are_mutually_exclusive");
  const plan = input.plan
    ? assertDocumentPatchPlan(sourceIr, input.plan)
    : createDocumentPatchPlan(sourceIr, input.operations ?? []);
  assertDocumentPatchPlan(sourceIr, plan);
  const operations = plan.operations;
  const sourceZip = await JSZip.loadAsync(sourceBytes);
  const sourceEntries = await entryHashes(sourceZip);
  const changedEntries = new Set<string>();
  for (const operation of operations) {
    changedEntries.add(format === "docx"
      ? await applyDocxOperation(sourceZip, operation)
      : await applyPptxOperation(sourceZip, operation));
  }
  const targetBytes = await sourceZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const targetZip = await JSZip.loadAsync(targetBytes);
  const targetEntries = await entryHashes(targetZip);
  if (sourceEntries.size !== targetEntries.size) throw new Error("document_preservation_failed:package_entry_count_changed");
  let preservedEntryCount = 0;
  for (const [entry, sourceHash] of sourceEntries) {
    const targetHash = targetEntries.get(entry);
    if (targetHash === undefined) throw new Error(`document_preservation_failed:entry_removed:${entry}`);
    if (changedEntries.has(entry)) {
      if (targetHash === sourceHash) throw new Error(`document_operation_no_effect:${entry}`);
      continue;
    }
    if (targetHash !== sourceHash) throw new Error(`document_preservation_failed:entry_changed:${entry}`);
    preservedEntryCount += 1;
  }

  await mkdir(path.dirname(input.targetPath), { recursive: true });
  const temporary = `${input.targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, targetBytes);
    await rename(temporary, input.targetPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const targetIr = await parseDocumentBytes(format, targetBytes);
  const visualSimilarity = input.visualSimilarity ?? null;
  return {
    format,
    sourceSha256,
    targetSha256: sha256(targetBytes),
    changedEntries: [...changedEntries].sort(),
    preservedEntryCount,
    operationCount: operations.length,
    plan,
    diff: diffDocumentIr(sourceIr, targetIr, visualSimilarity),
    visualVerificationRequired: visualSimilarity === null,
  };
}
