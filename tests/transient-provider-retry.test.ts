import assert from "node:assert/strict";
import {
  classifyTransientProviderError,
  withTransientProviderRetry,
} from "../lib/evaluation/transient-provider-retry.ts";

export const transientProviderRetryTestPromise = (async () => {
  assert.equal(classifyTransientProviderError(Object.assign(new Error("overloaded"), { status: 529 })).retryable, true);
  assert.equal(classifyTransientProviderError(new Error("API Error: 429 rate limit")).retryable, true);
  assert.equal(classifyTransientProviderError(Object.assign(new Error("socket reset"), { code: "ECONNRESET" })).retryable, true);
  assert.equal(classifyTransientProviderError(new Error("foundation capability gate failed: spreadsheet.write")).retryable, false);
  assert.equal(classifyTransientProviderError(Object.assign(new Error("forbidden"), { status: 403 })).retryable, false);
  assert.equal(classifyTransientProviderError(new Error("deterministic validation failed: formula mismatch")).retryable, false);
  assert.equal(classifyTransientProviderError(new Error("unknown business failure")).retryable, false);

  let calls = 0;
  const delays: number[] = [];
  const recovered = await withTransientProviderRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("provider overloaded"), { statusCode: 529 });
    return "ok";
  }, {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 50,
    sleep: async (delayMs) => { delays.push(delayMs); },
  });
  assert.deepEqual(recovered, { value: "ok", attempts: 3 });
  assert.deepEqual(delays, [10, 20]);

  calls = 0;
  await assert.rejects(
    withTransientProviderRetry(async () => {
      calls++;
      throw new Error("capability gate failed: analyze_tabular was not executed");
    }, { maxAttempts: 3, sleep: async () => undefined }),
    /capability gate failed/,
  );
  assert.equal(calls, 1, "contract failures must not consume provider retry attempts");

  calls = 0;
  await assert.rejects(
    withTransientProviderRetry(async () => {
      calls++;
      throw Object.assign(new Error("still overloaded"), { status: 503 });
    }, { maxAttempts: 2, sleep: async () => undefined }),
    /still overloaded/,
  );
  assert.equal(calls, 2, "transient retries must remain bounded");

  calls = 0;
  await assert.rejects(
    withTransientProviderRetry(async () => {
      calls++;
      throw Object.assign(new Error("invalid API key"), { status: 401 });
    }, { maxAttempts: 3, sleep: async () => undefined }),
    /invalid API key/,
  );
  assert.equal(calls, 1, "authentication failures must never be retried");

  calls = 0;
  const retryAfterDelays: number[] = [];
  const retryAfterResult = await withTransientProviderRetry(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 37 });
    return "recovered";
  }, {
    maxAttempts: 2,
    baseDelayMs: 10,
    maxDelayMs: 100,
    sleep: async (delayMs) => { retryAfterDelays.push(delayMs); },
  });
  assert.deepEqual(retryAfterResult, { value: "recovered", attempts: 2 });
  assert.deepEqual(retryAfterDelays, [37], "Retry-After must override a shorter exponential delay");

  calls = 0;
  await assert.rejects(
    withTransientProviderRetry(async () => {
      calls++;
      throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
    }, {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 50,
      deadlineAt: 150,
      now: () => 100,
      sleep: async () => undefined,
    }),
    /deadline exceeded/,
  );
  assert.equal(calls, 1, "a retry that cannot fit before the deadline must not start");

  calls = 0;
  const abortController = new AbortController();
  await assert.rejects(
    withTransientProviderRetry(async () => {
      calls++;
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }, {
      maxAttempts: 3,
      signal: abortController.signal,
      onRetry: () => abortController.abort("user canceled"),
      sleep: async () => undefined,
    }),
    /user canceled/,
  );
  assert.equal(calls, 1, "cancellation must prevent background retry attempts");

  console.log("transient-provider-retry: strict classification and bounded retries passed ✓");
})();

if (process.argv[1]?.includes("transient-provider-retry.test")) {
  transientProviderRetryTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
