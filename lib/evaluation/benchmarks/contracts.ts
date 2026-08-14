import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema, Sha256Schema } from "@/lib/capability/common";
import { ArtifactRefSchema } from "@/lib/artifacts/contracts";
import { EvidenceRefSchema } from "@/lib/evidence/contracts";
import { FaultDomainSchema } from "@/lib/evaluation/contracts";
import type { TaskContractV3 } from "@/lib/task/contracts";

/** Bump whenever normalized case semantics change, even if upstream bytes do not. */
export const BENCHMARK_NORMALIZER_VERSION = "benchmark-normalizer-v2" as const;

export const BenchmarkDatasetIdSchema = z.enum([
  "finqa",
  "tatqa",
  "convfinqa",
  "financebench",
  "finder",
  "finben",
  "fineval",
  "spreadsheetbench_v2",
  "finagentbench",
  "qfbench",
  "general_agent_pilot",
  "finance_agent_professional",
]);
export type BenchmarkDatasetId = z.infer<typeof BenchmarkDatasetIdSchema>;

export const BenchmarkFamilySchema = z.enum([
  "financial_qa",
  "financial_rag",
  "financial_knowledge",
  "spreadsheet",
  "financial_agent",
  "general_agent",
]);
export type BenchmarkFamily = z.infer<typeof BenchmarkFamilySchema>;

export const BenchmarkTaskKindSchema = z.enum(["qa", "rag", "spreadsheet", "agent"]);
export type BenchmarkTaskKind = z.infer<typeof BenchmarkTaskKindSchema>;

export const BenchmarkSourceFormatSchema = z.enum([
  "finqa",
  "tatqa",
  "convfinqa",
  "financebench",
  "finder",
  "generic_qa",
  "spreadsheetbench",
  "agentbench",
  "general_agent_pilot",
]);
export type BenchmarkSourceFormat = z.infer<typeof BenchmarkSourceFormatSchema>;

export const BenchmarkCapabilitySchema = z.enum([
  "financial_qa",
  "table_reasoning",
  "multi_turn_reasoning",
  "retrieval",
  "citation",
  "financial_knowledge",
  "spreadsheet_understanding",
  "spreadsheet_editing",
  "agent_tool_use",
  "quantitative_finance",
  "due_diligence",
  "policy_compliance",
  "stateful_tool_use",
  "clarification",
  "error_recovery",
  "security_resistance",
]);
export type BenchmarkCapability = z.infer<typeof BenchmarkCapabilitySchema>;

export const BenchmarkDatasetDescriptorSchema = z
  .object({
    id: BenchmarkDatasetIdSchema,
    displayName: z.string().trim().min(1),
    family: BenchmarkFamilySchema,
    taskKind: BenchmarkTaskKindSchema,
    homepage: z.url(),
    upstreamRef: z.string().trim().min(1),
    sourceFormat: BenchmarkSourceFormatSchema,
    license: z
      .object({
        status: z.enum(["verified", "review_required"]),
        spdx: z.string().trim().min(1).optional(),
        note: z.string().trim().min(1),
      })
      .strict(),
    redistribution: z.enum(["external_only", "bundled"]),
    supportedSplits: z.array(z.string().trim().min(1)).min(1),
    defaultLocale: z.string().trim().min(2),
    capabilities: z.array(BenchmarkCapabilitySchema).min(1),
    artifactRequired: z.boolean(),
    adapterStatus: z.enum(["supported", "generic"]),
    integrationStatus: z.enum(["ready", "reference_only"]),
  })
  .strict();
export type BenchmarkDatasetDescriptor = z.infer<typeof BenchmarkDatasetDescriptorSchema>;

const BenchmarkTextBlockSchema = z
  .object({
    id: IdentifierSchema,
    text: z.string(),
    title: z.string().trim().min(1).optional(),
    locator: z.string().trim().min(1).optional(),
  })
  .strict();

const BenchmarkTableSchema = z
  .object({
    id: IdentifierSchema,
    title: z.string().trim().min(1).optional(),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  })
  .strict();

const BenchmarkConversationTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string(),
  })
  .strict();

const BenchmarkFileInputSchema = z
  .object({
    logicalName: z.string().trim().min(1),
    mediaType: z.string().trim().min(1),
    upstreamUri: z.string().trim().min(1).optional(),
    artifactRef: ArtifactRefSchema.optional(),
  })
  .strict();

export const BenchmarkCitationSchema = z
  .object({
    sourceId: IdentifierSchema,
    locator: z.string().trim().min(1).optional(),
    quote: z.string().optional(),
  })
  .strict();
export type BenchmarkCitation = z.infer<typeof BenchmarkCitationSchema>;

export const BenchmarkArtifactExpectationSchema = z
  .object({
    mediaType: z.string().trim().min(1),
    logicalName: z.string().trim().min(1),
    validatorIds: z.array(IdentifierSchema).min(1),
  })
  .strict();
export type BenchmarkArtifactExpectation = z.infer<typeof BenchmarkArtifactExpectationSchema>;

const BenchmarkSpreadsheetOracleSchema = z.object({
  goldenUpstreamUri: z.string().trim().min(1),
  answerRange: z.string().trim().min(1),
  goldenArtifactRef: ArtifactRefSchema.optional(),
}).strict();

const BenchmarkExpectedArtifactSchema = BenchmarkArtifactExpectationSchema.extend({
  oracle: BenchmarkSpreadsheetOracleSchema.optional(),
}).strict();

export const BenchmarkDeterministicExpectationSchema = z.object({
  id: IdentifierSchema,
  faultDomain: FaultDomainSchema,
}).strict();

export const BenchmarkExpectedSchema = z
  .object({
    answers: z.array(z.string()),
    numericAnswers: z.array(z.number().finite()),
    programs: z.array(z.string()),
    citations: z.array(BenchmarkCitationSchema),
    assertions: z.array(z.string().trim().min(1)),
    // Optional to preserve canonical bytes and materialization hashes for v1
    // cases imported before deterministic Agent checks existed.
    deterministicChecks: z.array(BenchmarkDeterministicExpectationSchema).optional(),
    artifact: BenchmarkExpectedArtifactSchema.optional(),
  })
  .strict();
export type BenchmarkExpected = z.infer<typeof BenchmarkExpectedSchema>;

export const NormalizedBenchmarkCaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    datasetId: BenchmarkDatasetIdSchema,
    datasetVersion: IdentifierSchema,
    upstreamCaseId: IdentifierSchema,
    split: IdentifierSchema,
    locale: z.string().trim().min(2),
    taskKind: BenchmarkTaskKindSchema,
    prompt: z.string().trim().min(1),
    context: z
      .object({
        textBlocks: z.array(BenchmarkTextBlockSchema),
        tables: z.array(BenchmarkTableSchema),
        conversation: z.array(BenchmarkConversationTurnSchema),
        files: z.array(BenchmarkFileInputSchema),
      })
      .strict(),
    expected: BenchmarkExpectedSchema,
    capabilities: z.array(BenchmarkCapabilitySchema).min(1),
    tags: z.array(z.string().trim().min(1)),
    provenance: z
      .object({
        sourceSha256: Sha256Schema,
        sourceRecordIndex: z.number().int().nonnegative(),
        homepage: z.url(),
        upstreamRef: z.string().trim().min(1),
        licenseStatus: z.enum(["verified", "review_required"]),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = value.expected;
    if (
      expected.answers.length === 0 &&
      expected.numericAnswers.length === 0 &&
      expected.citations.length === 0 &&
      expected.assertions.length === 0 &&
      (expected.deterministicChecks?.length ?? 0) === 0 &&
      !expected.artifact
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expected"],
        message: "benchmark case requires at least one deterministic expected signal",
      });
    }
  });
export type NormalizedBenchmarkCase = z.infer<typeof NormalizedBenchmarkCaseSchema>;

/**
 * Public, executable requirements derived from a benchmark case. These values
 * describe the shape of the work, never the answer or the assertion values
 * used to score it.
 */
export const BenchmarkExecutionRequirementsSchema = z
  .object({
    requiresSourceEvidence: z.boolean(),
    requiresCitations: z.boolean(),
    artifactOutput: BenchmarkArtifactExpectationSchema.optional(),
  })
  .strict();
export type BenchmarkExecutionRequirements = z.infer<typeof BenchmarkExecutionRequirementsSchema>;

/**
 * The only benchmark case shape an executor may receive. Keep this schema
 * explicit rather than deriving it with omit(), so future private fields on
 * NormalizedBenchmarkCase cannot silently cross the execution boundary.
 */
export const BenchmarkExecutionCaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    datasetId: BenchmarkDatasetIdSchema,
    datasetVersion: IdentifierSchema,
    upstreamCaseId: IdentifierSchema,
    split: IdentifierSchema,
    locale: z.string().trim().min(2),
    taskKind: BenchmarkTaskKindSchema,
    prompt: z.string().trim().min(1),
    context: NormalizedBenchmarkCaseSchema.shape.context,
    inputs: z.array(ArtifactRefSchema),
    capabilities: z.array(BenchmarkCapabilitySchema).min(1),
    tags: z.array(z.string().trim().min(1)),
    provenance: NormalizedBenchmarkCaseSchema.shape.provenance,
    requirements: BenchmarkExecutionRequirementsSchema,
  })
  .strict();
export type BenchmarkExecutionCase = z.infer<typeof BenchmarkExecutionCaseSchema>;

/** Private scorer/validator data. Never pass this object to an executor. */
export const BenchmarkEvaluationOracleSchema = z
  .object({
    caseId: IdentifierSchema,
    datasetId: BenchmarkDatasetIdSchema,
    expected: BenchmarkExpectedSchema,
  })
  .strict();
export type BenchmarkEvaluationOracle = z.infer<typeof BenchmarkEvaluationOracleSchema>;

export const BenchmarkDeterministicCheckSchema = z
  .object({
    id: IdentifierSchema,
    passed: z.boolean(),
    blocking: z.boolean().default(true),
    details: JsonValueSchema.default({}),
  })
  .strict();

export const BenchmarkPredictionSchema = z
  .object({
    answer: z.string().optional(),
    citations: z.array(BenchmarkCitationSchema).default([]),
    artifact: z
      .object({
        path: z.string().trim().min(1).optional(),
        mediaType: z.string().trim().min(1),
        sha256: Sha256Schema.optional(),
        checks: z.array(BenchmarkDeterministicCheckSchema),
      })
      .strict()
      .optional(),
    assertions: z.array(z.string().trim().min(1)).default([]),
    deterministicChecks: z.array(BenchmarkDeterministicCheckSchema).default([]),
    metrics: z
      .object({
        wallTimeMs: z.number().int().nonnegative().default(0),
        tokens: z.number().int().nonnegative().default(0),
        retries: z.number().int().nonnegative().default(0),
        toolCalls: z.number().int().nonnegative().default(0),
      })
      .strict()
      .default({ wallTimeMs: 0, tokens: 0, retries: 0, toolCalls: 0 }),
    failure: z
      .object({
        kind: z.string().trim().min(1),
        code: z.string().trim().min(1),
        source: z.string().trim().min(1).optional(),
        details: JsonValueSchema.default({}),
      })
      .strict()
      .optional(),
    execution: z
      .object({
        traceId: IdentifierSchema,
        caseId: IdentifierSchema,
        taskId: IdentifierSchema,
        runId: IdentifierSchema,
        conversationId: z.number().int().positive().optional(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cacheReadInputTokens: z.number().int().nonnegative().default(0),
        cacheCreationInputTokens: z.number().int().nonnegative().default(0),
        latencyMs: z.number().int().nonnegative(),
        retries: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative().nullable(),
        artifactRefs: z.array(ArtifactRefSchema),
        evidenceRefs: z.array(EvidenceRefSchema),
        validation: z
          .object({
            assertions: z.object({ total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict(),
            delivery: z.object({ required: z.boolean(), delivered: z.number().int().nonnegative(), passed: z.boolean() }).strict(),
          })
          .strict(),
        termination: z.object({ cancelled: z.boolean(), aborted: z.boolean(), timedOut: z.boolean() }).strict(),
        stableFailureCode: z.string().trim().min(1).nullable(),
      })
      .strict()
      .optional(),
    details: JsonValueSchema.default({}),
  })
  .strict();
export type BenchmarkPrediction = z.infer<typeof BenchmarkPredictionSchema>;

export const BenchmarkExecutionSummarySchema = BenchmarkPredictionSchema.shape.execution.unwrap();
export type BenchmarkExecutionSummary = z.infer<typeof BenchmarkExecutionSummarySchema>;

const NullableScoreSchema = z.number().min(0).max(1).nullable();
export const BenchmarkScoresSchema = z
  .object({
    exactMatch: NullableScoreSchema,
    numericAccuracy: NullableScoreSchema,
    tokenF1: NullableScoreSchema,
    citationPrecision: NullableScoreSchema,
    citationRecall: NullableScoreSchema,
    artifact: NullableScoreSchema,
    contract: z.number().min(0).max(1),
    performance: z.number().min(0).max(1),
  })
  .strict();
export type BenchmarkScores = z.infer<typeof BenchmarkScoresSchema>;

export const BenchmarkCaseResultSchema = z
  .object({
    caseId: IdentifierSchema,
    datasetId: BenchmarkDatasetIdSchema,
    status: z.enum(["passed", "failed", "error"]),
    faultDomain: FaultDomainSchema.optional(),
    scores: BenchmarkScoresSchema,
    failures: z.array(z.string()),
    capabilities: z.array(BenchmarkCapabilitySchema),
    metrics: BenchmarkPredictionSchema.shape.metrics,
    details: JsonValueSchema.default({}),
  })
  .strict();
export type BenchmarkCaseResult = z.infer<typeof BenchmarkCaseResultSchema>;

export const BenchmarkRunSourceSchema = z
  .object({
    datasetId: BenchmarkDatasetIdSchema,
    datasetVersion: IdentifierSchema,
    split: IdentifierSchema,
    sourceSha256: Sha256Schema,
    licenseStatus: z.enum(["verified", "review_required"]),
    caseCount: z.number().int().positive(),
  })
  .strict();
export type BenchmarkRunSource = z.infer<typeof BenchmarkRunSourceSchema>;

export const BenchmarkRunReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: IdentifierSchema,
    suiteName: z.string().trim().min(1),
    publishable: z.boolean(),
    fixtureOracle: z.boolean(),
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema,
    sources: z.array(BenchmarkRunSourceSchema).min(1),
    totals: z
      .object({
        cases: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
      })
      .strict(),
    aggregateScores: BenchmarkScoresSchema,
    byDataset: z.partialRecord(
      BenchmarkDatasetIdSchema,
      z.object({ cases: z.number().int().nonnegative(), passed: z.number().int().nonnegative() }).strict(),
    ),
    byCapability: z.partialRecord(
      BenchmarkCapabilitySchema,
      z.object({ cases: z.number().int().nonnegative(), passed: z.number().int().nonnegative() }).strict(),
    ),
    byFaultDomain: z.partialRecord(FaultDomainSchema, z.number().int().nonnegative()),
    results: z.array(BenchmarkCaseResultSchema),
  })
  .strict();
export const BenchmarkProfileSchema = z.enum([
  "connection-smoke",
  "benchmark-smoke",
  "general-agent-pilot",
  "finance-agent-professional",
  "pilot",
  "full",
]);
export type BenchmarkProfile = z.infer<typeof BenchmarkProfileSchema>;
export const BenchmarkEvaluationLayerSchema = z.enum(["mixed", "harness", "agent", "model"]);
export type BenchmarkEvaluationLayer = z.infer<typeof BenchmarkEvaluationLayerSchema>;

export const RealBenchmarkRunConfigSchema = z
  .object({
    kind: z.literal("real"),
    profile: BenchmarkProfileSchema,
    evaluationLayer: BenchmarkEvaluationLayerSchema.optional(),
    fixedModel: z.string().trim().min(1).optional(),
    datasets: z.array(z.object({
      datasetId: BenchmarkDatasetIdSchema,
      split: IdentifierSchema,
      manifestSha256: Sha256Schema,
      sourceSha256: Sha256Schema,
      licenseStatus: z.enum(["verified", "review_required"]),
    }).strict()).min(1),
    sampleSeed: z.string().trim().min(1),
    maxCases: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxWallTimeMs: z.number().int().positive(),
    maxCostUsd: z.number().nonnegative().optional(),
    pricingKnown: z.boolean(),
    consent: z.object({ environmentGate: z.literal(true), cliConfirmed: z.literal(true), explicitBudgets: z.literal(true) }).strict(),
    providerHost: z.string().trim().min(1).regex(/^[a-z0-9.-]+$/i),
    models: z.object({
      fast: z.string().trim().min(1),
      reasoning: z.string().trim().min(1),
    }).strict(),
    modelTierSeparated: z.boolean(),
    commitSha: z.string().trim().min(1),
    runnerVersion: z.string().trim().min(1),
    nodeVersion: z.string().trim().min(1),
    pnpmVersion: z.string().trim().min(1),
    appVersion: z.string().trim().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.pricingKnown && value.maxCostUsd === undefined) {
      ctx.addIssue({ code: "custom", path: ["maxCostUsd"], message: "known pricing requires an explicit USD budget" });
    }
    if ((value.evaluationLayer === "agent" || value.evaluationLayer === "model") && !value.fixedModel) {
      ctx.addIssue({ code: "custom", path: ["fixedModel"], message: `${value.evaluationLayer} evaluation requires one explicit fixed model` });
    }
  });
export type RealBenchmarkRunConfig = z.infer<typeof RealBenchmarkRunConfigSchema>;

export const FixtureBenchmarkRunConfigSchema = z.object({
  kind: z.literal("fixture"),
  sampleSeed: z.string().trim().min(1),
  maxCases: z.number().int().positive(),
}).strict();

export const HarnessBenchmarkRunConfigSchema = z.object({
  kind: z.literal("harness"),
  sampleSeed: z.string().trim().min(1),
  maxCases: z.number().int().positive(),
}).strict();

export const LegacyBenchmarkRunConfigSchema = z.object({ kind: z.literal("legacy-v1") }).strict();
export const BenchmarkRunConfigSnapshotSchema = z.discriminatedUnion("kind", [
  RealBenchmarkRunConfigSchema,
  FixtureBenchmarkRunConfigSchema,
  HarnessBenchmarkRunConfigSchema,
  LegacyBenchmarkRunConfigSchema,
]);
export type BenchmarkRunConfigSnapshot = z.infer<typeof BenchmarkRunConfigSnapshotSchema>;

export const BenchmarkRunSourceV2Schema = BenchmarkRunSourceSchema.extend({ manifestSha256: Sha256Schema }).strict();
export type BenchmarkRunSourceV2 = z.infer<typeof BenchmarkRunSourceV2Schema>;

export const BenchmarkCaseResultV2Schema = BenchmarkCaseResultSchema.extend({
  execution: BenchmarkExecutionSummarySchema,
}).strict();
export type BenchmarkCaseResultV2 = z.infer<typeof BenchmarkCaseResultV2Schema>;

export const BenchmarkRunReportV2Schema = BenchmarkRunReportV1Schema.omit({
  schemaVersion: true,
  sources: true,
  results: true,
}).extend({
  schemaVersion: z.literal(2),
  realApi: z.boolean(),
  configuration: BenchmarkRunConfigSnapshotSchema,
  sources: z.array(BenchmarkRunSourceV2Schema).min(1),
  results: z.array(BenchmarkCaseResultV2Schema),
  runStatus: z.enum(["completed", "stopped"]).optional(),
  stopReason: z.object({
    code: z.string().trim().min(1),
    faultDomain: FaultDomainSchema.optional(),
  }).strict().optional(),
}).strict();
export type BenchmarkRunReportV1 = z.infer<typeof BenchmarkRunReportV1Schema>;
export type BenchmarkRunReportV2 = z.infer<typeof BenchmarkRunReportV2Schema>;

export const BenchmarkRunReportSchema = z.discriminatedUnion("schemaVersion", [
  BenchmarkRunReportV1Schema,
  BenchmarkRunReportV2Schema,
]);
export type BenchmarkRunReport = z.infer<typeof BenchmarkRunReportSchema>;

export const BenchmarkImportManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    normalizerVersion: z.literal(BENCHMARK_NORMALIZER_VERSION),
    datasetId: BenchmarkDatasetIdSchema,
    datasetVersion: IdentifierSchema,
    split: IdentifierSchema,
    sourceSha256: Sha256Schema,
    sourceBytes: z.number().int().nonnegative(),
    sourceRecords: z.number().int().nonnegative(),
    normalizedCases: z.number().int().nonnegative(),
    descriptor: BenchmarkDatasetDescriptorSchema,
    importedAt: IsoDateTimeSchema,
  })
  .strict();
export type BenchmarkImportManifest = z.infer<typeof BenchmarkImportManifestSchema>;

export const BenchmarkMaterializedSourceSchema = z.object({
  sourceId: IdentifierSchema,
  artifactRef: ArtifactRefSchema,
  locator: z.string().trim().min(1),
  retrievalDocumentId: IdentifierSchema.optional(),
}).strict();
export type BenchmarkMaterializedSource = z.infer<typeof BenchmarkMaterializedSourceSchema>;

export const BenchmarkCaseMaterializationSchema = z.object({
  caseId: IdentifierSchema,
  normalizedCaseSha256: Sha256Schema,
  inputArtifacts: z.array(ArtifactRefSchema),
  oracleArtifacts: z.array(ArtifactRefSchema).optional(),
  sources: z.array(BenchmarkMaterializedSourceSchema),
}).strict();
export type BenchmarkCaseMaterialization = z.infer<typeof BenchmarkCaseMaterializationSchema>;

export const BenchmarkMaterializationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  normalizerVersion: z.literal(BENCHMARK_NORMALIZER_VERSION),
  datasetId: BenchmarkDatasetIdSchema,
  datasetVersion: IdentifierSchema,
  split: IdentifierSchema,
  importManifestSha256: Sha256Schema,
  sourceSha256: Sha256Schema,
  licenseStatus: z.enum(["verified", "review_required"]),
  licenseAcknowledged: z.literal(true),
  createdAt: IsoDateTimeSchema,
  cases: z.array(BenchmarkCaseMaterializationSchema).min(1),
}).strict();
export type BenchmarkMaterializationManifest = z.infer<typeof BenchmarkMaterializationManifestSchema>;

export const BenchmarkGapProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    status: z.literal("proposal"),
    dedupeKey: Sha256Schema,
    datasetIds: z.array(BenchmarkDatasetIdSchema).min(1),
    sourceCaseIds: z.array(IdentifierSchema).min(1),
    capability: BenchmarkCapabilitySchema,
    faultDomain: FaultDomainSchema,
    title: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    recommendedFixture: z.string().trim().min(1),
    acceptanceSignals: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();
export type BenchmarkGapProposal = z.infer<typeof BenchmarkGapProposalSchema>;

export interface BenchmarkAdapterContext {
  descriptor: BenchmarkDatasetDescriptor;
  datasetVersion: string;
  split: string;
  sourceSha256: string;
  sourceRecordIndex: number;
}

export interface BenchmarkAdapter {
  readonly format: BenchmarkSourceFormat;
  adapt(record: unknown, context: BenchmarkAdapterContext): NormalizedBenchmarkCase[];
}

export interface BenchmarkExecutionContext {
  signal?: AbortSignal;
  taskContract: TaskContractV3;
  missingExternalInputs: Array<{
    logicalName: string;
    mediaType: string;
    upstreamUri?: string;
  }>;
}

export type BenchmarkExecutor = (
  benchmarkCase: BenchmarkExecutionCase,
  context: BenchmarkExecutionContext,
) => Promise<BenchmarkPrediction>;
