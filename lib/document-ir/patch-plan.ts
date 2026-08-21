import { randomUUID } from "node:crypto";
import type { DocumentLocator } from "@/lib/artifacts/contracts";
import {
  DocumentOperationSchema,
  DocumentPatchPlanSchema,
  type DocumentIr,
  type DocumentNode,
  type DocumentOperation,
  type DocumentPatchPlan,
} from "./contracts";

function locatorKey(locator: DocumentLocator): string {
  return JSON.stringify(locator);
}

function findNode(source: DocumentIr, locator: DocumentLocator): DocumentNode | undefined {
  const key = locatorKey(locator);
  return source.nodes.find((candidate) => locatorKey(candidate.locator) === key);
}

function packageEntryFor(source: DocumentIr, operation: DocumentOperation): string | null {
  if (!("locator" in operation)) return null;
  if (operation.kind !== "replace_text") return null;
  if (source.format === "docx" && operation.locator.kind === "paragraph") return "word/document.xml";
  if (source.format === "pptx" && operation.locator.kind === "node") {
    const match = /^pptx-shape-(\d+)-\d+$/.exec(operation.locator.nodeId);
    return match ? `ppt/slides/slide${match[1]}.xml` : null;
  }
  return null;
}

function rollbackFor(operation: DocumentOperation, current: DocumentNode): DocumentOperation | null {
  if (operation.kind === "replace_text") {
    return { kind: "replace_text", locator: operation.locator, text: current.text ?? "" };
  }
  if (operation.kind === "set_style" && current.style) {
    return { kind: "set_style", locator: operation.locator, style: current.style };
  }
  return null;
}

export function createDocumentPatchPlan(
  source: DocumentIr,
  requestedOperations: readonly DocumentOperation[],
): DocumentPatchPlan {
  const operations = requestedOperations.map((operation) => DocumentOperationSchema.parse(operation));
  if (operations.length === 0) throw new Error("document_operations_required");

  const blockers = [...source.manifest.blockingReasons];
  const preconditions: DocumentPatchPlan["preconditions"] = [];
  const rollbackOperations: DocumentOperation[] = [];
  const nodeIds = new Set<string>();
  const packageEntries = new Set<string>();

  for (const operation of operations) {
    if (!("locator" in operation)) {
      blockers.push(`document_operation_not_plannable:${operation.kind}`);
      continue;
    }
    const current = findNode(source, operation.locator);
    if (!current) {
      blockers.push(`document_locator_stale:${locatorKey(operation.locator)}`);
      continue;
    }
    preconditions.push({
      locator: operation.locator,
      expectedNodeId: current.id,
      expectedKind: current.kind,
      expectedText: current.text ?? null,
    });
    nodeIds.add(current.id);
    const packageEntry = packageEntryFor(source, operation);
    if (packageEntry) packageEntries.add(packageEntry);
    else blockers.push(`document_operation_unsupported:${source.format}:${operation.kind}:${current.kind}`);
    const rollback = rollbackFor(operation, current);
    if (rollback) rollbackOperations.unshift(rollback);
    else blockers.push(`document_rollback_unsupported:${operation.kind}:${current.kind}`);
  }

  return DocumentPatchPlanSchema.parse({
    schemaVersion: 1,
    planId: randomUUID(),
    sourceSha256: source.sourceSha256,
    format: source.format,
    operations,
    preconditions,
    expectedEffects: operations.map((operation) => `${operation.kind}:${"locator" in operation ? locatorKey(operation.locator) : locatorKey(operation.parent)}`),
    impact: {
      nodeIds: [...nodeIds],
      packageEntries: [...packageEntries].sort(),
      preservationFeatures: source.manifest.features.map((item) => item.feature),
      visualVerificationRequired: operations.some((operation) => operation.kind !== "delete_node"),
    },
    rollbackOperations,
    executable: blockers.length === 0 && preconditions.length === operations.length,
    blockers,
  });
}

export function assertDocumentPatchPlan(source: DocumentIr, requestedPlan: DocumentPatchPlan): DocumentPatchPlan {
  const plan = DocumentPatchPlanSchema.parse(requestedPlan);
  if (plan.sourceSha256 !== source.sourceSha256) throw new Error("document_patch_plan_source_changed");
  if (plan.format !== source.format) throw new Error("document_patch_plan_format_mismatch");
  if (!plan.executable || plan.blockers.length > 0) {
    throw new Error(`document_patch_plan_blocked:${plan.blockers.join("|") || "not_executable"}`);
  }
  for (const precondition of plan.preconditions) {
    const current = findNode(source, precondition.locator);
    if (!current || current.id !== precondition.expectedNodeId || current.kind !== precondition.expectedKind) {
      throw new Error(`document_patch_precondition_structure_mismatch:${precondition.expectedNodeId}`);
    }
    if ((current.text ?? null) !== precondition.expectedText) {
      throw new Error(`document_patch_precondition_text_mismatch:${precondition.expectedNodeId}`);
    }
  }
  return plan;
}
