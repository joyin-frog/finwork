import { z } from "zod";

const OptionalLimitSchema = z.number().int().positive().nullable().default(null);

export const ResourceBudgetSchema = z
  .object({
    tokenLimit: OptionalLimitSchema,
    wallTimeMs: OptionalLimitSchema,
    cpuTimeMs: OptionalLimitSchema,
    memoryBytes: OptionalLimitSchema,
    diskBytes: OptionalLimitSchema,
    networkBytes: OptionalLimitSchema,
    toolOutputBytes: OptionalLimitSchema,
    concurrency: z.number().int().positive().max(128).default(1),
    retryLimit: z.number().int().nonnegative().max(20).default(0),
  })
  .strict();
export type ResourceBudget = z.infer<typeof ResourceBudgetSchema>;

export const ResourceEstimateSchema = z
  .object({
    expectedWallTimeMs: z.number().int().nonnegative(),
    expectedMemoryBytes: z.number().int().nonnegative(),
    expectedDiskBytes: z.number().int().nonnegative(),
    expectedNetworkBytes: z.number().int().nonnegative(),
    expectedToolOutputBytes: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ResourceEstimate = z.infer<typeof ResourceEstimateSchema>;

export const ResourceUsageSchema = z.object({
  tokens: z.number().int().nonnegative().default(0),
  wallTimeMs: z.number().int().nonnegative().default(0),
  cpuTimeMs: z.number().int().nonnegative().default(0),
  memoryBytes: z.number().int().nonnegative().default(0),
  diskBytes: z.number().int().nonnegative().default(0),
  networkBytes: z.number().int().nonnegative().default(0),
  toolOutputBytes: z.number().int().nonnegative().default(0),
  retries: z.number().int().nonnegative().default(0),
}).strict();
export type ResourceUsage = z.infer<typeof ResourceUsageSchema>;

export type ResourceScope = { type: "global" | "case" | "run"; key: string };

export class ResourceLimitError extends Error {
  constructor(
    readonly code: "budget_missing" | "budget_exhausted" | "concurrency_exhausted" | "queue_full" | "deadline_exceeded",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) { super(message); }
}
