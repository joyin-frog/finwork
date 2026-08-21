import { z } from "zod";
import { IdentifierSchema, JsonValueSchema, Sha256Schema } from "@/lib/capability/common";

export const RuleStatusSchema = z.enum(["passed", "failed", "unverifiable", "not_applicable"]);
export type RuleStatus = z.infer<typeof RuleStatusSchema>;

export const RuleDefinitionSchema = z.object({
  id: IdentifierSchema,
  version: z.string().trim().min(1),
  category: z.enum(["statement_tie", "period", "consolidation", "fx", "tax", "payroll", "voucher", "data_quality", "table_merge"]),
  title: z.string().trim().min(1),
  source: z.object({ authority: z.string().trim().min(1), reference: z.string().trim().min(1), publishedAt: z.string().nullable() }).strict(),
  jurisdiction: z.string().trim().min(1),
  effectivePeriod: z.object({ from: z.string(), to: z.string().nullable() }).strict(),
  tolerance: z.object({ absolute: z.number().nonnegative(), relative: z.number().nonnegative() }).strict(),
  requiredFacts: z.array(z.string()),
}).strict();
export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;

export const RuleAssertionSchema = z.object({
  assertionId: IdentifierSchema,
  ruleId: IdentifierSchema,
  ruleVersion: z.string(),
  status: RuleStatusSchema,
  message: z.string(),
  facts: z.record(z.string(), JsonValueSchema),
  artifactSha256: Sha256Schema,
  locators: z.array(z.string()),
  evaluatedAt: z.string(),
}).strict();
export type RuleAssertion = z.infer<typeof RuleAssertionSchema>;

export type RuleEvaluator = (facts: Record<string, unknown>, definition: RuleDefinition) => Omit<RuleAssertion, "assertionId" | "ruleId" | "ruleVersion" | "artifactSha256" | "evaluatedAt">;
