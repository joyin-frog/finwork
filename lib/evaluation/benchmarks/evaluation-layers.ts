import { z } from "zod";
import {
  BenchmarkEvaluationLayerSchema,
  NormalizedBenchmarkCaseSchema,
  type BenchmarkEvaluationLayer,
  type NormalizedBenchmarkCase,
} from "./contracts";

const AGENT_CAPABILITIES = new Set([
  "retrieval",
  "citation",
  "spreadsheet_understanding",
  "spreadsheet_editing",
  "agent_tool_use",
  "due_diligence",
  "policy_compliance",
  "stateful_tool_use",
  "clarification",
  "error_recovery",
  "security_resistance",
]);

/**
 * Layer 2 owns tasks whose success depends on tools, governed evidence or an
 * immutable deliverable. Layer 3 owns answer-only reasoning cases. The sets are
 * deliberately disjoint so a model score cannot be mistaken for Agent quality.
 */
export function caseBelongsToEvaluationLayer(
  benchmarkCase: NormalizedBenchmarkCase,
  layer: BenchmarkEvaluationLayer,
): boolean {
  const parsed = BenchmarkEvaluationLayerSchema.parse(layer);
  const harnessOnly = benchmarkCase.tags.includes("layer:harness");
  if (parsed === "harness") return harnessOnly;
  if (harnessOnly) return false;
  const agentic = benchmarkCase.taskKind !== "qa"
    || Boolean(benchmarkCase.expected.artifact)
    || benchmarkCase.capabilities.some((capability) => AGENT_CAPABILITIES.has(capability));
  return parsed === "agent" ? agentic : !agentic;
}

export function selectCasesForEvaluationLayer(
  cases: readonly NormalizedBenchmarkCase[],
  layer: BenchmarkEvaluationLayer,
): NormalizedBenchmarkCase[] {
  return cases.filter((benchmarkCase) => caseBelongsToEvaluationLayer(benchmarkCase, layer));
}

/**
 * Layer 3 evaluates answer reasoning only. Imported QA records may still carry
 * source locators for Layer 2 provenance scoring; remove those Agent-only
 * expectations from a copied case before building the direct-model contract
 * and oracle. The normalized import remains immutable.
 */
export function prepareCasesForEvaluationLayer(
  cases: readonly NormalizedBenchmarkCase[],
  layer: BenchmarkEvaluationLayer,
): NormalizedBenchmarkCase[] {
  const parsed = BenchmarkEvaluationLayerSchema.parse(layer);
  const selected = selectCasesForEvaluationLayer(cases, parsed);
  if (parsed !== "model") return selected;
  return selected.map((benchmarkCase) => NormalizedBenchmarkCaseSchema.parse({
    ...benchmarkCase,
    expected: {
      ...benchmarkCase.expected,
      citations: [],
      assertions: [],
    },
  }));
}

export const ModelMatrixPlanSchema = z.object({
  layer: z.literal("model"),
  repetitions: z.number().int().min(2),
  candidates: z.array(z.string().trim().min(1)).min(2),
  cases: z.array(z.string().trim().min(1)).min(1),
  runs: z.array(z.object({
    model: z.string().trim().min(1),
    repetition: z.number().int().positive(),
    caseId: z.string().trim().min(1),
  }).strict()).min(1),
}).strict();
export type ModelMatrixPlan = z.infer<typeof ModelMatrixPlanSchema>;

/** Build-only planner: creating a matrix never sends provider requests. */
export function createModelMatrixPlan(input: {
  candidates: readonly string[];
  repetitions: number;
  cases: readonly NormalizedBenchmarkCase[];
}): ModelMatrixPlan {
  const candidates = [...new Set(input.candidates.map((value) => value.trim()).filter(Boolean))];
  const cases = selectCasesForEvaluationLayer(input.cases, "model").map((benchmarkCase) => benchmarkCase.id);
  const runs = candidates.flatMap((model) =>
    Array.from({ length: input.repetitions }, (_, index) =>
      cases.map((caseId) => ({ model, repetition: index + 1, caseId })),
    ).flat(),
  );
  return ModelMatrixPlanSchema.parse({
    layer: "model",
    candidates,
    repetitions: input.repetitions,
    cases,
    runs,
  });
}
