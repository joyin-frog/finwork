import type { DatabaseSync } from "node:sqlite";
import { EvaluationObservationSchema, EvaluationResultSchema, type EvaluationObservation, type EvaluationResult, type GoldenManifest } from "./contracts";
import { classifyFault } from "./fault-classifier";
import { computeScorecards } from "./scorecards";
import { EvaluationStore } from "./store";
import { verifyArtifactIntegrity, verifyEvidenceIntegrity } from "./verifier";

export class EvaluationRunner {
  readonly store: EvaluationStore;
  constructor(readonly db: DatabaseSync, readonly casRoot: string, readonly now = () => new Date()) { this.store = new EvaluationStore(db); }
  async run(manifest: GoldenManifest, execute: (manifest: GoldenManifest) => Promise<EvaluationObservation>): Promise<EvaluationResult> {
    const saved = this.store.saveManifest(manifest); const startedAt = this.now().toISOString(); const runId = this.store.start(saved, startedAt);
    let observation: EvaluationObservation;
    try { observation = EvaluationObservationSchema.parse(await execute(saved)); }
    catch (error) {
      const endedAt = this.now().toISOString(); const result = EvaluationResultSchema.parse({ runId, manifestId: saved.id, manifestVersion: saved.version, status: "error", faultDomain: "evaluator", scorecards: [], failures: [error instanceof Error ? error.message : String(error)], startedAt, endedAt }); this.store.finish(result); return result;
    }
    const artifact = verifyArtifactIntegrity(this.db, this.casRoot, observation.artifactVersionIds);
    const evidence = verifyEvidenceIntegrity(this.db, saved.taskContract.caseId ?? saved.taskContract.id, saved.expectedEvidenceTypes);
    const enriched = EvaluationObservationSchema.parse({ ...observation, dimensions: { ...observation.dimensions, artifact: artifact.passed ? (observation.dimensions.artifact ?? 1) : 0, evidence: evidence.passed ? (observation.dimensions.evidence ?? 1) : 0 } });
    const scorecards = computeScorecards(saved, enriched); const failures = [...artifact.failures, ...evidence.failures, ...scorecards.filter((card) => !card.passed).map((card) => `score_below_threshold:${card.dimension}`)];
    const faultDomain = observation.failure ? classifyFault(observation.failure) : failures.some((item) => item.startsWith("artifact_")) ? "validator" : undefined;
    const endedAt = this.now().toISOString();
    const result = EvaluationResultSchema.parse({ runId, manifestId: saved.id, manifestVersion: saved.version, status: failures.length || observation.failure ? "failed" : "passed", ...(faultDomain ? { faultDomain } : {}), scorecards, failures: observation.failure ? [...failures, `${observation.failure.kind}:${observation.failure.code}`] : failures, startedAt, endedAt });
    this.store.finish(result); return result;
  }
}
