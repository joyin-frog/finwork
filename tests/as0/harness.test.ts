import assert from "node:assert/strict";
import {
  buildTaskContract,
  evaluateAttempt,
  normalizeSkillName,
  sanitizeSettingsJson,
} from "./harness-core";
import { buildPlan, assertLiveAuthorized, parseArgs } from "./run";
import { loadManifest, selectTasks } from "./manifest";
import type { RuntimeEventRecord } from "./types";
import { as0RescoreTestPromise } from "./rescore.test";

export const as0HarnessTestPromise = (async () => {
  await as0RescoreTestPromise;
  const { manifest } = loadManifest();
  assert.equal(manifest.tasks.length, 20);

  const selected = selectTasks(manifest, ["AS0-01", "AS0-20"]);
  assert.deepEqual(selected.map((task) => task.id), ["AS0-01", "AS0-20"]);
  assert.throws(() => selectTasks(manifest, ["AS0-99"]), /未知 AS0 task/);

  const plan = buildPlan(selected);
  assert.equal(plan[0].attempts, 3);
  assert.equal(plan[1].attempts, 2);
  assert.equal(plan[0].estimatedRuntimeCalls, 3);

  assert.deepEqual(parseArgs(["--plan", "--cases", "AS0-01,AS0-02", "--attempts", "1"]).taskIds, ["AS0-01", "AS0-02"]);
  assert.throws(() => parseArgs(["--attempts", "0"]), /正整数/);
  assert.throws(
    () => assertLiveAuthorized({ live: true, allowDirty: false, taskIds: [] }, {}),
    /AS0_ALLOW_LIVE=1/,
  );
  assert.doesNotThrow(() =>
    assertLiveAuthorized(
      { live: true, allowDirty: false, taskIds: [] },
      { AS0_ALLOW_LIVE: "1" },
    ),
  );

  const sanitized = sanitizeSettingsJson({
    agent: {
      apiKey: "secret",
      reasoningModel: "model-a",
      companyName: "真实公司",
      userName: "真实用户",
      userAvatar: "data:image/png;base64,secret",
      telemetryEnabled: true,
      telemetryToken: "secret-token",
    },
    nested: [{ apiKEY: "secret-2", keep: true }],
  }) as { agent: Record<string, unknown>; nested: Array<Record<string, unknown>> };
  assert.equal("apiKey" in sanitized.agent, false);
  assert.equal("apiKEY" in sanitized.nested[0], false);
  assert.equal("telemetryToken" in sanitized.agent, false);
  assert.equal("userAvatar" in sanitized.agent, false);
  assert.equal(sanitized.agent.companyName, "AS0 测试公司");
  assert.equal(sanitized.agent.userName, "AS0 测试用户");
  assert.equal(sanitized.agent.telemetryEnabled, false);
  assert.equal(sanitized.agent.reasoningModel, "model-a");

  const deliveryTask = manifest.tasks.find((task) => task.id === "AS0-17")!;
  const contract = buildTaskContract(deliveryTask);
  assert.equal(contract.requiredDeliverables.length, 2);
  assert.deepEqual(contract.requiredDeliverables.map((item) => item.id), ["workbook", "document"]);

  const task = manifest.tasks.find((candidate) => candidate.id === "AS0-03")!;
  const events: RuntimeEventRecord[] = [
    {
      at: new Date(0).toISOString(),
      event: { type: "tool_started", toolName: "search_knowledge" },
    },
  ];
  const evaluated = evaluateAttempt({ task, events, confirmations: [], completionEvidence: [] });
  assert.deepEqual(evaluated.toolCalls, ["search_knowledge"]);
  assert.equal(evaluated.assertions.find((item) => item.id.startsWith("tool.required"))?.status, "pass");
  assert.ok(evaluated.assertions.some((item) => item.status === "not_observable"));
  assert.equal(normalizeSkillName("finance-skills:xlsx"), "xlsx");

  const abortTask = manifest.tasks.find((candidate) => candidate.id === "AS0-20")!;
  const abortEvaluation = evaluateAttempt({
    task: abortTask,
    events: [{
      at: new Date(0).toISOString(),
      event: {
        type: "tool_started",
        toolName: "Skill",
        input: { skill: "finance-skills:xlsx" },
      },
    }],
    confirmations: [],
    completionEvidence: [],
  });
  assert.equal(abortEvaluation.assertions.find((item) => item.id === "skill.xlsx|docx")?.status, "pass");
})();
