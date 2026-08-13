import { z } from "zod";
import { DocumentLocatorSchema } from "@/lib/artifacts/contracts";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  PeriodRefSchema,
  PrincipalRefSchema,
  Sha256Schema,
} from "@/lib/capability/common";

export const RETRIEVAL_PARSER_VERSION = "retrieval-parser-v1";
export const RETRIEVAL_CHUNKER_VERSION = "structure-chunker-v1";
export const RETRIEVAL_INDEX_VERSION = "hybrid-index-v1";

export const RetrievalClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export type RetrievalClassification = z.infer<typeof RetrievalClassificationSchema>;

export const RetrievalNodeTypeSchema = z.enum([
  "document",
  "section",
  "paragraph",
  "list",
  "table",
  "table_row",
  "sheet",
  "sheet_range",
  "page",
  "code",
]);
export type RetrievalNodeType = z.infer<typeof RetrievalNodeTypeSchema>;

export const RetrievalErrorCodeSchema = z.enum([
  "parser_unavailable",
  "parser_failed",
  "embedding_unavailable",
  "embedding_failed",
  "index_failed",
  "unauthorized",
  "citation_invalid",
  "job_not_found",
  "job_not_claimable",
  "invalid_contract",
]);
export type RetrievalErrorCode = z.infer<typeof RetrievalErrorCodeSchema>;

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: RetrievalErrorCode, message: string, options: { retryable?: boolean; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "RetrievalError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export const RetrievalAclGrantSchema = z
  .object({
    principal: PrincipalRefSchema,
    grantedAt: IsoDateTimeSchema,
  })
  .strict();
export type RetrievalAclGrant = z.infer<typeof RetrievalAclGrantSchema>;

export const RetrievalDocumentMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(1024),
    documentType: z.string().trim().min(1).max(100),
    entityRefs: z.array(IdentifierSchema).max(500).default([]),
    period: PeriodRefSchema.optional(),
    effectiveDate: z.iso.date().optional(),
    classification: RetrievalClassificationSchema,
  })
  .strict();
export type RetrievalDocumentMetadata = z.infer<typeof RetrievalDocumentMetadataSchema>;

export const RetrievalRegistrationSchema = z
  .object({
    documentId: IdentifierSchema.optional(),
    artifactId: IdentifierSchema,
    artifactVersionId: IdentifierSchema,
    contentHash: Sha256Schema,
    mediaType: z.string().trim().min(1).max(255),
    metadata: RetrievalDocumentMetadataSchema,
    acl: z.array(RetrievalAclGrantSchema).min(1),
    parserVersion: IdentifierSchema.default(RETRIEVAL_PARSER_VERSION),
    chunkerVersion: IdentifierSchema.default(RETRIEVAL_CHUNKER_VERSION),
    embeddingModel: IdentifierSchema,
    requestedAt: IsoDateTimeSchema,
  })
  .strict();
export type RetrievalRegistration = z.infer<typeof RetrievalRegistrationSchema>;

export const ParsedRetrievalDocumentSchema = z
  .object({
    text: z.string().min(1),
    title: z.string().trim().min(1).max(1024),
    documentType: z.string().trim().min(1).max(100),
    sheetNames: z.array(z.string().trim().min(1).max(255)).optional(),
    pageCount: z.number().int().positive().optional(),
    parserMetadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type ParsedRetrievalDocument = z.infer<typeof ParsedRetrievalDocumentSchema>;

export const StructureChunkSchema = z
  .object({
    id: IdentifierSchema,
    parentId: IdentifierSchema.optional(),
    ordinal: z.number().int().nonnegative(),
    nodeType: RetrievalNodeTypeSchema,
    depth: z.number().int().nonnegative(),
    heading: z.string().trim().min(1).max(1024).optional(),
    text: z.string().min(1),
    textHash: Sha256Schema,
    locator: DocumentLocatorSchema,
    charStart: z.number().int().nonnegative(),
    charEnd: z.number().int().positive(),
    tokenCount: z.number().int().nonnegative(),
  })
  .strict()
  .refine((chunk) => chunk.charEnd > chunk.charStart, {
    message: "charEnd must be greater than charStart",
    path: ["charEnd"],
  });
export type StructureChunk = z.infer<typeof StructureChunkSchema>;

export const RetrievalChunkEdgeSchema = z
  .object({
    fromChunkId: IdentifierSchema,
    toChunkId: IdentifierSchema,
    relation: z.enum(["parent", "next", "previous", "table_header", "same_section"]),
  })
  .strict()
  .refine((edge) => edge.fromChunkId !== edge.toChunkId, { message: "self edges are forbidden" });
export type RetrievalChunkEdge = z.infer<typeof RetrievalChunkEdgeSchema>;

export const RetrievalSearchFiltersSchema = z
  .object({
    entityRefs: z.array(IdentifierSchema).max(100).default([]),
    period: PeriodRefSchema.optional(),
    documentTypes: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    effectiveAt: z.iso.date().optional(),
    artifactVersionIds: z.array(IdentifierSchema).max(500).default([]),
  })
  .strict();
export type RetrievalSearchFilters = z.infer<typeof RetrievalSearchFiltersSchema>;

export const RetrievalSearchRequestSchema = z
  .object({
    principal: PrincipalRefSchema,
    query: z.string().trim().min(1).max(10_000),
    mode: z.enum(["hybrid", "lexical_only"]).default("hybrid"),
    queryVector: z.array(z.number().finite()).min(1).max(16_384).optional(),
    embeddingModel: IdentifierSchema,
    filters: RetrievalSearchFiltersSchema.default({
      entityRefs: [],
      documentTypes: [],
      artifactVersionIds: [],
    }),
    topK: z.number().int().min(1).max(100).default(10),
    candidateLimit: z.number().int().min(10).max(10_000).default(500),
    cacheTtlSeconds: z.number().int().min(0).max(86_400).default(300),
    now: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.mode === "hybrid" && !request.queryVector) {
      ctx.addIssue({ code: "custom", message: "hybrid retrieval requires queryVector", path: ["queryVector"] });
    }
  });
export type RetrievalSearchRequest = z.infer<typeof RetrievalSearchRequestSchema>;

export const CitationRecordV2Schema = z
  .object({
    artifactId: IdentifierSchema,
    artifactVersionId: IdentifierSchema,
    artifactHash: Sha256Schema,
    documentId: IdentifierSchema,
    documentType: z.string().trim().min(1),
    title: z.string().trim().min(1),
    locator: DocumentLocatorSchema,
    quotedText: z.string().min(1),
    quoteHash: Sha256Schema,
    effectiveDate: z.iso.date().optional(),
    lexicalScore: z.number().finite().nonnegative(),
    vectorScore: z.number().finite().min(-1).max(1).optional(),
    rerankScore: z.number().finite(),
  })
  .strict();
export type CitationRecordV2 = z.infer<typeof CitationRecordV2Schema>;

export const RetrievalHitSchema = z
  .object({
    chunkId: IdentifierSchema,
    text: z.string().min(1),
    heading: z.string().optional(),
    score: z.number().finite(),
    citation: CitationRecordV2Schema,
  })
  .strict();
export type RetrievalHit = z.infer<typeof RetrievalHitSchema>;

export const RetrievalDiagnosticsSchema = z
  .object({
    cacheHit: z.boolean(),
    authorizedDocumentCount: z.number().int().nonnegative(),
    lexicalCandidateCount: z.number().int().nonnegative(),
    annCandidateCount: z.number().int().nonnegative(),
    expandedCandidateCount: z.number().int().nonnegative(),
    scoredCandidateCount: z.number().int().nonnegative(),
    elapsedMs: z.number().finite().nonnegative(),
    indexVersion: IdentifierSchema,
  })
  .strict();
export type RetrievalDiagnostics = z.infer<typeof RetrievalDiagnosticsSchema>;

export const RetrievalSearchResponseSchema = z
  .object({
    hits: z.array(RetrievalHitSchema),
    diagnostics: RetrievalDiagnosticsSchema,
  })
  .strict();
export type RetrievalSearchResponse = z.infer<typeof RetrievalSearchResponseSchema>;

export type RetrievalParser = (input: {
  content: Uint8Array;
  mediaType: string;
  title: string;
}) => Promise<ParsedRetrievalDocument>;

export type RetrievalEmbedder = (texts: readonly string[], model: string) => Promise<readonly (readonly number[])[]>;
