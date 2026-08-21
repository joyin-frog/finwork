import { z } from "zod";

export const ArtifactGcPolicySchema = z.object({
  now: z.string().datetime(),
  minimumAgeMs: z.number().int().nonnegative().default(24 * 60 * 60 * 1000),
  gracePeriodMs: z.number().int().nonnegative().default(7 * 24 * 60 * 60 * 1000),
  lowWatermarkBytes: z.number().int().nonnegative().nullable().default(null),
  actorId: z.string().trim().min(1).default("system:artifact-gc"),
}).strict();
export type ArtifactGcPolicy = z.infer<typeof ArtifactGcPolicySchema>;

export type GcCandidate = {
  artifactVersionId: string;
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  reason: "expired" | "tombstoned" | "reclaimable_derivative";
};

export type GcPlan = {
  runId: string;
  roots: string[];
  marked: string[];
  candidates: GcCandidate[];
  reclaimableBytes: number;
};

export type ArtifactQuotaSnapshot = {
  logicalBytes: number;
  physicalBytes: number;
  reclaimableBytes: number;
  artifactCount: number;
  versionCount: number;
};
