import { closeProductionRetrievalService } from "@/lib/retrieval/production";
import { closeDocumentWorkerPool } from "@/lib/resource/document-worker-pool";

export type ProductionBenchmarkRuntimeCleanup = {
  closeRetrieval?: () => Promise<void>;
  closeDocuments?: () => Promise<void>;
};

/** Close process-owned pools used by one-shot benchmark CLI hosts. */
export async function closeProductionBenchmarkRuntime(
  cleanup: ProductionBenchmarkRuntimeCleanup = {},
): Promise<void> {
  const results = await Promise.allSettled([
    (cleanup.closeRetrieval ?? closeProductionRetrievalService)(),
    (cleanup.closeDocuments ?? closeDocumentWorkerPool)(),
  ]);
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, "production benchmark runtime cleanup failed");
  }
}
