/**
 * Curated production contracts only.
 *
 * A test belongs here when it protects a user-visible result, a security/file
 * boundary, or a deterministic financial validator. Source-text snapshots,
 * retired migration bridges and benchmark scoring live outside this suite.
 */
process.on("unhandledRejection", (error) => {
  console.error("[core.test] unhandledRejection:", error);
  process.exitCode = 1;
});

const cases = [
  "agent-task-spec",
  "model-config",
  "run-contract",
  "transient-provider-retry",
  "memory-v2",
  "role-conventions",
  "retrieval-v2",
  "document-ir",
  "workbook-ir",
  "business-rules",
  "deliverable-quality-gate",
  "financial-consolidation-validator",
  "completion-failure-classification",
  "security-kernel",
  "data-safety",
  "attachment-guard",
  "file-lifecycle",
  "file-workspace",
  "workspace-change-loop",
  "resource-governor",
  "finance-capability-runtime",
  "db-migration-discipline",
  "run-events-persistence",
  "agent-confirm-flow",
  "query-stages",
  "libreoffice-resolver",
  "spreadsheet-probe",
] as const;

async function main() {
  for (const name of cases) {
    const module = await import(`./${name}.test.ts`) as Record<string, unknown>;
    const promise = Object.values(module).find(isPromiseLike);
    if (!promise) throw new Error(`${name}.test.ts must export its test promise`);
    await promise;
  }
  console.log(`core: ${cases.length} production contracts passed ✓`);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

main().catch((error) => {
  console.error("[core.test] failed:", error);
  process.exitCode = 1;
});
