import { z } from "zod";
import { IdentifierSchema, JsonValueSchema } from "./common";
import { ResourceEstimateSchema } from "@/lib/resource/contracts";

export const FailureKindSchema = z.enum([
  "invalid_input",
  "capability_missing",
  "dependency_unavailable",
  "permission_denied",
  "policy_blocked",
  "resource_exhausted",
  "transient_external_failure",
  "deterministic_validation_failed",
  "human_decision_required",
  "canceled",
  "internal_error",
]);
export type FailureKind = z.infer<typeof FailureKindSchema>;

export const CapabilityFailureSchema = z
  .object({
    kind: FailureKindSchema,
    code: IdentifierSchema,
    message: z.string().trim().min(1).max(4000),
    retryable: z.boolean(),
    details: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict()
  .superRefine((failure, ctx) => {
    const mayRetry = failure.kind === "transient_external_failure";
    if (failure.retryable !== mayRetry) {
      ctx.addIssue({
        code: "custom",
        message: mayRetry
          ? "transient_external_failure must be marked retryable"
          : `${failure.kind} must not be marked retryable`,
        path: ["retryable"],
      });
    }
  });
export type CapabilityFailure = z.infer<typeof CapabilityFailureSchema>;

export const CapabilityExecutionResultSchema = <T extends z.ZodTypeAny>(outputSchema: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), output: outputSchema }).strict(),
    z.object({ ok: z.literal(false), failure: CapabilityFailureSchema }).strict(),
  ]);

export const CapabilityPreconditionSchema = z
  .object({ id: IdentifierSchema, description: z.string().trim().min(1), blocking: z.boolean().default(true) })
  .strict();

export const SideEffectDeclarationSchema = z
  .object({
    kind: z.enum(["none", "read", "write", "delete", "network", "external_action"]),
    target: z.string().trim().min(1),
    reversible: z.boolean(),
  })
  .strict();

export const PermissionRequirementSchema = z
  .object({ action: IdentifierSchema, resourceType: IdentifierSchema, scope: z.string().trim().min(1) })
  .strict();

export const EvidenceDeclarationSchema = z
  .object({
    type: z.enum(["source", "extraction", "transform", "assertion", "delivery"]),
    requiresLocator: z.boolean(),
  })
  .strict();

export const ValidatorRefSchema = z
  .object({ id: IdentifierSchema, version: IdentifierSchema, blocking: z.boolean().default(true) })
  .strict();

export const IdempotencyContractSchema = z
  .object({
    mode: z.enum(["none", "input_hash", "explicit_key"]),
    keyField: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((contract, ctx) => {
    if (contract.mode === "explicit_key" && !contract.keyField) {
      ctx.addIssue({ code: "custom", message: "explicit_key requires keyField", path: ["keyField"] });
    }
    if (contract.mode !== "explicit_key" && contract.keyField) {
      ctx.addIssue({ code: "custom", message: "keyField is only valid for explicit_key", path: ["keyField"] });
    }
  });

export const FailureSemanticsSchema = z
  .object({
    declaredKinds: z.array(FailureKindSchema).min(1),
    retryableKinds: z.array(FailureKindSchema).default([]),
    maxAttempts: z.number().int().positive().max(20).default(1),
    backoffMs: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((semantics, ctx) => {
    for (const kind of semantics.retryableKinds) {
      if (kind !== "transient_external_failure") {
        ctx.addIssue({
          code: "custom",
          message: "only transient_external_failure may be retryable",
          path: ["retryableKinds"],
        });
      }
      if (!semantics.declaredKinds.includes(kind)) {
        ctx.addIssue({ code: "custom", message: `${kind} must also be declared`, path: ["declaredKinds"] });
      }
    }
    if (semantics.retryableKinds.length === 0 && semantics.maxAttempts !== 1) {
      ctx.addIssue({ code: "custom", message: "non-retryable capabilities must use maxAttempts=1", path: ["maxAttempts"] });
    }
  });

export const CapabilityManifestSchema = z
  .object({
    id: IdentifierSchema,
    version: IdentifierSchema,
    title: z.string().trim().min(1).max(500),
    inputSchemaId: IdentifierSchema,
    outputSchemaId: IdentifierSchema,
    preconditions: z.array(CapabilityPreconditionSchema),
    sideEffects: z.array(SideEffectDeclarationSchema),
    requiredPermissions: z.array(PermissionRequirementSchema),
    evidenceProduced: z.array(EvidenceDeclarationSchema),
    resourceEstimate: ResourceEstimateSchema,
    validators: z.array(ValidatorRefSchema),
    failureSemantics: FailureSemanticsSchema,
    idempotency: IdempotencyContractSchema,
    metadata: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.failureSemantics.retryableKinds.length > 0 && manifest.idempotency.mode === "none") {
      ctx.addIssue({
        code: "custom",
        message: "automatic retry requires an idempotency contract",
        path: ["idempotency"],
      });
    }
  });
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

export type CapabilityExecutionContext = {
  runId: string;
  caseId?: string;
  attemptId: string;
  signal: AbortSignal;
};

export type CapabilityHandler<I, O> = (input: I, context: CapabilityExecutionContext) => Promise<O>;

export type CapabilityValidator<O = unknown> = (
  output: O,
  context: CapabilityExecutionContext,
) => Promise<void> | void;

export type CapabilityDefinition<I = unknown, O = unknown> = CapabilityManifest & {
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  handler: CapabilityHandler<I, O>;
  /** Runtime implementations keyed by the manifest validator id. */
  validatorHandlers?: Record<string, CapabilityValidator<O>>;
};
