import type { GoldenManifest, EvaluationObservation, ScoreDimension } from "./contracts";

export type ComputedScorecard = { dimension: ScoreDimension; score: number; passed: boolean; details: Record<string, unknown> };

export function computeScorecards(manifest: GoldenManifest, observation: EvaluationObservation): ComputedScorecard[] {
  const dimensions: ScoreDimension[] = ["contract", "artifact", "evidence", "memory", "rag", "security", "performance"];
  const asserted = new Set(manifest.assertions.map((item) => item.dimension));
  return dimensions.map((dimension) => {
    const score = observation.dimensions[dimension] ?? (asserted.has(dimension) ? 0 : 1);
    const threshold = manifest.thresholds[dimension] ?? (asserted.has(dimension) ? 1 : 0);
    return { dimension, score, passed: score >= threshold, details: { threshold, asserted: asserted.has(dimension) } };
  });
}
