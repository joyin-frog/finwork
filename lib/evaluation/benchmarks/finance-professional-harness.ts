import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createSyntheticInputArtifacts } from "./fixture-oracle";
import { partitionBenchmarkCase } from "./case-boundary";
import { createBenchmarkTaskContract } from "./task-contract";
import { runBenchmarkSuite } from "./runner";
import {
  BenchmarkPredictionSchema,
  type BenchmarkRunReportV2,
  type NormalizedBenchmarkCase,
} from "./contracts";

const OUTPUT_VALIDATORS = new Set(["xlsx_generic", "docx_generic", "generic_file"]);

export type FinanceProfessionalCorpusCheck = {
  caseId: string;
  inputSha256: string;
  outputValidatorIds: string[];
};

export async function validateFinanceProfessionalCorpus(
  cases: readonly NormalizedBenchmarkCase[],
  assetsRoot: string,
): Promise<FinanceProfessionalCorpusCheck[]> {
  const root = await fs.realpath(path.resolve(assetsRoot));
  if (cases.length !== 30) throw new Error(`finance_professional_case_count:${cases.length}`);
  return Promise.all(cases.map(async (benchmarkCase) => {
    if (benchmarkCase.datasetId !== "finance_agent_professional") {
      throw new Error(`finance_professional_dataset_mismatch:${benchmarkCase.id}`);
    }
    if (!benchmarkCase.tags.includes("layer:agent")) {
      throw new Error(`finance_professional_layer_missing:${benchmarkCase.id}`);
    }
    if (benchmarkCase.context.files.length === 0) {
      throw new Error(`finance_professional_input_missing:${benchmarkCase.id}`);
    }
    if (benchmarkCase.expected.assertions.length === 0) {
      throw new Error(`finance_professional_business_assertion_missing:${benchmarkCase.id}`);
    }
    if ((benchmarkCase.expected.deterministicChecks?.length ?? 0) === 0) {
      throw new Error(`finance_professional_oracle_missing:${benchmarkCase.id}`);
    }
    const artifact = benchmarkCase.expected.artifact;
    if (!artifact || artifact.validatorIds.some((id) => !OUTPUT_VALIDATORS.has(id))) {
      throw new Error(`finance_professional_file_validator_missing:${benchmarkCase.id}`);
    }

    const inputHashes: string[] = [];
    for (const file of benchmarkCase.context.files) {
      if (!file.upstreamUri || /^[a-z][a-z0-9+.-]*:/i.test(file.upstreamUri)) {
        throw new Error(`finance_professional_input_uri_invalid:${benchmarkCase.id}`);
      }
      const resolved = await fs.realpath(path.resolve(root, file.upstreamUri));
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`finance_professional_input_escape:${benchmarkCase.id}`);
      }
      const bytes = await fs.readFile(resolved);
      if (bytes.byteLength === 0) throw new Error(`finance_professional_input_empty:${benchmarkCase.id}`);
      inputHashes.push(createHash("sha256").update(bytes).digest("hex"));
    }

    const materializedInputs = createSyntheticInputArtifacts(benchmarkCase);
    const partition = partitionBenchmarkCase(benchmarkCase, materializedInputs);
    const serializedExecution = JSON.stringify(partition.executionCase);
    if (serializedExecution.includes('"expected"') || serializedExecution.includes('"deterministicChecks"')) {
      throw new Error(`finance_professional_oracle_shape_leaked:${benchmarkCase.id}`);
    }
    for (const secret of (benchmarkCase.expected.deterministicChecks ?? []).map((item) => item.id)) {
      if (secret && serializedExecution.includes(secret)) {
        throw new Error(`finance_professional_oracle_leaked:${benchmarkCase.id}`);
      }
    }
    const task = createBenchmarkTaskContract(partition.executionCase);
    if (task.missingExternalInputs.length > 0
      || task.contract.inputs.length !== benchmarkCase.context.files.length
      || task.contract.expectedOutputs.length !== 1
      || task.contract.expectedOutputs[0]?.logicalName !== artifact.logicalName) {
      throw new Error(`finance_professional_task_contract_invalid:${benchmarkCase.id}`);
    }
    return {
      caseId: benchmarkCase.id,
      inputSha256: createHash("sha256").update(inputHashes.join(":"), "utf8").digest("hex"),
      outputValidatorIds: [...artifact.validatorIds],
    };
  }));
}

/**
 * Zero-Provider Phase 7 gate. The executor proves only the public TaskContract;
 * the evaluator callback owns private answers, business assertions and checks.
 */
export async function runFinanceProfessionalHarnessSuite(input: {
  cases: readonly NormalizedBenchmarkCase[];
  assetsRoot: string;
  runId?: string;
}): Promise<BenchmarkRunReportV2> {
  const corpusChecks = await validateFinanceProfessionalCorpus(input.cases, input.assetsRoot);
  const checked = new Set(corpusChecks.map((item) => item.caseId));
  const inputArtifactsByCaseId = Object.fromEntries(input.cases.map((benchmarkCase) => [
    benchmarkCase.id,
    createSyntheticInputArtifacts(benchmarkCase),
  ]));
  return runBenchmarkSuite({
    suiteName: "Finwork Finance Agent Professional v1 Layer 1 Harness",
    runId: input.runId,
    cases: input.cases,
    inputArtifactsByCaseId,
    executor: async (executionCase, context) => BenchmarkPredictionSchema.parse({
      answer: "Private evaluator pending.",
      metrics: { wallTimeMs: 0, tokens: 0, retries: 0, toolCalls: 0 },
      details: {
        layer: "harness",
        providerRequests: 0,
        corpusValidated: checked.has(executionCase.id),
        taskContractVersion: context.taskContract.version,
        inputArtifacts: context.taskContract.inputs.length,
        outputContracts: context.taskContract.expectedOutputs.length,
      },
    }),
    validatePrediction: async ({ executionCase, oracle, prediction }) => {
      const corpusValidated = checked.has(executionCase.id);
      return BenchmarkPredictionSchema.parse({
        ...prediction,
        ...(oracle.expected.answers[0] ? { answer: oracle.expected.answers[0] } : {}),
        citations: oracle.expected.citations,
        assertions: oracle.expected.assertions,
        deterministicChecks: (oracle.expected.deterministicChecks ?? []).map(({ id }) => ({
          id,
          passed: corpusValidated,
          blocking: true,
          details: { source: "phase-7-private-corpus-validator" },
        })),
        ...(oracle.expected.artifact ? {
          artifact: {
            mediaType: oracle.expected.artifact.mediaType,
            sha256: "b".repeat(64),
            checks: oracle.expected.artifact.validatorIds.map((id) => ({
              id,
              passed: corpusValidated,
              blocking: true,
              details: { source: "phase-7-output-contract-validator" },
            })),
          },
        } : {}),
      });
    },
    configuration: { kind: "harness", sampleSeed: "finance-professional-v1", maxCases: input.cases.length },
  });
}
