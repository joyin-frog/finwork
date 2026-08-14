import type { ArtifactRef } from "@/lib/artifacts/contracts";
import type {
  BenchmarkEvaluationOracle,
  BenchmarkPrediction,
  NormalizedBenchmarkCase,
} from "./contracts";

const FIXTURE_INPUT_SHA256 = "a".repeat(64);
const FIXTURE_OUTPUT_SHA256 = "b".repeat(64);

export const SYNTHETIC_BENCHMARK_WARNING =
  "Synthetic fixture-oracle results validate benchmark wiring only. They are not model scores and must never be published as capability results.";

export function createSyntheticInputArtifacts(benchmarkCase: NormalizedBenchmarkCase): ArtifactRef[] {
  return benchmarkCase.context.files.map((file, index) => ({
    artifactId: `fixture-input:${benchmarkCase.datasetId}:${index}`,
    versionId: `fixture-input-version:${benchmarkCase.datasetId}:${index}`,
    sha256: FIXTURE_INPUT_SHA256,
    mediaType: file.mediaType,
    logicalName: file.logicalName,
    state: "candidate",
  }));
}

/**
 * Returns expected fixture values so the ingestion, task-contract, scoring,
 * attribution, and reporting pipeline can be tested without a live model.
 * This is intentionally not a BenchmarkExecutor. It only accepts a private
 * evaluation oracle and is reachable through runBenchmarkFixtureSuite().
 */
export type BenchmarkFixtureOracle = (oracle: BenchmarkEvaluationOracle) => Promise<BenchmarkPrediction>;

export function createFixtureOracle(): BenchmarkFixtureOracle {
  return async (oracle) => ({
    ...(oracle.expected.answers[0]
      ? { answer: oracle.expected.answers[0] }
      : oracle.expected.numericAnswers[0] !== undefined
        ? { answer: String(oracle.expected.numericAnswers[0]) }
        : {}),
    citations: oracle.expected.citations,
    assertions: oracle.expected.assertions,
    deterministicChecks: (oracle.expected.deterministicChecks ?? []).map(({ id }) => ({
      id,
      passed: true,
      blocking: true,
      details: { fixtureOracle: true },
    })),
    ...(oracle.expected.artifact
      ? {
          artifact: {
            mediaType: oracle.expected.artifact.mediaType,
            sha256: FIXTURE_OUTPUT_SHA256,
            checks: oracle.expected.artifact.validatorIds.map((id) => ({
              id,
              passed: true,
              blocking: true,
              details: { fixtureOracle: true },
            })),
          },
        }
      : {}),
    metrics: { wallTimeMs: 1, tokens: 0, retries: 0, toolCalls: 0 },
    details: { fixtureOracle: true },
  });
}
