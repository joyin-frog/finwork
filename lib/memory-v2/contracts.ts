import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  PeriodRefSchema,
  PrincipalRefSchema,
} from "@/lib/capability/common";
import { DataClassificationSchema } from "@/lib/security/contracts";

export const MemoryScopeSchema = z
  .object({
    tenantId: IdentifierSchema.optional(),
    principalId: IdentifierSchema.optional(),
    caseId: IdentifierSchema.optional(),
    roleId: IdentifierSchema.optional(),
  })
  .strict()
  .refine((scope) => Object.values(scope).some(Boolean), "memory scope must not be empty");
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

const MemoryRecordV2BaseSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["working", "episodic", "semantic", "procedural", "feedback"]),
    scope: MemoryScopeSchema,
    entityRefs: z.array(IdentifierSchema),
    effectivePeriod: PeriodRefSchema.optional(),
    content: JsonValueSchema,
    sourceEvidenceRefs: z.array(IdentifierSchema).min(1),
    confidence: z.number().min(0).max(1),
    sensitivity: DataClassificationSchema,
    approvalStatus: z.enum(["candidate", "approved", "rejected", "expired", "archived"]),
    supersedes: z.array(IdentifierSchema),
    conflictsWith: z.array(IdentifierSchema),
    createdAt: IsoDateTimeSchema,
    lastUsedAt: IsoDateTimeSchema.optional(),
    expiresAt: IsoDateTimeSchema.optional(),
    owner: PrincipalRefSchema,
  })
  .strict();

export const MemoryRecordV2Schema = MemoryRecordV2BaseSchema
  .superRefine((memory, ctx) => {
    if (memory.kind === "procedural" && memory.approvalStatus === "approved" && memory.sourceEvidenceRefs.length === 0) {
      ctx.addIssue({ code: "custom", message: "approved procedural memory requires evaluation evidence" });
    }
    if (memory.expiresAt && memory.expiresAt <= memory.createdAt) {
      ctx.addIssue({ code: "custom", message: "expiresAt must be after createdAt", path: ["expiresAt"] });
    }
  });
export type MemoryRecordV2 = z.infer<typeof MemoryRecordV2Schema>;

export const MemoryCandidateSchema = z
  .object({
    record: MemoryRecordV2BaseSchema.omit({
      approvalStatus: true,
      supersedes: true,
      conflictsWith: true,
      lastUsedAt: true,
    }),
    conflictKey: IdentifierSchema,
  })
  .strict();
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

export const MemoryRetrievalQuerySchema = z
  .object({
    principal: PrincipalRefSchema,
    tenantId: IdentifierSchema.optional(),
    caseId: IdentifierSchema.optional(),
    roleId: IdentifierSchema.optional(),
    entityRefs: z.array(IdentifierSchema).default([]),
    effectivePeriod: PeriodRefSchema.optional(),
    kinds: z.array(MemoryRecordV2BaseSchema.shape.kind).default([]),
    /** Current task text used only to prove topical relevance. Empty means select nothing. */
    queryText: z.string().trim().max(20_000).default(""),
    maximumSensitivity: DataClassificationSchema.default("confidential"),
    minimumConfidence: z.number().min(0).max(1).default(0),
    limit: z.number().int().positive().max(100).default(20),
    now: IsoDateTimeSchema,
  })
  .strict();
export type MemoryRetrievalQuery = z.infer<typeof MemoryRetrievalQuerySchema>;

export const MemorySelectionSchema = z
  .object({
    memory: MemoryRecordV2Schema,
    summary: z.string().trim().min(1).max(2000),
    evidenceRefs: z.array(IdentifierSchema).min(1),
    score: z.number().min(0).max(1),
    selectionReason: z.string().trim().min(1).max(500),
  })
  .strict();
export type MemorySelection = z.infer<typeof MemorySelectionSchema>;

export const MemoryDeletionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    requestId: IdentifierSchema,
    memoryId: IdentifierSchema,
    proof: z.string().regex(/^[a-f0-9]{64}$/i),
    completedAt: IsoDateTimeSchema,
  }).strict(),
  z.object({
    status: z.literal("retained"),
    requestId: IdentifierSchema,
    memoryId: IdentifierSchema,
    retentionReason: z.string().trim().min(1).max(2000),
  }).strict(),
]);
export type MemoryDeletionResult = z.infer<typeof MemoryDeletionResultSchema>;

/**
 * Runtime retrieval boundary. Callers should pass authoritative tenancy/case/entity
 * facts here instead of letting memory infer them from free-form conversation text.
 */
export const MemoryRuntimeContextSchema = z
  .object({
    tenantId: IdentifierSchema.default("local"),
    principalId: IdentifierSchema.default("local-user"),
    caseId: IdentifierSchema.optional(),
    entityRefs: z.array(IdentifierSchema).default([]),
    effectivePeriod: PeriodRefSchema.optional(),
    /** Latest user request or delegated task. It is never persisted as memory. */
    retrievalText: z.string().trim().max(20_000).default(""),
    maximumSensitivity: DataClassificationSchema.default("confidential"),
  })
  .strict();
export type MemoryRuntimeContext = z.infer<typeof MemoryRuntimeContextSchema>;
