import { z } from "zod";
import { IdentifierSchema, JsonValueSchema, Sha256Schema } from "@/lib/capability/common";

export const WorkbookScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type WorkbookScalar = z.infer<typeof WorkbookScalarSchema>;

export const FormulaAstSchema: z.ZodType<FormulaAst> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: WorkbookScalarSchema }).strict(),
    z.object({ kind: z.literal("reference"), sheet: z.string().nullable(), range: z.string() }).strict(),
    z.object({ kind: z.literal("function"), name: z.string(), args: z.array(FormulaAstSchema) }).strict(),
    z.object({ kind: z.literal("expression"), operator: z.string(), operands: z.array(FormulaAstSchema) }).strict(),
    z.object({ kind: z.literal("opaque"), source: z.string() }).strict(),
  ]),
);
export type FormulaAst =
  | { kind: "literal"; value: WorkbookScalar }
  | { kind: "reference"; sheet: string | null; range: string }
  | { kind: "function"; name: string; args: FormulaAst[] }
  | { kind: "expression"; operator: string; operands: FormulaAst[] }
  | { kind: "opaque"; source: string };

export const WorkbookCellSchema = z.object({
  locator: z.object({ sheet: z.string(), address: z.string() }).strict(),
  value: WorkbookScalarSchema.optional(),
  formula: z.string().optional(),
  cachedValue: WorkbookScalarSchema.optional(),
  formulaAst: FormulaAstSchema.optional(),
  dependencies: z.array(z.string()),
  styleFingerprint: z.string(),
}).strict();
export type WorkbookCell = z.infer<typeof WorkbookCellSchema>;

export const FinanceSemanticMappingSchema = z.object({
  entity: z.string().nullable(),
  period: z.string().nullable(),
  account: z.string().nullable(),
  currency: z.string().nullable(),
  unit: z.string().nullable(),
  scenario: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  resolvedBy: z.enum(["explicit_cell", "explicit_label", "dictionary", "heuristic", "unresolved"]),
  mappingVersion: IdentifierSchema,
  ambiguities: z.array(z.string()),
}).strict();
export type FinanceSemanticMapping = z.infer<typeof FinanceSemanticMappingSchema>;

export const FinanceSemanticValuesSchema = z.object({
  entity: z.string().nullable().optional(),
  period: z.string().nullable().optional(),
  account: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  scenario: z.string().nullable().optional(),
}).strict();
export type FinanceSemanticValues = z.infer<typeof FinanceSemanticValuesSchema>;

/** Explicit, versioned business context. It is deliberately data rather than
 * executable regex/config so it can be persisted, reviewed and replayed. */
export const WorkbookSemanticContextSchema = z.object({
  version: IdentifierSchema,
  defaults: FinanceSemanticValuesSchema.default({}),
  exactCells: z.record(z.string(), FinanceSemanticValuesSchema).default({}),
  exactLabels: z.record(z.string(), FinanceSemanticValuesSchema).default({}),
  accountAliases: z.record(z.string(), z.string().trim().min(1)).default({}),
}).strict();
export type WorkbookSemanticContext = z.infer<typeof WorkbookSemanticContextSchema>;

export const WorkbookIrSchema = z.object({
  schemaVersion: z.literal(1),
  sourceSha256: Sha256Schema,
  structuralGraph: z.object({
    sheets: z.array(z.object({ name: z.string(), state: z.string(), rowCount: z.number(), columnCount: z.number() }).strict()),
    namedRanges: z.array(z.string()),
    externalLinks: z.array(z.string()),
  }).strict(),
  formulaGraph: z.object({
    cells: z.array(WorkbookCellSchema),
    edges: z.array(z.object({ from: z.string(), to: z.string() }).strict()),
  }).strict(),
  financeGraph: z.object({
    contextVersion: IdentifierSchema,
    mappings: z.record(z.string(), FinanceSemanticMappingSchema),
    unresolvedLocators: z.array(z.string()),
    ambiguousLocators: z.array(z.string()),
  }).strict(),
  calculation: z.object({
    stale: z.boolean(),
    provider: z.string().nullable(),
    providerVersion: z.string().nullable(),
    recalculatedSha256: Sha256Schema.nullable(),
  }).strict(),
}).strict();
export type WorkbookIr = z.infer<typeof WorkbookIrSchema>;

export const WorkbookPatchOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_value"), sheet: z.string(), cell: z.string(), value: WorkbookScalarSchema, createSheet: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("set_formula"), sheet: z.string(), cell: z.string(), formula: z.string(), createSheet: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("clear"), sheet: z.string(), cell: z.string() }).strict(),
]);
export type WorkbookPatchOperation = z.infer<typeof WorkbookPatchOperationSchema>;

export const WorkbookPatchPlanSchema = z.object({
  planId: IdentifierSchema,
  sourceSha256: Sha256Schema,
  operations: z.array(WorkbookPatchOperationSchema).min(1),
  preconditions: z.array(z.object({ locator: z.string(), expected: JsonValueSchema.optional(), expectedFormula: z.string().optional() }).strict()),
  expectedEffects: z.array(z.string()),
  requireRecalc: z.boolean(),
}).strict();
export type WorkbookPatchPlan = z.infer<typeof WorkbookPatchPlanSchema>;

export const WorkbookDiffSchema = z.object({
  sourceSha256: Sha256Schema,
  targetSha256: Sha256Schema,
  changedCells: z.array(z.object({ locator: z.string(), before: WorkbookCellSchema.nullable(), after: WorkbookCellSchema.nullable() }).strict()),
  impactedFormulaCells: z.array(z.string()),
  untouchedStructurePreserved: z.boolean(),
  rollbackPlan: WorkbookPatchPlanSchema,
}).strict();
export type WorkbookDiff = z.infer<typeof WorkbookDiffSchema>;
