const TRANSIENT_HTTP_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const NON_RETRYABLE_HTTP_STATUS = new Set([400, 401, 403, 404, 405, 409, 410, 422]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const NON_RETRYABLE_MESSAGE =
  /capability gate failed|deterministic validation|validation failed|invalid input|permission denied|policy blocked|unauthori[sz]ed|authentication|invalid api key|api key|model[^\n]*(?:not found|invalid)|\b(?:400|401|403|404|405|409|410|422)\b/i;
const TRANSIENT_MESSAGE =
  /\b(?:429|500|502|503|504|529)\b|rate.?limit|too many requests|overload(?:ed)?|temporar(?:y|ily) unavailable|service unavailable|gateway timeout|bad gateway|timed?\s*out|timeout|unexpected eof|econnreset|econnrefused|socket hang up|connection (?:closed|reset)|stream (?:closed|error)|fetch failed/i;

type UnknownRecord = Record<string, unknown>;

export type ProviderRetryDecision = {
  retryable: boolean;
  reason: string;
  status?: number;
  retryAfterMs?: number;
};

export type ProviderRetryAttempt = {
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  decision: ProviderRetryDecision;
  error: unknown;
};

export type ProviderRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (attempt: ProviderRetryAttempt) => void | Promise<void>;
  /**
   * Last-mile production guard. A transient provider error is retryable only
   * while the caller can prove that the failed attempt had no externally
   * visible runtime/tool activity.
   */
  shouldRetry?: (attempt: ProviderRetryAttempt) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  /** Absolute epoch milliseconds. No operation or sleep may begin past it. */
  deadlineAt?: number;
  now?: () => number;
};

export type ProviderRetryResult<T> = {
  value: T;
  attempts: number;
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null ? value as UnknownRecord : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

function collectErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current) && chain.length < 8) {
    chain.push(current);
    seen.add(current);
    current = asRecord(current)?.cause;
  }
  return chain;
}

function extractStatus(chain: unknown[]): number | undefined {
  for (const item of chain) {
    const record = asRecord(item);
    if (!record) continue;
    for (const key of ["status", "statusCode", "httpStatus"]) {
      const status = finiteNumber(record[key]);
      if (status !== undefined) return status;
    }
  }
  return undefined;
}

function extractCode(chain: unknown[]): string | undefined {
  for (const item of chain) {
    const code = asRecord(item)?.code;
    if (typeof code === "string" && code.trim()) return code.trim().toUpperCase();
  }
  return undefined;
}

function extractRetryAfterMs(chain: unknown[]): number | undefined {
  for (const item of chain) {
    const record = asRecord(item);
    if (!record) continue;
    const direct = finiteNumber(record.retryAfterMs);
    if (direct !== undefined && direct >= 0) return direct;
    const seconds = finiteNumber(record.retryAfter);
    if (seconds !== undefined && seconds >= 0) return seconds * 1_000;
  }
  return undefined;
}

function errorText(chain: unknown[]): string {
  return chain.map((item) => {
    if (item instanceof Error) return `${item.name}: ${item.message}`;
    if (typeof item === "string") return item;
    const record = asRecord(item);
    return typeof record?.message === "string" ? record.message : "";
  }).filter(Boolean).join(" | ");
}

export function classifyTransientProviderError(error: unknown): ProviderRetryDecision {
  const chain = collectErrorChain(error);
  const status = extractStatus(chain);
  const code = extractCode(chain);
  const text = errorText(chain);
  const retryAfterMs = extractRetryAfterMs(chain);

  if ((status !== undefined && NON_RETRYABLE_HTTP_STATUS.has(status)) || NON_RETRYABLE_MESSAGE.test(text)) {
    return { retryable: false, reason: "non_retryable_request_or_contract_failure", status };
  }
  if (status !== undefined && TRANSIENT_HTTP_STATUS.has(status)) {
    return { retryable: true, reason: `transient_http_${status}`, status, retryAfterMs };
  }
  if (code && TRANSIENT_CODES.has(code)) {
    return { retryable: true, reason: `transient_transport_${code.toLowerCase()}`, status, retryAfterMs };
  }
  if (TRANSIENT_MESSAGE.test(text)) {
    return { retryable: true, reason: "transient_provider_or_transport_message", status, retryAfterMs };
  }
  return { retryable: false, reason: "unclassified_failure", status };
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason ? reason : "operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfStopped(signal: AbortSignal | undefined, deadlineAt: number | undefined, now: () => number): void {
  if (signal?.aborted) throw abortError(signal.reason);
  if (deadlineAt !== undefined && now() >= deadlineAt) {
    const error = new Error("provider retry deadline exceeded");
    error.name = "TimeoutError";
    throw error;
  }
}

async function abortableSleep(
  delayMs: number,
  sleep: (delayMs: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(delayMs);
  if (signal.aborted) throw abortError(signal.reason);
  await Promise.race([
    sleep(delayMs),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError(signal.reason)), { once: true });
    }),
  ]);
}

export async function withTransientProviderRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: ProviderRetryOptions = {},
): Promise<ProviderRetryResult<T>> {
  const maxAttempts = boundedInteger(options.maxAttempts, 3, 1, 5);
  const baseDelayMs = boundedInteger(options.baseDelayMs, 1_000, 0, 60_000);
  const maxDelayMs = boundedInteger(options.maxDelayMs, 8_000, 0, 60_000);
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped(options.signal, options.deadlineAt, now);
    try {
      return { value: await operation(attempt), attempts: attempt };
    } catch (error) {
      const decision = classifyTransientProviderError(error);
      if (!decision.retryable || attempt >= maxAttempts) throw error;
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      let delayMs = Math.min(maxDelayMs, Math.max(exponentialDelay, decision.retryAfterMs ?? 0));
      if (options.deadlineAt !== undefined) {
        const remainingMs = options.deadlineAt - now();
        if (remainingMs <= 0 || delayMs >= remainingMs) {
          const timeout = new Error("provider retry deadline exceeded before next attempt");
          timeout.name = "TimeoutError";
          throw timeout;
        }
        delayMs = Math.min(delayMs, remainingMs - 1);
      }
      const retryAttempt = { attempt, nextAttempt: attempt + 1, delayMs, decision, error };
      if (options.shouldRetry && !(await options.shouldRetry(retryAttempt))) throw error;
      await options.onRetry?.(retryAttempt);
      await abortableSleep(delayMs, sleep, options.signal);
      throwIfStopped(options.signal, options.deadlineAt, now);
    }
  }

  throw new Error("provider retry loop exhausted without a result");
}
