import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, PrincipalRefSchema } from "@/lib/capability/common";

export const DataClassificationSchema = z.enum(["public", "internal", "confidential", "restricted"]);
export type DataClassification = z.infer<typeof DataClassificationSchema>;

export const DataHandlingPolicySchema = z
  .object({
    classification: DataClassificationSchema,
    allowedPrincipals: z.array(PrincipalRefSchema).min(1),
    allowExternalEgress: z.boolean().default(false),
    allowedDomains: z.array(z.string().trim().min(1)).default([]),
    requireEncryptionAtRest: z.boolean().default(true),
    requireHumanApprovalForExport: z.boolean().default(false),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (!policy.allowExternalEgress && policy.allowedDomains.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "allowedDomains requires allowExternalEgress=true",
        path: ["allowedDomains"],
      });
    }
  });
export type DataHandlingPolicy = z.infer<typeof DataHandlingPolicySchema>;

export const RetentionPolicySchema = z
  .object({
    policyId: IdentifierSchema,
    retainUntil: IsoDateTimeSchema.optional(),
    legalHold: z.boolean().default(false),
    allowUserDeletionRequest: z.boolean().default(true),
    gracePeriodDays: z.number().int().nonnegative().max(3650).default(30),
  })
  .strict();
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const PolicyDecisionSchema = z
  .object({
    id: IdentifierSchema,
    principal: PrincipalRefSchema,
    caseId: IdentifierSchema.optional(),
    capabilityId: IdentifierSchema,
    artifactVersionIds: z.array(IdentifierSchema).default([]),
    classification: DataClassificationSchema,
    egress: z.boolean(),
    decision: z.enum(["allow", "deny", "require_approval"]),
    reason: z.string().trim().min(1).max(2000),
    expiresAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const SecurityTaintSchema = z.enum([
  "untrusted_input",
  "prompt_injection",
  "personal_data",
  "financial_data",
  "secret",
  "malware_suspected",
]);
export type SecurityTaint = z.infer<typeof SecurityTaintSchema>;

export const SecurityActionSchema = z.enum([
  "read",
  "write",
  "delete",
  "execute",
  "network",
  "export",
  "admin",
]);
export type SecurityAction = z.infer<typeof SecurityActionSchema>;

export const SecurityAclGrantSchema = z.object({
  id: IdentifierSchema,
  principal: PrincipalRefSchema,
  tenantId: IdentifierSchema,
  caseId: IdentifierSchema.optional(),
  artifactVersionId: IdentifierSchema.optional(),
  capabilityId: IdentifierSchema.optional(),
  actions: z.array(SecurityActionSchema).min(1),
  expiresAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
}).strict();
export type SecurityAclGrant = z.infer<typeof SecurityAclGrantSchema>;

export const EgressGrantSchema = z.object({
  id: IdentifierSchema,
  principal: PrincipalRefSchema,
  tenantId: IdentifierSchema,
  caseId: IdentifierSchema.optional(),
  capabilityId: IdentifierSchema,
  domain: z.string().trim().toLowerCase().min(1).max(253),
  expiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
}).strict();
export type EgressGrant = z.infer<typeof EgressGrantSchema>;

export const SecurityAuthorizationRequestSchema = z.object({
  principal: PrincipalRefSchema,
  tenantId: IdentifierSchema,
  caseId: IdentifierSchema.optional(),
  capabilityId: IdentifierSchema,
  action: SecurityActionSchema,
  artifactVersionId: IdentifierSchema.optional(),
  classification: DataClassificationSchema.default("internal"),
  taints: z.array(SecurityTaintSchema).default([]),
  destinationDomain: z.string().trim().toLowerCase().min(1).max(253).optional(),
  approvalId: IdentifierSchema.optional(),
  now: IsoDateTimeSchema,
}).strict().superRefine((request, ctx) => {
  if (["network", "export"].includes(request.action) && !request.destinationDomain) {
    ctx.addIssue({ code: "custom", message: `${request.action} authorization requires destinationDomain`, path: ["destinationDomain"] });
  }
  if (request.action === "export" && !request.artifactVersionId) {
    ctx.addIssue({ code: "custom", message: "export authorization requires artifactVersionId", path: ["artifactVersionId"] });
  }
});
export type SecurityAuthorizationRequest = z.infer<typeof SecurityAuthorizationRequestSchema>;

export const SecurityDecisionSchema = z.object({
  id: IdentifierSchema,
  decision: z.enum(["allow", "deny", "require_approval"]),
  code: IdentifierSchema,
  reason: z.string().trim().min(1).max(4000),
  matchedGrantIds: z.array(IdentifierSchema).default([]),
  obligations: z.array(z.string().trim().min(1)).default([]),
  createdAt: IsoDateTimeSchema,
}).strict();
export type SecurityDecision = z.infer<typeof SecurityDecisionSchema>;

export const SecretLeaseSchema = z.object({
  id: IdentifierSchema,
  secretId: IdentifierSchema,
  principal: PrincipalRefSchema,
  capabilityId: IdentifierSchema,
  destinationDomain: z.string().trim().toLowerCase().min(1).max(253),
  expiresAt: IsoDateTimeSchema,
  remainingUses: z.number().int().positive(),
  createdAt: IsoDateTimeSchema,
}).strict();
export type SecretLease = z.infer<typeof SecretLeaseSchema>;

export const QuarantineVerdictSchema = z.enum(["pending", "clean", "malicious", "scan_failed", "policy_blocked"]);
export type QuarantineVerdict = z.infer<typeof QuarantineVerdictSchema>;

export const FileSafetyFindingSchema = z.object({
  code: z.enum([
    "malformed_archive",
    "zip64_unsupported",
    "encrypted_archive",
    "archive_path_traversal",
    "archive_entry_limit",
    "archive_entry_size_limit",
    "archive_total_size_limit",
    "archive_compression_ratio_limit",
    "nested_archive",
    "macro_present",
    "external_link_present",
    "embedded_object_present",
    "digital_signature_present",
    "active_formula_present",
    "formula_injection_present",
  ]),
  disposition: z.enum(["block", "require_approval"]),
  location: z.string().trim().min(1).max(2000),
  detail: z.string().trim().min(1).max(4000),
}).strict();
export type FileSafetyFinding = z.infer<typeof FileSafetyFindingSchema>;

export const FileSafetyManifestSchema = z.object({
  schemaVersion: z.literal(1),
  fileName: z.string().trim().min(1),
  mediaType: z.string().trim().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  archive: z.object({
    entryCount: z.number().int().nonnegative(),
    totalCompressedBytes: z.number().int().nonnegative(),
    totalUncompressedBytes: z.number().int().nonnegative(),
    maximumCompressionRatio: z.number().nonnegative(),
  }).strict().nullable(),
  packageEntries: z.array(z.string()),
  findings: z.array(FileSafetyFindingSchema),
  decision: z.enum(["clean", "require_approval", "block"]),
}).strict();
export type FileSafetyManifest = z.infer<typeof FileSafetyManifestSchema>;

export const DlpFindingSchema = z.object({
  kind: z.enum(["secret", "personal_data", "bank_account", "restricted_financial_data"]),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict().refine((item) => item.end > item.start, { message: "end must be greater than start" });
export type DlpFinding = z.infer<typeof DlpFindingSchema>;
