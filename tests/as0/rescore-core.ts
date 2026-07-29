import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AssertionResult, AttemptEvidence, GoldenManifest, GoldenTask } from "./types";

export const AS0_RESCORE_POLICY_VERSION = 1;

const PREPARATION_TOOLS = new Set(["Skill", "Read", "AskUserQuestion"]);

export type ManualDecisionStatus = "pass" | "fail" | "not_observable";

export type ManualDecision = {
  taskId: string;
  attempt: number;
  assertionId: string;
  description: string;
  responseSha256: string;
  status: ManualDecisionStatus | null;
  reason: string;
};

export type ManualReview = {
  schemaVersion: 1;
  policyVersion: number;
  baselineId: string;
  reviewer: string;
  reviewedAt: string | null;
  decisions: ManualDecision[];
};

export type EffectiveAssertion = AssertionResult & {
  rawStatus: AssertionResult["status"];
  effectiveStatus: AssertionResult["status"];
  rescoreRule: string | null;
};

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function loadAttempts(baselineRoot: string): AttemptEvidence[] {
  const casesRoot = path.join(baselineRoot, "cases");
  const attempts: AttemptEvidence[] = [];
  for (const taskId of readdirSync(casesRoot).sort()) {
    const taskRoot = path.join(casesRoot, taskId);
    for (const attemptName of readdirSync(taskRoot).sort()) {
      const evidencePath = path.join(taskRoot, attemptName, `${attemptName}.json`);
      if (existsSync(evidencePath)) {
        attempts.push(JSON.parse(readFileSync(evidencePath, "utf8")) as AttemptEvidence);
      }
    }
  }
  return attempts;
}

export function createManualReview(args: {
  baselineId: string;
  attempts: AttemptEvidence[];
}): ManualReview {
  const decisions = args.attempts
    .filter((attempt) => attempt.invalidRunReason == null)
    .flatMap((attempt) =>
      attempt.assertions
        .filter((assertion) => assertion.status === "not_observable")
        .map((assertion) => ({
          taskId: attempt.taskId,
          attempt: attempt.attempt,
          assertionId: assertion.id,
          description: assertion.description,
          responseSha256: attempt.responseSha256,
          status: null,
          reason: "",
        }) satisfies ManualDecision),
    );
  return {
    schemaVersion: 1,
    policyVersion: AS0_RESCORE_POLICY_VERSION,
    baselineId: args.baselineId,
    reviewer: "",
    reviewedAt: null,
    decisions,
  };
}

function expressionHit(expression: string, tool: string): boolean {
  return expression.split("|").includes(tool);
}

function rescoreFirstTool(
  attempt: AttemptEvidence,
  task: GoldenTask,
): Pick<EffectiveAssertion, "effectiveStatus" | "actual" | "rescoreRule"> {
  const firstBusinessTool = attempt.toolCalls.find((tool) => !PREPARATION_TOOLS.has(tool)) ?? null;
  const expected = task.expected.firstToolOneOf ?? [];
  const textReadAlias = task.id === "AS0-04" && firstBusinessTool === null && attempt.toolCalls.includes("Read");
  const hit = textReadAlias || Boolean(
    firstBusinessTool && expected.some((expression) => expressionHit(expression, firstBusinessTool)),
  );
  return {
    effectiveStatus: hit ? "pass" : "fail",
    actual: firstBusinessTool ?? (textReadAlias ? "Read" : null),
    rescoreRule: textReadAlias ? "AS0-R2-text-read-alias" : "AS0-R1-preparation-tools",
  };
}

export function rescoreMachineAssertion(args: {
  attempt: AttemptEvidence;
  task: GoldenTask;
  assertion: AssertionResult;
}): EffectiveAssertion {
  const { attempt, task, assertion } = args;
  const base: EffectiveAssertion = {
    ...assertion,
    rawStatus: assertion.status,
    effectiveStatus: assertion.status,
    rescoreRule: null,
  };
  if (assertion.status === "not_observable") return base;

  if (assertion.id === "tool.first") {
    return { ...base, ...rescoreFirstTool(attempt, task) };
  }
  if (
    task.id === "AS0-04" &&
    assertion.id === "tool.required.read_document|read_file" &&
    attempt.toolCalls.includes("Read")
  ) {
    return {
      ...base,
      effectiveStatus: "pass",
      actual: attempt.toolCalls,
      rescoreRule: "AS0-R2-text-read-alias",
    };
  }
  return base;
}

function decisionKey(value: Pick<ManualDecision, "taskId" | "attempt" | "assertionId">): string {
  return `${value.taskId}:${value.attempt}:${value.assertionId}`;
}

export function validateManualReview(args: {
  review: ManualReview;
  baselineId: string;
  attempts: AttemptEvidence[];
}): void {
  const { review, baselineId, attempts } = args;
  if (review.schemaVersion !== 1) throw new Error(`不支持 review schemaVersion=${review.schemaVersion}`);
  if (review.policyVersion !== AS0_RESCORE_POLICY_VERSION) {
    throw new Error(`review policyVersion=${review.policyVersion}，当前要求 ${AS0_RESCORE_POLICY_VERSION}`);
  }
  if (review.baselineId !== baselineId) {
    throw new Error(`review baselineId=${review.baselineId}，当前 baselineId=${baselineId}`);
  }
  if (!review.reviewer.trim() || !review.reviewedAt) {
    throw new Error("reviewer 和 reviewedAt 必须填写");
  }

  const expected = createManualReview({ baselineId, attempts }).decisions;
  const expectedByKey = new Map(expected.map((decision) => [decisionKey(decision), decision]));
  const actualByKey = new Map<string, ManualDecision>();
  for (const decision of review.decisions) {
    const key = decisionKey(decision);
    if (actualByKey.has(key)) throw new Error(`重复人工结论: ${key}`);
    actualByKey.set(key, decision);
  }
  if (actualByKey.size !== expectedByKey.size) {
    throw new Error(`人工结论数量错误：期望 ${expectedByKey.size}，实际 ${actualByKey.size}`);
  }
  for (const [key, expectedDecision] of expectedByKey) {
    const decision = actualByKey.get(key);
    if (!decision) throw new Error(`缺少人工结论: ${key}`);
    if (decision.description !== expectedDecision.description) throw new Error(`断言描述不匹配: ${key}`);
    if (decision.responseSha256 !== expectedDecision.responseSha256) throw new Error(`response hash 不匹配: ${key}`);
    if (!decision.status) throw new Error(`人工结论未填写: ${key}`);
    if (!decision.reason.trim()) throw new Error(`人工结论缺少理由: ${key}`);
  }
}

export function buildRescoreResult(args: {
  baselineId: string;
  baselineRoot: string;
  manifest: GoldenManifest;
  attempts: AttemptEvidence[];
  review?: ManualReview;
}) {
  const taskById = new Map(args.manifest.tasks.map((task) => [task.id, task]));
  const manualByKey = new Map(
    (args.review?.decisions ?? []).map((decision) => [decisionKey(decision), decision]),
  );
  const rescoredAttempts = args.attempts.map((attempt) => {
    const task = taskById.get(attempt.taskId);
    if (!task) throw new Error(`manifest 缺少 ${attempt.taskId}`);
    const machine = attempt.assertions
      .filter((assertion) => assertion.status !== "not_observable")
      .map((assertion) => rescoreMachineAssertion({ attempt, task, assertion }));
    const manual = attempt.assertions
      .filter((assertion) => assertion.status === "not_observable")
      .map((assertion) => manualByKey.get(decisionKey({
        taskId: attempt.taskId,
        attempt: attempt.attempt,
        assertionId: assertion.id,
      })) ?? null);
    return {
      taskId: attempt.taskId,
      attempt: attempt.attempt,
      valid: attempt.invalidRunReason == null,
      sourceEvidenceSha256: sha256File(path.join(
        args.baselineRoot,
        "cases",
        attempt.taskId,
        `attempt-${String(attempt.attempt).padStart(2, "0")}`,
        `attempt-${String(attempt.attempt).padStart(2, "0")}.json`,
      )),
      responseSha256: attempt.responseSha256,
      machine,
      manual,
    };
  });
  const valid = rescoredAttempts.filter((attempt) => attempt.valid);
  const rawMachine = valid.flatMap((attempt) => attempt.machine);
  const manual = valid.flatMap((attempt) => attempt.manual).filter((decision) => decision != null);
  return {
    schemaVersion: 1,
    policyVersion: AS0_RESCORE_POLICY_VERSION,
    baselineId: args.baselineId,
    source: {
      manifestSha256: sha256File(path.join(args.baselineRoot, "manifest.json")),
      summarySha256: sha256File(path.join(args.baselineRoot, "summary.json")),
    },
    summary: {
      attempts: rescoredAttempts.length,
      validAttempts: valid.length,
      invalidAttempts: rescoredAttempts.length - valid.length,
      rawMachine: {
        passed: rawMachine.filter((assertion) => assertion.rawStatus === "pass").length,
        failed: rawMachine.filter((assertion) => assertion.rawStatus === "fail").length,
      },
      effectiveMachine: {
        passed: rawMachine.filter((assertion) => assertion.effectiveStatus === "pass").length,
        failed: rawMachine.filter((assertion) => assertion.effectiveStatus === "fail").length,
      },
      manual: {
        passed: manual.filter((decision) => decision.status === "pass").length,
        failed: manual.filter((decision) => decision.status === "fail").length,
        notObservable: manual.filter((decision) => decision.status === "not_observable").length,
        pending: valid.reduce((sum, attempt) => sum + attempt.manual.length, 0) - manual.length,
      },
    },
    attempts: rescoredAttempts,
  };
}
