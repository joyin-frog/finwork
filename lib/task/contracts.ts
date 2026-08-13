import { z } from "zod";
import { ArtifactRefSchema } from "@/lib/artifacts/contracts";
import {
  CurrencyRefSchema,
  EntityRefSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  PeriodRefSchema,
  UnitRefSchema,
} from "@/lib/capability/common";
import { ResourceBudgetSchema } from "@/lib/resource/contracts";
import { DataHandlingPolicySchema, RetentionPolicySchema } from "@/lib/security/contracts";

export const CapabilityRequirementSchema = z
  .object({
    capabilityId: IdentifierSchema,
    versionRange: z.string().trim().min(1).max(100),
    required: z.boolean().default(true),
  })
  .strict();

export const AssertionSpecSchema = z
  .object({
    id: IdentifierSchema,
    validatorId: IdentifierSchema,
    severity: z.enum(["blocking", "warning"]),
    parameters: JsonValueSchema,
  })
  .strict();

export const OutputContractSchema = z
  .object({
    id: IdentifierSchema,
    mediaType: z.string().trim().min(1),
    logicalName: z.string().trim().min(1).max(1024),
    count: z.number().int().positive().default(1),
    validatorIds: z.array(IdentifierSchema).min(1),
    immutableDelivery: z.boolean().default(true),
  })
  .strict();

export const EvidenceRequirementSchema = z
  .object({
    evidenceType: z.enum(["source", "extraction", "transform", "assertion", "delivery"]),
    minimumCount: z.number().int().positive().default(1),
    requiresLocator: z.boolean().default(false),
  })
  .strict();

export const HumanDecisionSpecSchema = z
  .object({
    id: IdentifierSchema,
    prompt: z.string().trim().min(1).max(5000),
    requiredBeforeCapabilityIds: z.array(IdentifierSchema),
    timeoutMs: z.number().int().positive().nullable().default(null),
  })
  .strict();

export const BusinessContextSchema = z
  .object({
    entities: z.array(EntityRefSchema),
    counterparties: z.array(EntityRefSchema),
    periods: z.array(PeriodRefSchema),
    effectiveDate: z.iso.date().optional(),
    currencies: z.array(CurrencyRefSchema),
    units: z.array(UnitRefSchema),
    accountingStandards: z.array(z.string().trim().min(1)),
    jurisdictions: z.array(z.string().trim().min(1)),
  })
  .strict();

export const TaskContractV3Schema = z
  .object({
    id: IdentifierSchema,
    version: z.literal(3),
    goal: z.string().trim().min(1).max(20_000),
    caseId: IdentifierSchema.optional(),
    businessContext: BusinessContextSchema,
    inputs: z.array(ArtifactRefSchema),
    requiredCapabilities: z.array(CapabilityRequirementSchema),
    invariants: z.array(AssertionSpecSchema),
    expectedOutputs: z.array(OutputContractSchema),
    evidenceRequirements: z.array(EvidenceRequirementSchema),
    humanDecisionPoints: z.array(HumanDecisionSpecSchema),
    noGuess: z.array(z.string().trim().min(1)),
    noDegrade: z.array(z.string().trim().min(1)),
    security: DataHandlingPolicySchema,
    retention: RetentionPolicySchema,
    budget: ResourceBudgetSchema,
  })
  .strict()
  .superRefine((contract, ctx) => {
    const required = new Set(contract.requiredCapabilities.filter((item) => item.required).map((item) => item.capabilityId));
    for (const decision of contract.humanDecisionPoints) {
      for (const capabilityId of decision.requiredBeforeCapabilityIds) {
        if (!required.has(capabilityId)) {
          ctx.addIssue({
            code: "custom",
            message: `human decision references unknown required capability: ${capabilityId}`,
            path: ["humanDecisionPoints"],
          });
        }
      }
    }
  });
export type TaskContractV3 = z.infer<typeof TaskContractV3Schema>;

export const CaseStateSchema = z.enum([
  "draft",
  "waiting_for_input",
  "preflight",
  "planned",
  "running",
  "waiting_for_human",
  "validating",
  "repairing",
  "finalizing",
  "delivered",
  "failed",
  "canceled",
]);
export type CaseState = z.infer<typeof CaseStateSchema>;

export const CaseNodeStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "waiting_for_human",
  "validating",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
]);
export type CaseNodeStatus = z.infer<typeof CaseNodeStatusSchema>;

export const CaseNodeSchema = z
  .object({
    id: IdentifierSchema,
    capabilityId: IdentifierSchema,
    capabilityVersion: IdentifierSchema,
    status: CaseNodeStatusSchema.default("pending"),
    input: JsonValueSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/i),
    idempotencyKey: IdentifierSchema.optional(),
    ordinal: z.number().int().nonnegative(),
  })
  .strict();
export type CaseNode = z.infer<typeof CaseNodeSchema>;

export const CaseEdgeSchema = z
  .object({
    from: IdentifierSchema,
    to: IdentifierSchema,
    type: z.enum(["depends_on", "data", "control"]).default("depends_on"),
  })
  .strict()
  .refine((edge) => edge.from !== edge.to, { message: "case edge cannot reference itself" });
export type CaseEdge = z.infer<typeof CaseEdgeSchema>;

export const CasePlanSchema = z
  .object({
    caseId: IdentifierSchema,
    version: z.number().int().positive(),
    nodes: z.array(CaseNodeSchema).min(1),
    edges: z.array(CaseEdgeSchema),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const node of plan.nodes) {
      if (ids.has(node.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate node id: ${node.id}`, path: ["nodes"] });
      }
      ids.add(node.id);
    }
    for (const edge of plan.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        ctx.addIssue({ code: "custom", message: `edge references unknown node: ${edge.from} -> ${edge.to}`, path: ["edges"] });
      }
    }
  });
export type CasePlan = z.infer<typeof CasePlanSchema>;

export const CaseCheckpointSchema = z
  .object({
    id: IdentifierSchema,
    caseId: IdentifierSchema,
    sequence: z.number().int().positive(),
    state: CaseStateSchema,
    snapshot: JsonValueSchema,
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/i),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type CaseCheckpoint = z.infer<typeof CaseCheckpointSchema>;
