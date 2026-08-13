import { z } from "zod";
import { ArtifactRefSchema, DocumentLocatorSchema } from "@/lib/artifacts/contracts";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  Sha256Schema,
  VersionedProducerSchema,
} from "@/lib/capability/common";

export const EvidenceRefSchema = z
  .object({
    evidenceId: IdentifierSchema,
    outputHash: Sha256Schema,
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const EvidenceRecordSchema = z
  .object({
    id: IdentifierSchema,
    type: z.enum(["source", "extraction", "transform", "assertion", "delivery"]),
    artifact: ArtifactRefSchema,
    locator: DocumentLocatorSchema.optional(),
    producer: VersionedProducerSchema,
    inputs: z.array(EvidenceRefSchema),
    outputHash: Sha256Schema,
    confidence: z.number().min(0).max(1).optional(),
    uncertainty: z.array(z.string().trim().min(1).max(1000)).optional(),
    policyDecisionId: IdentifierSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.type === "source" && !record.locator) {
      ctx.addIssue({ code: "custom", message: "source evidence requires a precise locator", path: ["locator"] });
    }
  });
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const ClaimSchema = z
  .object({
    id: IdentifierSchema,
    caseId: IdentifierSchema,
    statement: z.string().trim().min(1).max(20_000),
    structuredValue: JsonValueSchema.optional(),
    evidenceRefs: z.array(IdentifierSchema).min(1),
    status: z.enum(["candidate", "verified", "contradicted", "superseded"]),
  })
  .strict();
export type Claim = z.infer<typeof ClaimSchema>;

export const CitationRecordSchema = z
  .object({
    id: IdentifierSchema,
    claimId: IdentifierSchema,
    artifactVersionId: IdentifierSchema,
    locator: DocumentLocatorSchema,
    quoteHash: Sha256Schema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type CitationRecord = z.infer<typeof CitationRecordSchema>;
