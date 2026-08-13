import { CapabilityFoundationRollout } from "./capability-foundation-rollout";

export type FoundationOperation = "read" | "write";
export type FoundationExecutor<I, O> = (input: I) => Promise<O>;

export type FoundationExecution<I, O> = {
  input: I;
  operation: FoundationOperation;
  caseId?: string;
  runId?: string;
  legacy: FoundationExecutor<I, O>;
  next: FoundationExecutor<I, O>;
  /** A side-effect-free implementation used only to compare shadow output. */
  shadow?: FoundationExecutor<I, O>;
};

/**
 * Single authority gateway for migrated operations. Shadow mode never invokes
 * the next executor implicitly: callers must supply an explicitly
 * side-effect-free shadow executor for both reads and writes. This prevents a
 * nominally read-only tool from performing hidden cache, network, or telemetry
 * side effects twice.
 */
export class CapabilityFoundationGateway {
  constructor(readonly rollout: CapabilityFoundationRollout) {}

  async execute<I, O>(request: FoundationExecution<I, O>): Promise<O> {
    const epoch = this.rollout.ensureInitialized();
    if (epoch.mode === "cutover" && epoch.authority === "new") return request.next(request.input);
    if (epoch.mode === "rollback" || epoch.authority === "legacy") {
      const authoritative = await request.legacy(request.input);
      if (epoch.mode !== "shadow") return authoritative;

      if (!request.shadow) {
        this.rollout.recordComparison({
          caseId: request.caseId,
          runId: request.runId,
          legacy: authoritative,
          next: { skipped: true },
          conclusive: false,
          details: {
            reason: `shadow_${request.operation}_requires_explicit_side_effect_free_executor`,
          },
        });
        return authoritative;
      }

      const observed = await request.shadow(request.input);
      this.rollout.recordComparison({
        caseId: request.caseId,
        runId: request.runId,
        legacy: authoritative,
        next: observed,
      });
      return authoritative;
    }
    throw new Error(`unsupported rollout authority: ${epoch.mode}:${epoch.authority}`);
  }
}
