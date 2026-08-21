import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  PrincipalRefSchema,
  Sha256Schema,
} from "@/lib/capability/common";

export const BusinessCaseKindSchema = z.enum([
  "general_finance",
  "financial_consolidation",
  "filing_review",
  "treasury_analysis",
  "payroll_tax",
  "due_diligence",
]);
export type BusinessCaseKind = z.infer<typeof BusinessCaseKindSchema>;

export const BusinessNodeKindSchema = z.enum([
  "entity",
  "period",
  "contract",
  "invoice",
  "voucher",
  "obligation",
  "assumption",
  "approval",
  "risk",
]);
export type BusinessNodeKind = z.infer<typeof BusinessNodeKindSchema>;

export const BusinessNodeSchema = z.object({
  id: IdentifierSchema,
  caseId: IdentifierSchema,
  kind: BusinessNodeKindSchema,
  title: z.string().trim().min(1).max(1000),
  status: z.enum(["active", "resolved", "superseded", "canceled"]).default("active"),
  data: JsonValueSchema,
  artifactVersionIds: z.array(IdentifierSchema).default([]),
  evidenceIds: z.array(IdentifierSchema).default([]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict();
export type BusinessNode = z.infer<typeof BusinessNodeSchema>;

export const BusinessEdgeSchema = z.object({
  caseId: IdentifierSchema,
  from: IdentifierSchema,
  to: IdentifierSchema,
  relation: z.enum([
    "belongs_to",
    "covers_period",
    "supports",
    "contradicts",
    "depends_on",
    "settles",
    "approves",
    "exposes",
    "derived_from",
  ]),
  evidenceIds: z.array(IdentifierSchema).default([]),
  createdAt: IsoDateTimeSchema,
}).strict().refine((edge) => edge.from !== edge.to, { message: "business edge cannot reference itself" });
export type BusinessEdge = z.infer<typeof BusinessEdgeSchema>;

export const CaseRunBindingSchema = z.object({
  caseId: IdentifierSchema,
  runId: IdentifierSchema,
  roleId: IdentifierSchema,
  capabilityIds: z.array(IdentifierSchema).min(1),
  state: z.enum(["queued", "running", "waiting_user", "succeeded", "failed", "canceled"]),
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
}).strict();
export type CaseRunBinding = z.infer<typeof CaseRunBindingSchema>;

export const CaseDeadlineSchema = z.object({
  id: IdentifierSchema,
  caseId: IdentifierSchema,
  obligationNodeId: IdentifierSchema,
  dueAt: IsoDateTimeSchema,
  remindAt: IsoDateTimeSchema.optional(),
  status: z.enum(["scheduled", "notified", "completed", "canceled", "overdue"]),
  timezone: z.string().trim().min(1).max(100),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict();
export type CaseDeadline = z.infer<typeof CaseDeadlineSchema>;

export const CaseHistoryEventSchema = z.object({
  id: IdentifierSchema,
  caseId: IdentifierSchema,
  sequence: z.number().int().positive(),
  eventType: IdentifierSchema,
  reason: z.string().trim().min(1).max(5000),
  actor: PrincipalRefSchema,
  runId: IdentifierSchema.optional(),
  decisionId: IdentifierSchema.optional(),
  evidenceIds: z.array(IdentifierSchema).default([]),
  payload: JsonValueSchema,
  previousHash: Sha256Schema.optional(),
  eventHash: Sha256Schema,
  createdAt: IsoDateTimeSchema,
}).strict();
export type CaseHistoryEvent = z.infer<typeof CaseHistoryEventSchema>;

export const HumanDecisionRecordSchema = z.object({
  id: IdentifierSchema,
  caseId: IdentifierSchema,
  specId: IdentifierSchema,
  status: z.enum(["pending", "approved", "rejected", "expired", "canceled"]),
  prompt: z.string().trim().min(1).max(5000),
  answer: JsonValueSchema.optional(),
  requestedAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.optional(),
}).strict();
export type HumanDecisionRecord = z.infer<typeof HumanDecisionRecordSchema>;

export const CaseSnapshotSchema = z.object({
  caseId: IdentifierSchema,
  kind: BusinessCaseKindSchema,
  nodes: z.array(BusinessNodeSchema),
  edges: z.array(BusinessEdgeSchema),
  runs: z.array(CaseRunBindingSchema),
  deadlines: z.array(CaseDeadlineSchema),
  decisions: z.array(HumanDecisionRecordSchema),
  history: z.array(CaseHistoryEventSchema),
  snapshotHash: Sha256Schema,
}).strict();
export type CaseSnapshot = z.infer<typeof CaseSnapshotSchema>;

export const RoleCapabilityViewSchema = z.object({
  caseId: IdentifierSchema,
  roleId: IdentifierSchema,
  capabilityIds: z.array(IdentifierSchema),
  rulePackIds: z.array(IdentifierSchema),
  visibleNodeIds: z.array(IdentifierSchema),
  pendingDecisionIds: z.array(IdentifierSchema),
}).strict();
export type RoleCapabilityView = z.infer<typeof RoleCapabilityViewSchema>;
