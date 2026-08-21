import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema } from "@/lib/capability/common";
import { TaskContractV3Schema } from "@/lib/task/contracts";

export const EvaluationCaseKindSchema = z.enum([
  "consolidation",
  "tax_payroll",
  "multi_document_rag",
  "web_due_diligence",
]);
export type EvaluationCaseKind = z.infer<typeof EvaluationCaseKindSchema>;

export const FaultDomainSchema = z.enum([
  "model",
  "capability",
  "dependency",
  "validator",
  "policy",
  "resource",
  "evaluator",
]);
export type FaultDomain = z.infer<typeof FaultDomainSchema>;

export const ScoreDimensionSchema = z.enum([
  "contract",
  "artifact",
  "evidence",
  "memory",
  "rag",
  "security",
  "performance",
]);
export type ScoreDimension = z.infer<typeof ScoreDimensionSchema>;

const ScoreDimensionValuesSchema = z.object({
  contract: z.number().min(0).max(1).optional(),
  artifact: z.number().min(0).max(1).optional(),
  evidence: z.number().min(0).max(1).optional(),
  memory: z.number().min(0).max(1).optional(),
  rag: z.number().min(0).max(1).optional(),
  security: z.number().min(0).max(1).optional(),
  performance: z.number().min(0).max(1).optional(),
}).strict();

export const GoldenAssertionSchema = z.object({
  id: IdentifierSchema,
  description: z.string().min(1),
  dimension: ScoreDimensionSchema,
  blocking: z.boolean().default(true),
}).strict();

export const GoldenManifestSchema = z.object({
  id: IdentifierSchema,
  version: IdentifierSchema,
  name: z.string().min(1),
  caseKind: EvaluationCaseKindSchema,
  taskContract: TaskContractV3Schema,
  requiredCapabilities: z.array(IdentifierSchema).min(1),
  expectedEvidenceTypes: z.array(z.enum(["source", "extraction", "transform", "assertion", "delivery"])).min(1),
  assertions: z.array(GoldenAssertionSchema).min(1),
  thresholds: ScoreDimensionValuesSchema,
}).strict();
export type GoldenManifest = z.infer<typeof GoldenManifestSchema>;

export const EvaluationObservationSchema = z.object({
  artifactVersionIds: z.array(IdentifierSchema).default([]),
  evidenceIds: z.array(IdentifierSchema).default([]),
  claimIds: z.array(IdentifierSchema).default([]),
  passedAssertionIds: z.array(IdentifierSchema).default([]),
  metrics: z.record(z.string(), z.number().finite()).default({}),
  dimensions: ScoreDimensionValuesSchema.default({}),
  failure: z.object({ kind: z.string().min(1), code: z.string().min(1), source: z.string().optional() }).strict().optional(),
  details: JsonValueSchema.default({}),
}).strict();
export type EvaluationObservation = z.infer<typeof EvaluationObservationSchema>;

export const EvaluationResultSchema = z.object({
  runId: IdentifierSchema,
  manifestId: IdentifierSchema,
  manifestVersion: IdentifierSchema,
  status: z.enum(["passed", "failed", "error"]),
  faultDomain: FaultDomainSchema.optional(),
  scorecards: z.array(z.object({
    dimension: ScoreDimensionSchema,
    score: z.number().min(0).max(1),
    passed: z.boolean(),
    details: JsonValueSchema,
  }).strict()),
  failures: z.array(z.string()),
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema,
}).strict();
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
