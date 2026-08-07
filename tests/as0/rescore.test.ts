import assert from "node:assert/strict";
import { loadManifest } from "./manifest";
import {
  AS0_RESCORE_POLICY_VERSION,
  createManualReview,
  rescoreMachineAssertion,
  validateManualReview,
} from "./rescore-core";
import { parseRescoreArgs } from "./rescore";
import type { AttemptEvidence } from "./types";

const { manifest } = loadManifest();

function attempt(overrides: Partial<AttemptEvidence> = {}): AttemptEvidence {
  return {
    schemaVersion: 1,
    taskId: "AS0-07",
    attempt: 1,
    runtime: "claude-agent-sdk",
    providerProtocol: "anthropic-messages",
    model: "MiniMax-M3",
    sessionIdRedacted: null,
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
    outcome: "completed",
    terminationReason: null,
    toolCalls: ["Read", "check_reimbursement_batch"],
    skillLoads: [],
    confirmations: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0,
      turns: 1,
      models: ["MiniMax-M3"],
    },
    assertions: [],
    completionEvidence: [],
    deliverables: [],
    sideEffects: {
      before: { files: [], database: {}, memorySha256: null },
      atSettlement: { files: [], database: {}, memorySha256: null },
      after: { files: [], database: {}, memorySha256: null },
    },
    responseSha256: "abc",
    evidencePaths: [],
    invalidRunReason: null,
    capabilityGaps: [],
    ...overrides,
  };
}

export const as0RescoreTestPromise = (async () => {
  assert.equal(AS0_RESCORE_POLICY_VERSION, 1);
  assert.throws(() => parseRescoreArgs([]), /--baseline/);
  assert.equal(parseRescoreArgs(["--baseline", "."]).baselineRoot, process.cwd());

  const task = manifest.tasks.find((item) => item.id === "AS0-07")!;
  const first = rescoreMachineAssertion({
    task,
    attempt: attempt(),
    assertion: {
      id: "tool.first",
      description: "首次业务工具",
      status: "fail",
      actual: "Read",
    },
  });
  assert.equal(first.rawStatus, "fail");
  assert.equal(first.effectiveStatus, "pass");
  assert.equal(first.rescoreRule, "AS0-R1-preparation-tools");

  const textTask = manifest.tasks.find((item) => item.id === "AS0-04")!;
  const requiredRead = rescoreMachineAssertion({
    task: textTask,
    attempt: attempt({ taskId: "AS0-04", toolCalls: ["Read"] }),
    assertion: {
      id: "tool.required.read_document|read_file",
      description: "必须读取文档",
      status: "fail",
    },
  });
  assert.equal(requiredRead.effectiveStatus, "pass");
  assert.equal(requiredRead.rescoreRule, "AS0-R2-text-read-alias");

  const reviewAttempt = attempt({
    taskId: "AS0-01",
    assertions: [{ id: "business.1", description: "回答简洁", status: "not_observable" }],
  });
  const review = createManualReview({ baselineId: "baseline-1", attempts: [reviewAttempt] });
  assert.equal(review.decisions.length, 1);
  assert.throws(
    () => validateManualReview({ review, baselineId: "baseline-1", attempts: [reviewAttempt] }),
    /reviewer 和 reviewedAt/,
  );
  review.reviewer = "reviewer";
  review.reviewedAt = new Date(0).toISOString();
  review.decisions[0].status = "pass";
  review.decisions[0].reason = "已核对回答";
  assert.doesNotThrow(() =>
    validateManualReview({ review, baselineId: "baseline-1", attempts: [reviewAttempt] }),
  );
})();
