import { CapabilityFoundationRollout } from "./capability-foundation-rollout";

export type FoundationOperation = "read" | "write";
export type FoundationExecutor<I, O> = (input: I) => Promise<O>;

export type FoundationExecution<I, O> = {
  input: I;
  operation: FoundationOperation;
  caseId?: string;
  runId?: string;
  next: FoundationExecutor<I, O>;
};

/**
 * Production gateway after the one-way Foundation cutover. There is exactly
 * one executor and therefore no dual read, dual write, or runtime fallback.
 */
export class CapabilityFoundationGateway {
  constructor(readonly rollout: CapabilityFoundationRollout) {}

  async execute<I, O>(request: FoundationExecution<I, O>): Promise<O> {
    const epoch = this.rollout.ensureInitialized();
    if (epoch.mode !== "cutover" || epoch.authority !== "new") {
      throw new Error(`Capability Foundation authority violation: ${epoch.mode}:${epoch.authority}`);
    }
    return request.next(request.input);
  }
}
