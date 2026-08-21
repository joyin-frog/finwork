import assert from "node:assert/strict";
import {
  MODEL_CONFIG_INCOMPLETE,
  getModelConfigReadiness,
  normalizeModelId,
  parseModelFieldsFromBody,
  resolveExecutionModel,
  validateModelConfig,
  type ModelConfigV3,
} from "../lib/settings/model-config.ts";

const { equal, deepEqual } = assert;
const FULL: ModelConfigV3 = {
  version: 3,
  fastModel: "fast-model",
  reasoningModel: "reasoning-model",
};

export const modelConfigTestPromise = (async () => {
  equal(validateModelConfig(null), null);
  deepEqual(validateModelConfig(FULL), FULL);
  equal(validateModelConfig({ version: 3, fastModel: "a", reasoningModel: "" }), null);
  deepEqual(
    validateModelConfig({ version: 3, fastModel: "  a  ", reasoningModel: " b " }),
    { version: 3, fastModel: "a", reasoningModel: "b" },
  );

  equal(normalizeModelId(""), null);
  equal(normalizeModelId("ok-model"), "ok-model");
  equal(normalizeModelId("a".repeat(201)), null);
  equal(normalizeModelId("bad\nmodel"), null);

  deepEqual(resolveExecutionModel({ config: FULL, purpose: "router" }), {
    modelId: "fast-model",
    executionRole: "router",
    executionTier: "fast",
  });
  deepEqual(resolveExecutionModel({ config: FULL, purpose: "task", tier: "fast" }), {
    modelId: "fast-model",
    executionRole: "agent",
    executionTier: "fast",
  });
  deepEqual(resolveExecutionModel({ config: FULL, purpose: "task", tier: "reasoning" }), {
    modelId: "reasoning-model",
    executionRole: "agent",
    executionTier: "reasoning",
  });
  deepEqual(resolveExecutionModel({ config: FULL, purpose: "subagent", tier: "reasoning" }), {
    modelId: "reasoning-model",
    executionRole: "subagent",
    executionTier: "reasoning",
  });
  deepEqual(resolveExecutionModel({
    config: FULL,
    purpose: "task",
    tier: "fast",
    fallbackReason: "router_timeout",
  }), {
    modelId: "fast-model",
    executionRole: "agent",
    executionTier: "fast",
    fallbackReason: "router_timeout",
  });

  equal(MODEL_CONFIG_INCOMPLETE, "MODEL_CONFIG_INCOMPLETE");
  deepEqual(getModelConfigReadiness(FULL), { modelConfigReady: true, missingModelTiers: [] });
  deepEqual(getModelConfigReadiness({ fastModel: "fast" }), {
    modelConfigReady: false,
    missingModelTiers: ["reasoning"],
  });
  deepEqual(getModelConfigReadiness({}), {
    modelConfigReady: false,
    missingModelTiers: ["fast", "reasoning"],
  });

  deepEqual(parseModelFieldsFromBody({ fastModel: "f", reasoningModel: "r" }), {
    kind: "ok",
    config: { version: 3, fastModel: "f", reasoningModel: "r" },
  });
  equal(parseModelFieldsFromBody({ fastModel: "f" }).kind, "invalid");

  console.log("model-config tests passed");
})();

if (process.argv[1]?.includes("model-config.test")) {
  modelConfigTestPromise.catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
