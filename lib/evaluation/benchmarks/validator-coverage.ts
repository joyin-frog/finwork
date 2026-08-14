import type { NormalizedBenchmarkCase } from "./contracts";
import { GENERAL_AGENT_PRODUCTION_VALIDATOR_IDS } from "./general-agent-oracle";

// Production deterministic validators must be added here only after they derive
// their result from persisted runtime state. Model prose and self-report do not
// qualify. The Pilot intentionally starts empty so preview exposes the missing
// Harness coverage before any paid case can run.
const PRODUCTION_DETERMINISTIC_VALIDATORS: ReadonlySet<string> = GENERAL_AGENT_PRODUCTION_VALIDATOR_IDS;

export type MissingBenchmarkValidator = { caseId: string; validatorId: string };

export function findMissingProductionBenchmarkValidators(
  cases: readonly NormalizedBenchmarkCase[],
): MissingBenchmarkValidator[] {
  return cases.flatMap((benchmarkCase) =>
    (benchmarkCase.expected.deterministicChecks ?? []).flatMap(({ id }) =>
      PRODUCTION_DETERMINISTIC_VALIDATORS.has(id)
        ? []
        : [{ caseId: benchmarkCase.id, validatorId: id }]
    )
  );
}

export function assertProductionBenchmarkValidatorCoverage(
  cases: readonly NormalizedBenchmarkCase[],
): void {
  const missing = findMissingProductionBenchmarkValidators(cases);
  if (missing.length === 0) return;
  const first = missing[0]!;
  throw new Error(
    `benchmark_production_validator_coverage_missing:${missing.length}:${first.caseId}:${first.validatorId}`,
  );
}
