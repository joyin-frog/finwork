import assert from "node:assert/strict";
import { z } from "zod";
import {
  CapabilityExecutionResultSchema,
  CapabilityFailureSchema,
} from "../lib/capability/contracts.ts";

export const capabilityNoSilentDegradeTestPromise = (async () => {
  const outputSchema = z.object({ documentId: z.number().int().positive() }).strict();
  const resultSchema = CapabilityExecutionResultSchema(outputSchema);

  assert.equal(
    resultSchema.safeParse({ ok: true, output: { documentId: 1 } }).success,
    true,
    "successful capability execution must carry validated output",
  );
  assert.equal(
    resultSchema.safeParse({
      ok: false,
      failure: {
        kind: "dependency_unavailable",
        code: "ocr_runtime_unavailable",
        message: "OCR runtime is unavailable",
        retryable: false,
        details: { provider: "local" },
      },
    }).success,
    true,
    "dependency failure must be surfaced as a typed failure",
  );
  assert.equal(
    resultSchema.safeParse({
      ok: true,
      output: { documentId: 1 },
      warning: "OCR failed; raw-text fallback used",
    }).success,
    false,
    "a successful result must not smuggle a silent degradation field",
  );
  assert.equal(
    CapabilityFailureSchema.safeParse({
      kind: "capability_missing",
      code: "web_search_missing",
      message: "No web-search provider is configured",
      retryable: true,
    }).success,
    false,
    "capability_missing must never be retried or disguised as success",
  );
  assert.equal(
    CapabilityFailureSchema.safeParse({
      kind: "transient_external_failure",
      code: "provider_timeout",
      message: "Provider timed out",
      retryable: false,
    }).success,
    false,
    "transient provider failures must be explicitly retryable",
  );

  console.log("capability no-silent-degrade contract: typed failure boundary verified");
})();
