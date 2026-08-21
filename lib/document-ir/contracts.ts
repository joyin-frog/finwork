import { z } from "zod";
import { DocumentLocatorSchema } from "@/lib/artifacts/contracts";
import { IdentifierSchema, JsonValueSchema, Sha256Schema } from "@/lib/capability/common";

export const DocumentFormatSchema = z.enum(["docx", "pdf", "pptx", "xlsx"]);
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;

export const DocumentNodeKindSchema = z.enum([
  "document",
  "section",
  "paragraph",
  "run",
  "table",
  "table_row",
  "table_cell",
  "page",
  "text_block",
  "ocr_region",
  "slide",
  "shape",
  "notes",
  "sheet",
  "image",
  "comment",
  "revision",
  "footnote",
]);
export type DocumentNodeKind = z.infer<typeof DocumentNodeKindSchema>;

export const DocumentStyleSchema = z
  .object({
    styleId: IdentifierSchema.optional(),
    fontFamily: z.string().trim().min(1).max(255).optional(),
    fontSizePt: z.number().positive().finite().optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    color: z.string().trim().min(1).max(64).optional(),
    alignment: z.enum(["left", "center", "right", "justify"]).optional(),
  })
  .strict();
export type DocumentStyle = z.infer<typeof DocumentStyleSchema>;

export const DocumentNodeSchema = z
  .object({
    id: IdentifierSchema,
    kind: DocumentNodeKindSchema,
    parentId: IdentifierSchema.nullable(),
    order: z.number().int().nonnegative(),
    text: z.string().optional(),
    locator: DocumentLocatorSchema,
    style: DocumentStyleSchema.optional(),
    attributes: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict();
export type DocumentNode = z.infer<typeof DocumentNodeSchema>;

export const PreservationDispositionSchema = z.enum(["preserve", "block", "transform"]);
export const PreservationFeatureSchema = z
  .object({
    feature: z.enum([
      "comments",
      "revisions",
      "footnotes",
      "images",
      "macros",
      "external_links",
      "embedded_objects",
      "digital_signatures",
      "ocr_required",
      "unsupported_xml",
    ]),
    count: z.number().int().nonnegative(),
    disposition: PreservationDispositionSchema,
    paths: z.array(z.string()).default([]),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type PreservationFeature = z.infer<typeof PreservationFeatureSchema>;

export const PreservationManifestSchema = z
  .object({
    sourceSha256: Sha256Schema,
    sourceBytes: z.number().int().nonnegative(),
    format: DocumentFormatSchema,
    packageEntries: z.array(z.string()),
    features: z.array(PreservationFeatureSchema),
    blocked: z.boolean(),
    blockingReasons: z.array(z.string()),
  })
  .strict();
export type PreservationManifest = z.infer<typeof PreservationManifestSchema>;

export const DocumentIrSchema = z
  .object({
    schemaVersion: z.literal(1),
    format: DocumentFormatSchema,
    sourceSha256: Sha256Schema,
    nodes: z.array(DocumentNodeSchema),
    manifest: PreservationManifestSchema,
    metadata: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict();
export type DocumentIr = z.infer<typeof DocumentIrSchema>;

export const DocumentOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replace_text"), locator: DocumentLocatorSchema, text: z.string() }).strict(),
  z.object({ kind: z.literal("insert_node"), parent: DocumentLocatorSchema, node: DocumentNodeSchema }).strict(),
  z.object({ kind: z.literal("delete_node"), locator: DocumentLocatorSchema }).strict(),
  z.object({ kind: z.literal("set_style"), locator: DocumentLocatorSchema, style: DocumentStyleSchema }).strict(),
]);
export type DocumentOperation = z.infer<typeof DocumentOperationSchema>;

export const DocumentPatchPreconditionSchema = z
  .object({
    locator: DocumentLocatorSchema,
    expectedNodeId: IdentifierSchema,
    expectedKind: DocumentNodeKindSchema,
    expectedText: z.string().nullable(),
  })
  .strict();
export type DocumentPatchPrecondition = z.infer<typeof DocumentPatchPreconditionSchema>;

export const DocumentPatchImpactSchema = z
  .object({
    nodeIds: z.array(IdentifierSchema),
    packageEntries: z.array(z.string().trim().min(1)),
    preservationFeatures: z.array(PreservationFeatureSchema.shape.feature),
    visualVerificationRequired: z.boolean(),
  })
  .strict();
export type DocumentPatchImpact = z.infer<typeof DocumentPatchImpactSchema>;

/**
 * An immutable, reviewable edit intent. A plan binds operations to the exact
 * source bytes and captures the source state needed for stale-locator checks
 * and deterministic rollback before any package entry is written.
 */
export const DocumentPatchPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: IdentifierSchema,
    sourceSha256: Sha256Schema,
    format: DocumentFormatSchema,
    operations: z.array(DocumentOperationSchema).min(1),
    preconditions: z.array(DocumentPatchPreconditionSchema).min(1),
    expectedEffects: z.array(z.string().trim().min(1)),
    impact: DocumentPatchImpactSchema,
    rollbackOperations: z.array(DocumentOperationSchema),
    executable: z.boolean(),
    blockers: z.array(z.string().trim().min(1)),
  })
  .strict();
export type DocumentPatchPlan = z.infer<typeof DocumentPatchPlanSchema>;

export const DocumentDiffSchema = z
  .object({
    sourceSha256: Sha256Schema,
    targetSha256: Sha256Schema,
    added: z.array(DocumentNodeSchema),
    removed: z.array(DocumentNodeSchema),
    changed: z.array(z.object({ before: DocumentNodeSchema, after: DocumentNodeSchema }).strict()),
    structureSimilarity: z.number().min(0).max(1),
    visualSimilarity: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type DocumentDiff = z.infer<typeof DocumentDiffSchema>;
