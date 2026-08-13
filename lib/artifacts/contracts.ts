import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "@/lib/capability/common";

export const ArtifactStateSchema = z.enum([
  "staging",
  "candidate",
  "delivered",
  "archived",
  "tombstoned",
]);
export type ArtifactState = z.infer<typeof ArtifactStateSchema>;

export const ArtifactRefSchema = z
  .object({
    artifactId: IdentifierSchema,
    versionId: IdentifierSchema,
    sha256: Sha256Schema,
    mediaType: z.string().trim().min(1).max(255),
    logicalName: z.string().trim().min(1).max(1024),
    state: ArtifactStateSchema,
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

const PageLocatorSchema = z.object({ kind: z.literal("page"), page: z.number().int().positive() }).strict();
const SectionLocatorSchema = z
  .object({ kind: z.literal("section"), sectionPath: z.array(z.string().trim().min(1)).min(1) })
  .strict();
const ParagraphLocatorSchema = z.object({ kind: z.literal("paragraph"), nodeId: IdentifierSchema }).strict();
const TableLocatorSchema = z.object({ kind: z.literal("table"), nodeId: IdentifierSchema }).strict();
const SheetRangeLocatorSchema = z
  .object({
    kind: z.literal("sheet_range"),
    sheet: z.string().trim().min(1).max(255),
    range: z.string().regex(/^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/i),
  })
  .strict();
const CharRangeLocatorSchema = z
  .object({
    kind: z.literal("char_range"),
    nodeId: IdentifierSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.end > value.start, { message: "end must be greater than start", path: ["end"] });
const BBoxLocatorSchema = z
  .object({
    kind: z.literal("bbox"),
    page: z.number().int().positive(),
    bbox: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  })
  .strict();
const NodeLocatorSchema = z.object({ kind: z.literal("node"), nodeId: IdentifierSchema }).strict();

export const DocumentLocatorSchema = z.discriminatedUnion("kind", [
  PageLocatorSchema,
  SectionLocatorSchema,
  ParagraphLocatorSchema,
  TableLocatorSchema,
  SheetRangeLocatorSchema,
  CharRangeLocatorSchema,
  BBoxLocatorSchema,
  NodeLocatorSchema,
]);
export type DocumentLocator = z.infer<typeof DocumentLocatorSchema>;

export const ArtifactLocatorSchema = z
  .object({
    artifactVersionId: IdentifierSchema,
    locator: DocumentLocatorSchema,
  })
  .strict();
export type ArtifactLocator = z.infer<typeof ArtifactLocatorSchema>;
