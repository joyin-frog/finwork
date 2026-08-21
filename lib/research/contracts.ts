import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema, Sha256Schema } from "@/lib/capability/common";
import { ArtifactRefSchema, DocumentLocatorSchema } from "@/lib/artifacts/contracts";

export const DueDiligenceTopicSchema = z.enum([
  "entity",
  "ownership",
  "people",
  "litigation",
  "penalty",
  "finance",
  "media",
  "related_parties",
]);
export type DueDiligenceTopic = z.infer<typeof DueDiligenceTopicSchema>;

export const DUE_DILIGENCE_TOPICS: readonly DueDiligenceTopic[] = DueDiligenceTopicSchema.options;

export const ResearchSubjectSchema = z.object({
  legalName: z.string().trim().min(1).max(500),
  aliases: z.array(z.string().trim().min(1).max(500)).default([]),
  jurisdiction: z.string().trim().min(1).max(100),
  identifiers: z.record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(500)).default({}),
}).strict();
export type ResearchSubject = z.infer<typeof ResearchSubjectSchema>;

export const ResearchSourcePolicySchema = z.object({
  allowedDomains: z.array(z.string().trim().toLowerCase().min(1)).default([]),
  deniedDomains: z.array(z.string().trim().toLowerCase().min(1)).default([]),
  allowedRegions: z.array(z.string().trim().min(1).max(100)).default([]),
  requireRobotsCompliance: z.boolean().default(true),
  allowRestrictedLicense: z.boolean().default(false),
  allowSensitivePersonalData: z.boolean().default(false),
  maxRequestsPerMinute: z.number().int().positive().max(600).default(30),
  maxTotalRequests: z.number().int().positive().max(500).default(50),
}).strict();
export type ResearchSourcePolicy = z.infer<typeof ResearchSourcePolicySchema>;

export const ResearchSourceClassSchema = z.enum([
  "regulator",
  "court_registry",
  "company_filing",
  "government",
  "professional_database",
  "reputable_media",
  "other_media",
  "blog",
  "social",
]);
export type ResearchSourceClass = z.infer<typeof ResearchSourceClassSchema>;

export const ResearchCoverageRequirementSchema = z.object({
  topic: DueDiligenceTopicSchema,
  acceptedSourceClasses: z.array(ResearchSourceClassSchema).min(1),
  minIndependentSources: z.number().int().positive().max(10).default(1),
  minVerifiedClaims: z.number().int().positive().max(50).default(1),
}).strict();
export type ResearchCoverageRequirement = z.infer<typeof ResearchCoverageRequirementSchema>;

export const ResearchQueryPlanSchema = z.object({
  id: IdentifierSchema,
  caseId: IdentifierSchema,
  providerId: IdentifierSchema,
  subject: ResearchSubjectSchema,
  topics: z.array(DueDiligenceTopicSchema).min(1),
  queries: z.array(z.string().trim().min(1).max(2000)).min(1),
  languages: z.array(z.string().trim().min(1).max(35)).default(["zh-CN"]),
  asOf: IsoDateTimeSchema,
  maxSources: z.number().int().positive().max(100).default(20),
  coverageRequirements: z.array(ResearchCoverageRequirementSchema).default([]),
  policy: ResearchSourcePolicySchema,
}).strict().superRefine((plan, context) => {
  if (plan.maxSources + 1 > plan.policy.maxTotalRequests) {
    context.addIssue({
      code: "custom",
      path: ["maxSources"],
      message: "search plus fetch requests exceed the plan request budget",
    });
  }
  const duplicateTopics = plan.coverageRequirements
    .map((item) => item.topic)
    .filter((topic, index, topics) => topics.indexOf(topic) !== index);
  if (duplicateTopics.length > 0) {
    context.addIssue({ code: "custom", path: ["coverageRequirements"], message: "coverage requirements must be unique per topic" });
  }
});
export type ResearchQueryPlan = z.infer<typeof ResearchQueryPlanSchema>;

export const ResearchCandidateSchema = z.object({
  id: IdentifierSchema,
  url: z.url(),
  title: z.string().trim().min(1).max(2000),
  snippet: z.string().max(20_000).default(""),
  sourceClass: ResearchSourceClassSchema,
  publishedAt: IsoDateTimeSchema.optional(),
  region: z.string().trim().min(1).max(100).optional(),
  entityNames: z.array(z.string().trim().min(1).max(500)).default([]),
  entityIdentifiers: z.record(z.string(), z.string()).default({}),
}).strict();
export type ResearchCandidate = z.infer<typeof ResearchCandidateSchema>;

export const ResearchExtractedClaimSchema = z.object({
  id: IdentifierSchema,
  topic: DueDiligenceTopicSchema,
  statement: z.string().trim().min(1).max(20_000),
  normalizedValue: JsonValueSchema.optional(),
  quote: z.string().min(1).max(20_000),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  confidence: z.number().min(0).max(1).default(1),
}).strict().refine((value) => value.end > value.start, { message: "end must be greater than start" });
export type ResearchExtractedClaim = z.infer<typeof ResearchExtractedClaimSchema>;

export const ResearchFetchedSourceSchema = z.object({
  candidateId: IdentifierSchema,
  requestedUrl: z.url(),
  finalUrl: z.url(),
  fetchedAt: IsoDateTimeSchema,
  publishedAt: IsoDateTimeSchema.optional(),
  effectiveFrom: IsoDateTimeSchema.optional(),
  effectiveTo: IsoDateTimeSchema.optional(),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  locale: z.string().trim().min(1).max(100),
  contentType: z.string().trim().min(1).max(255),
  body: z.string().max(10_000_000),
  license: z.string().trim().min(1).max(500).optional(),
  robotsAllowed: z.boolean(),
  claims: z.array(ResearchExtractedClaimSchema).default([]),
}).strict();
export type ResearchFetchedSource = z.infer<typeof ResearchFetchedSourceSchema>;

export const ResearchSourceRatingSchema = z.object({
  authority: z.number().min(0).max(1),
  primarySource: z.number().min(0).max(1),
  entityMatch: z.number().min(0).max(1),
  recency: z.number().min(0).max(1),
  total: z.number().min(0).max(1),
  reasons: z.array(z.string()),
}).strict();
export type ResearchSourceRating = z.infer<typeof ResearchSourceRatingSchema>;

export const ResearchSnapshotSchema = z.object({
  id: IdentifierSchema,
  planId: IdentifierSchema,
  candidateId: IdentifierSchema,
  artifact: ArtifactRefSchema,
  requestedUrl: z.url(),
  finalUrl: z.url(),
  fetchedAt: IsoDateTimeSchema,
  publishedAt: IsoDateTimeSchema.optional(),
  effectiveFrom: IsoDateTimeSchema.optional(),
  effectiveTo: IsoDateTimeSchema.optional(),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  locale: z.string(),
  contentType: z.string(),
  license: z.string().optional(),
  robotsAllowed: z.boolean(),
  sourceClass: ResearchSourceClassSchema,
  rating: ResearchSourceRatingSchema,
  taints: z.array(z.enum(["web_untrusted", "prompt_injection", "sensitive_personal_data", "license_restricted"])),
  contentHash: Sha256Schema,
}).strict();
export type ResearchSnapshot = z.infer<typeof ResearchSnapshotSchema>;

export const ResearchClaimBindingSchema = z.object({
  claimId: IdentifierSchema,
  evidenceId: IdentifierSchema,
  citationId: IdentifierSchema,
  snapshotId: IdentifierSchema,
  topic: DueDiligenceTopicSchema,
  statement: z.string(),
  locator: DocumentLocatorSchema,
  quoteHash: Sha256Schema,
  status: z.enum(["candidate", "verified", "contradicted"]),
}).strict();
export type ResearchClaimBinding = z.infer<typeof ResearchClaimBindingSchema>;

export const ResearchConflictSchema = z.object({
  id: IdentifierSchema,
  topic: DueDiligenceTopicSchema,
  claimIds: z.array(IdentifierSchema).min(2),
  normalizedValues: z.array(JsonValueSchema),
  status: z.literal("unresolved"),
}).strict();
export type ResearchConflict = z.infer<typeof ResearchConflictSchema>;

export const ResearchCoverageItemSchema = z.object({
  topic: DueDiligenceTopicSchema,
  status: z.enum(["covered", "conflicted", "unknown"]),
  claimIds: z.array(IdentifierSchema),
  sourceCount: z.number().int().nonnegative(),
  verifiedClaimCount: z.number().int().nonnegative(),
  acceptedSourceClasses: z.array(ResearchSourceClassSchema),
  missingRequirements: z.array(z.string()),
  unknownReason: z.string().optional(),
}).strict();
export type ResearchCoverageItem = z.infer<typeof ResearchCoverageItemSchema>;

export const ResearchPublicationGateSchema = z.object({
  status: z.enum(["publishable", "blocked"]),
  coverageRatio: z.number().min(0).max(1),
  verifiedClaimCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  snapshotIntegrityVerified: z.boolean(),
  blockers: z.array(z.string()),
}).strict();
export type ResearchPublicationGate = z.infer<typeof ResearchPublicationGateSchema>;

export const ResearchReportSchema = z.object({
  plan: ResearchQueryPlanSchema,
  snapshots: z.array(ResearchSnapshotSchema),
  claims: z.array(ResearchClaimBindingSchema),
  conflicts: z.array(ResearchConflictSchema),
  coverage: z.array(ResearchCoverageItemSchema),
  unknowns: z.array(z.string()),
  publicationGate: ResearchPublicationGateSchema,
  rejectedSources: z.array(z.object({ url: z.string(), code: IdentifierSchema, reason: z.string() }).strict()),
}).strict();
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
