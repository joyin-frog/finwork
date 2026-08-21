import {
  BenchmarkEvaluationOracleSchema,
  BenchmarkExecutionCaseSchema,
  type BenchmarkEvaluationOracle,
  type BenchmarkExecutionCase,
  type NormalizedBenchmarkCase,
} from "./contracts";
import type { ArtifactRef } from "@/lib/artifacts/contracts";

export interface PartitionedBenchmarkCase {
  executionCase: BenchmarkExecutionCase;
  oracle: BenchmarkEvaluationOracle;
}

/**
 * Establishes the one-way privacy boundary between imported benchmark data and
 * production execution. Deliberately copy every public field; do not spread the
 * normalized case or delete private fields after the fact.
 */
export function partitionBenchmarkCase(
  benchmarkCase: NormalizedBenchmarkCase,
  materializedInputs?: readonly ArtifactRef[],
  materializedOracleArtifacts?: readonly ArtifactRef[],
): PartitionedBenchmarkCase {
  const executionCase = BenchmarkExecutionCaseSchema.parse({
    schemaVersion: benchmarkCase.schemaVersion,
    id: benchmarkCase.id,
    datasetId: benchmarkCase.datasetId,
    datasetVersion: benchmarkCase.datasetVersion,
    upstreamCaseId: benchmarkCase.upstreamCaseId,
    split: benchmarkCase.split,
    locale: benchmarkCase.locale,
    taskKind: benchmarkCase.taskKind,
    prompt: benchmarkCase.prompt,
    context: benchmarkCase.context,
    inputs: materializedInputs ?? benchmarkCase.context.files.flatMap((file) => file.artifactRef ? [file.artifactRef] : []),
    capabilities: benchmarkCase.capabilities,
    tags: benchmarkCase.tags,
    provenance: benchmarkCase.provenance,
    requirements: {
      requiresSourceEvidence: Boolean(
        benchmarkCase.context.textBlocks.length ||
        benchmarkCase.context.tables.length ||
        benchmarkCase.context.files.length,
      ),
      requiresCitations: benchmarkCase.expected.citations.length > 0,
      ...(benchmarkCase.expected.artifact
        ? { artifactOutput: {
            mediaType: benchmarkCase.expected.artifact.mediaType,
            logicalName: benchmarkCase.expected.artifact.logicalName,
            validatorIds: benchmarkCase.expected.artifact.validatorIds.filter((id) => id !== "spreadsheetbench_v2_cells"),
          } }
        : {}),
    },
  });
  const oracle = BenchmarkEvaluationOracleSchema.parse({
    caseId: benchmarkCase.id,
    datasetId: benchmarkCase.datasetId,
    expected: benchmarkCase.expected.artifact?.oracle && materializedOracleArtifacts?.[0]
      ? {
          ...benchmarkCase.expected,
          artifact: {
            ...benchmarkCase.expected.artifact,
            oracle: {
              ...benchmarkCase.expected.artifact.oracle,
              goldenArtifactRef: materializedOracleArtifacts[0],
            },
          },
        }
      : benchmarkCase.expected,
  });
  return { executionCase, oracle };
}
