import { randomUUID } from "node:crypto";
import type { JsonValue } from "./common";
import {
  CapabilityFailureSchema,
  type CapabilityDefinition,
  type CapabilityExecutionContext,
  type CapabilityFailure,
} from "./contracts";
import { sha256Json } from "./hash";
import { CapabilityRegistry } from "./registry";

export type ExecutionGuard = (
  definition: CapabilityDefinition,
  input: unknown,
) => Promise<CapabilityFailure | null> | CapabilityFailure | null;

export type CapabilityExecuteRequest = {
  invocationId?: string;
  capabilityId: string;
  version?: string;
  input: unknown;
  runId: string;
  caseId?: string;
  signal?: AbortSignal;
  idempotencyKey?: string;
};

export type CapabilityExecuteResult =
  | { ok: true; output: unknown; attemptId: string; reused: boolean }
  | { ok: false; failure: CapabilityFailure; attemptId: string | null };

export type ExecutionResourceLease = { release(result: { status: "succeeded" | "failed" | "cancelled"; outputBytes?: number }): void | Promise<void> };
export type ExecutionResourceGovernor = { acquire(definition: CapabilityDefinition, request: CapabilityExecuteRequest): Promise<{ ok: true; lease: ExecutionResourceLease } | { ok: false; failure: CapabilityFailure }> };

export class CapabilityExecutionError extends Error {
  constructor(readonly failure: CapabilityFailure) {
    super(failure.message);
  }
}

const internalFailure = (error: unknown): CapabilityFailure => ({
  kind: "internal_error",
  code: "capability_handler_error",
  message: error instanceof Error ? error.message : String(error),
  retryable: false,
  details: {},
});

export class CapabilityExecutor {
  constructor(
    readonly registry: CapabilityRegistry,
    readonly guards: ExecutionGuard[] = [],
    readonly resourceGovernor?: ExecutionResourceGovernor,
  ) {}

  async execute(request: CapabilityExecuteRequest): Promise<CapabilityExecuteResult> {
    const definition = this.registry.resolve(request.capabilityId, request.version);
    if (!definition) {
      const inspected = request.version
        ? this.registry.inspect(request.capabilityId, request.version)
        : null;
      return {
        ok: false,
        attemptId: null,
        failure: CapabilityFailureSchema.parse({
          kind: "capability_missing",
          code: inspected?.status === "unavailable" ? "capability_unavailable" : "capability_not_registered",
          message: inspected?.unavailableReason ?? `Capability ${request.capabilityId} is not available`,
          retryable: false,
          details: { capabilityId: request.capabilityId, version: request.version ?? null },
        }),
      };
    }

    const parsedInput = definition.inputSchema.safeParse(request.input);
    if (!parsedInput.success) {
      return {
        ok: false,
        attemptId: null,
        failure: CapabilityFailureSchema.parse({
          kind: "invalid_input",
          code: "capability_input_invalid",
          message: parsedInput.error.message,
          retryable: false,
          details: {},
        }),
      };
    }

    const preflightFailure = await this.registry.preflight(definition);
    if (preflightFailure) return { ok: false, failure: CapabilityFailureSchema.parse(preflightFailure), attemptId: null };
    for (const guard of this.guards) {
      const failure = await guard(definition, parsedInput.data);
      if (failure) return { ok: false, failure: CapabilityFailureSchema.parse(failure), attemptId: null };
    }

    const inputHash = sha256Json(parsedInput.data);
    const invocationId = request.invocationId ?? randomUUID();
    let idempotencyKey: string | null;
    try {
      idempotencyKey = this.idempotencyKey(
        definition,
        parsedInput.data,
        request.idempotencyKey,
        inputHash,
      );
    } catch (error) {
      return {
        ok: false,
        attemptId: null,
        failure: CapabilityFailureSchema.parse({
          kind: "invalid_input",
          code: "idempotency_key_missing",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          details: {},
        }),
      };
    }
    if (idempotencyKey) {
      const reused = this.registry.db.prepare(`
        SELECT attempt_id, output_json FROM capability_attempts
        WHERE capability_id = ? AND version = ? AND idempotency_key = ? AND status = 'succeeded'
        ORDER BY ended_at DESC LIMIT 1
      `).get(definition.id, definition.version, idempotencyKey) as {
        attempt_id: string;
        output_json: string;
      } | undefined;
      if (reused) {
        const output = definition.outputSchema.parse(JSON.parse(reused.output_json));
        return { ok: true, output, attemptId: reused.attempt_id, reused: true };
      }
    }

    const maxAttempts = definition.failureSemantics.maxAttempts;
    let lastFailure: CapabilityFailure | null = null;
    let lastAttemptId: string | null = null;
    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
      const attemptId = randomUUID();
      lastAttemptId = attemptId;
      const startedAt = new Date().toISOString();
      this.registry.db.prepare(`
        INSERT INTO capability_attempts
          (attempt_id, invocation_id, run_id, case_id, capability_id, version, attempt_no, input_hash,
           idempotency_key, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
      `).run(
        attemptId,
        invocationId,
        request.runId,
        request.caseId ?? null,
        definition.id,
        definition.version,
        attemptNo,
        inputHash,
        idempotencyKey,
        startedAt,
      );
      const signal = request.signal ?? new AbortController().signal;
      const context: CapabilityExecutionContext = { runId: request.runId, caseId: request.caseId, attemptId, signal };
      const acquired = this.resourceGovernor ? await this.resourceGovernor.acquire(definition, request) : null;
      if (acquired && !acquired.ok) {
        const failure = CapabilityFailureSchema.parse(acquired.failure);
        this.finishAttempt(attemptId, "failed", failure, null);
        return { ok: false, failure, attemptId };
      }
      const lease = acquired?.ok ? acquired.lease : null;
      try {
        if (signal.aborted) {
          throw new CapabilityExecutionError({
            kind: "canceled",
            code: "execution_canceled",
            message: "Capability execution was canceled",
            retryable: false,
            details: {},
          });
        }
        const rawOutput = await definition.handler(parsedInput.data, context);
        const output = definition.outputSchema.parse(rawOutput);
        for (const validator of definition.validators) {
          const implementation = definition.validatorHandlers?.[validator.id];
          if (!implementation) {
            if (validator.blocking) {
              throw new CapabilityExecutionError({
                kind: "deterministic_validation_failed",
                code: "capability_validator_missing",
                message: `Blocking validator ${validator.id}@${validator.version} is not executable`,
                retryable: false,
                details: { validatorId: validator.id, validatorVersion: validator.version },
              });
            }
            continue;
          }
          try {
            await implementation(output, context);
          } catch (error) {
            if (!validator.blocking) continue;
            throw new CapabilityExecutionError({
              kind: "deterministic_validation_failed",
              code: "capability_validator_failed",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
              details: { validatorId: validator.id, validatorVersion: validator.version },
            });
          }
        }
        this.finishAttempt(attemptId, "succeeded", null, output);
        await lease?.release({ status: "succeeded", outputBytes: Buffer.byteLength(JSON.stringify(output)) });
        return { ok: true, output, attemptId, reused: false };
      } catch (error) {
        const failure = CapabilityFailureSchema.parse(
          error instanceof CapabilityExecutionError ? error.failure : internalFailure(error),
        );
        lastFailure = failure;
        this.finishAttempt(attemptId, failure.kind === "canceled" ? "canceled" : "failed", failure, null);
        await lease?.release({ status: failure.kind === "canceled" ? "cancelled" : "failed" });
        const canRetry =
          failure.kind === "transient_external_failure" &&
          definition.failureSemantics.retryableKinds.includes(failure.kind) &&
          definition.idempotency.mode !== "none" &&
          attemptNo < maxAttempts;
        if (!canRetry) break;
        if (definition.failureSemantics.backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, definition.failureSemantics.backoffMs));
        }
      }
    }
    return { ok: false, failure: lastFailure ?? internalFailure("execution failed"), attemptId: lastAttemptId };
  }

  private idempotencyKey(
    definition: CapabilityDefinition,
    input: unknown,
    explicit: string | undefined,
    inputHash: string,
  ): string | null {
    if (definition.idempotency.mode === "none") return null;
    if (definition.idempotency.mode === "input_hash") return inputHash;
    const keyField = definition.idempotency.keyField!;
    const value = (input as Record<string, unknown>)[keyField];
    const key = explicit ?? (typeof value === "string" ? value : undefined);
    if (!key) throw new Error(`explicit idempotency key is required in field ${keyField}`);
    return key;
  }

  private finishAttempt(
    attemptId: string,
    status: "succeeded" | "failed" | "canceled",
    failure: CapabilityFailure | null,
    output: unknown,
  ): void {
    this.registry.db.prepare(`
      UPDATE capability_attempts SET
        status = ?, failure_kind = ?, failure_json = ?, output_json = ?, ended_at = ?
      WHERE attempt_id = ?
    `).run(
      status,
      failure?.kind ?? null,
      failure ? JSON.stringify(failure) : null,
      output === null ? null : JSON.stringify(output as JsonValue),
      new Date().toISOString(),
      attemptId,
    );
  }
}
