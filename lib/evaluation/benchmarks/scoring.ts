import {
  BenchmarkCaseResultSchema,
  BenchmarkPredictionSchema,
  type BenchmarkCaseResult,
  type BenchmarkCitation,
  type BenchmarkEvaluationOracle,
  type BenchmarkExecutionCase,
  type BenchmarkPrediction,
} from "./contracts";
import { classifyFault } from "@/lib/evaluation/fault-classifier";

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function normalizeSemanticText(value: string): string {
  return normalizeText(value.replace(
    /(?<!\d)(\d{4})(?:[-/.年])(\d{1,2})(?:[-/.月])(\d{1,2})(?:日)?(?!\d)/g,
    (_match, year: string, month: string, day: string) =>
      `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`,
  ))
    .replace(/(?:已经|已)(?=通过|完成|确认|批准|审核|审计)/g, "")
    .replace(/审计(?:结果)?(?:为)?通过/g, "通过审计")
    .replace(/通过了审计/g, "通过审计");
}

export function generalAgentFactContained(answer: string, expected: string): boolean {
  const normalizedAnswer = normalizeSemanticText(answer);
  const normalizedExpected = normalizeSemanticText(expected);
  if (normalizedAnswer.includes(normalizedExpected)) return true;
  if (normalizedExpected.length < 4) return false;

  let start = -1;
  let cursor = 0;
  for (const character of normalizedExpected) {
    const index = normalizedAnswer.indexOf(character, cursor);
    if (index < 0) return false;
    if (start < 0) start = index;
    cursor = index + character.length;
  }
  const span = normalizedAnswer.slice(start, cursor);
  const insertedCharacters = span.length - normalizedExpected.length;
  return insertedCharacters <= Math.max(12, normalizedExpected.length * 2)
    && !/(?:未|没|不|否)/.test(span);
}

function answerTokens(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  return normalized.match(/[\p{Script=Han}]|[\p{L}\p{N}]+(?:[._%/-][\p{L}\p{N}]+)*/gu) ?? [];
}

function tokenF1(predicted: string, expected: string): number {
  const predictedTokens = answerTokens(predicted);
  const expectedTokens = answerTokens(expected);
  if (predictedTokens.length === 0 && expectedTokens.length === 0) return 1;
  if (predictedTokens.length === 0 || expectedTokens.length === 0) return 0;
  const remaining = new Map<string, number>();
  for (const token of expectedTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  let common = 0;
  for (const token of predictedTokens) {
    const count = remaining.get(token) ?? 0;
    if (count <= 0) continue;
    common += 1;
    remaining.set(token, count - 1);
  }
  const precision = common / predictedTokens.length;
  const recall = common / expectedTokens.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function extractNumbers(value: string): number[] {
  return (value.match(/[-+]?\(?\d[\d,]*(?:\.\d+)?\)?%?/g) ?? []).flatMap((raw) => {
    const negativeParentheses = raw.startsWith("(") && raw.endsWith(")");
    const numeric = Number(raw.replace(/[(),%]/g, ""));
    if (!Number.isFinite(numeric)) return [];
    const signed = negativeParentheses ? -numeric : numeric;
    return [raw.includes("%") ? signed / 100 : signed];
  });
}

function numbersEqual(left: number, right: number, absoluteTolerance = 1e-6, relativeTolerance = 1e-4): boolean {
  return Math.abs(left - right) <= Math.max(absoluteTolerance, relativeTolerance * Math.max(1, Math.abs(right)));
}

function numericAccuracy(predicted: number[], expected: number[]): number | null {
  if (expected.length === 0) return null;
  const unused = [...predicted];
  let matched = 0;
  for (const target of expected) {
    const index = unused.findIndex((candidate) => numbersEqual(candidate, target));
    if (index < 0) continue;
    matched += 1;
    unused.splice(index, 1);
  }
  return matched / expected.length;
}

function normalizeLocator(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function citationMatches(predicted: BenchmarkCitation, expected: BenchmarkCitation): boolean {
  if (predicted.sourceId !== expected.sourceId) return false;
  const expectedLocator = normalizeLocator(expected.locator);
  if (!expectedLocator) return true;
  return normalizeLocator(predicted.locator) === expectedLocator;
}

function citationScores(
  predicted: BenchmarkCitation[],
  expected: BenchmarkCitation[],
): { precision: number | null; recall: number | null } {
  if (expected.length === 0) return { precision: null, recall: null };
  const matchedPredictions = predicted.filter((citation) =>
    expected.some((expectedCitation) => citationMatches(citation, expectedCitation))
  ).length;
  const matchedExpectations = expected.filter((citation) =>
    predicted.some((predictedCitation) => citationMatches(predictedCitation, citation))
  ).length;
  return {
    precision: predicted.length === 0 ? 0 : matchedPredictions / predicted.length,
    recall: matchedExpectations / expected.length,
  };
}

function assertionCoverage(prediction: BenchmarkPrediction, oracle: BenchmarkEvaluationOracle): number | null {
  if (oracle.expected.assertions.length === 0) return null;
  if (oracle.expected.artifact) return null;
  const predicted = new Set(prediction.assertions.map(normalizeText));
  const expected = oracle.expected.assertions.map(normalizeText);
  return expected.filter((assertion) => predicted.has(assertion)).length / expected.length;
}

function directModelAuditDetails(prediction: BenchmarkPrediction, answer: string): Record<string, unknown> {
  const details = prediction.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const value = details as Record<string, unknown>;
  if (value.evaluationLayer !== "model") return {};
  return {
    predictedAnswer: answer,
    requestedModel: typeof value.requestedModel === "string" ? value.requestedModel : null,
    actualModel: typeof value.actualModel === "string" ? value.actualModel : null,
  };
}

export function scoreBenchmarkPrediction(
  benchmarkCase: BenchmarkExecutionCase,
  oracle: BenchmarkEvaluationOracle,
  rawPrediction: BenchmarkPrediction,
): BenchmarkCaseResult {
  if (oracle.caseId !== benchmarkCase.id || oracle.datasetId !== benchmarkCase.datasetId) {
    throw new Error("benchmark oracle identity does not match execution case");
  }
  const prediction = BenchmarkPredictionSchema.parse(rawPrediction);
  const failures: string[] = [];
  const answer = prediction.answer ?? "";
  const expectedAnswers = oracle.expected.answers;
  const exactMatch = expectedAnswers.length === 0
    ? null
    : expectedAnswers.some((expected) => normalizeText(answer) === normalizeText(expected)) ? 1 : 0;
  const f1 = expectedAnswers.length === 0
    ? null
    : Math.max(...expectedAnswers.map((expected) => tokenF1(answer, expected)));
  const expectedNumbers = oracle.expected.numericAnswers;
  const numeric = numericAccuracy(extractNumbers(answer), expectedNumbers);
  const citationResult = citationScores(prediction.citations, oracle.expected.citations);
  // General Agent tasks are open-ended summaries, not short-answer QA. A
  // correct answer may include a safety explanation or evidence context around
  // the expected fact; exact match and token-F1 would mark that as a false
  // negative. Keep strict scoring for the finance QA datasets.
  const expectedFactContained = benchmarkCase.datasetId === "general_agent_pilot"
    && expectedAnswers.some((expected) => generalAgentFactContained(answer, expected));

  let artifact: number | null = null;
  if (oracle.expected.artifact) {
    if (!prediction.artifact) {
      artifact = 0;
      failures.push("artifact_missing");
    } else if (prediction.artifact.mediaType !== oracle.expected.artifact.mediaType) {
      artifact = 0;
      failures.push("artifact_media_type_mismatch");
    } else if (prediction.artifact.checks.length === 0) {
      artifact = 0;
      failures.push("artifact_validation_missing");
    } else {
      const checksById = new Map(prediction.artifact.checks.map((check) => [check.id, check]));
      const missingValidators = oracle.expected.artifact.validatorIds.filter((id) => !checksById.has(id));
      const failedChecks = prediction.artifact.checks.filter((check) => check.blocking && !check.passed);
      artifact = failedChecks.length === 0 && missingValidators.length === 0 ? 1 : 0;
      failures.push(...missingValidators.map((id) => `artifact_validator_missing:${id}`));
      failures.push(...failedChecks.map((check) => `artifact_check_failed:${check.id}`));
    }
  }

  const hasExpectedAnswer = expectedAnswers.length > 0 || expectedNumbers.length > 0;
  const answerPassed = !hasExpectedAnswer
    || exactMatch === 1
    || numeric === 1
    || (benchmarkCase.datasetId !== "general_agent_pilot" && (f1 ?? 0) >= 0.8)
    || expectedFactContained;
  if (!answerPassed) failures.push("answer_mismatch");
  if (citationResult.recall !== null && citationResult.recall < 1) failures.push("citation_recall_failed");
  if (citationResult.precision !== null && citationResult.precision < 1) failures.push("citation_precision_failed");
  const assertions = assertionCoverage(prediction, oracle);
  if (assertions !== null && assertions < 1) failures.push("assertion_coverage_failed");
  const expectedDeterministicChecks = oracle.expected.deterministicChecks ?? [];
  const deterministicChecksById = new Map(prediction.deterministicChecks.map((check) => [check.id, check]));
  const missingDeterministicChecks = expectedDeterministicChecks
    .filter(({ id }) => !deterministicChecksById.has(id));
  const failedDeterministicChecks = expectedDeterministicChecks.flatMap(({ id }) => {
    const check = deterministicChecksById.get(id);
    return check && check.blocking && !check.passed ? [check] : [];
  });
  failures.push(...missingDeterministicChecks.map(({ id }) => `deterministic_check_missing:${id}`));
  failures.push(...failedDeterministicChecks.map(({ id }) => `deterministic_check_failed:${id}`));
  if (prediction.failure) failures.unshift(`execution_failure:${prediction.failure.code}`);

  const contract = prediction.failure || failures.length > 0 ? 0 : 1;
  const performance = Math.max(0, 1 - prediction.metrics.retries * 0.1);
  const status = prediction.failure?.source === "evaluator"
    ? "error"
    : failures.length === 0 ? "passed" : "failed";

  let faultDomain: BenchmarkCaseResult["faultDomain"];
  if (prediction.failure) {
    faultDomain = classifyFault(prediction.failure);
  } else if (failures.includes("artifact_validation_missing")) {
    faultDomain = "evaluator";
  } else if (failures.includes("artifact_missing")) {
    faultDomain = "capability";
  } else if (failures.some((failure) => failure.startsWith("artifact_"))) {
    faultDomain = "validator";
  } else if (missingDeterministicChecks.length > 0 || failedDeterministicChecks.length > 0) {
    const failedId = missingDeterministicChecks[0]?.id ?? failedDeterministicChecks[0]?.id;
    faultDomain = expectedDeterministicChecks.find(({ id }) => id === failedId)?.faultDomain ?? "validator";
  } else if (failures.length > 0) {
    faultDomain = "model";
  }

  return BenchmarkCaseResultSchema.parse({
    caseId: benchmarkCase.id,
    datasetId: benchmarkCase.datasetId,
    status,
    ...(faultDomain ? { faultDomain } : {}),
    scores: {
      exactMatch,
      numericAccuracy: numeric,
      tokenF1: f1,
      citationPrecision: citationResult.precision,
      citationRecall: citationResult.recall,
      artifact,
      contract,
      performance,
    },
    failures,
    capabilities: benchmarkCase.capabilities,
    metrics: prediction.metrics,
    details: {
      ...directModelAuditDetails(prediction, answer),
      assertionCoverage: assertions,
      predictedCitations: prediction.citations.map((citation) => ({
        sourceId: citation.sourceId,
        ...(citation.locator ? { locator: citation.locator } : {}),
      })),
      artifactChecks: prediction.artifact?.checks
        .filter((check) => check.blocking && !check.passed)
        .map((check) => ({
          id: check.id,
          passed: check.passed,
          blocking: check.blocking,
          details: check.details,
        })) ?? [],
      deterministicChecks: expectedDeterministicChecks.map(({ id, faultDomain }) => {
        const check = deterministicChecksById.get(id);
        return {
          id,
          passed: check?.passed ?? false,
          blocking: check?.blocking ?? true,
          faultDomain,
          details: check?.details ?? { missing: true },
        };
      }),
    },
  });
}
