/**
 * CR-M1: ModelConfig v2 + resolveExecutionModel 纯函数单测。
 * 运行: FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/model-config.test.ts
 */
import assert from "node:assert/strict";
import {
  MODEL_CONFIG_INCOMPLETE,
  getModelConfigReadiness,
  migrateModelConfig,
  normalizeModelId,
  resolveExecutionModel,
  validateModelConfig,
  type ModelConfigV2,
} from "../lib/settings/model-config.ts";

const { equal, deepEqual } = assert;

const FULL: ModelConfigV2 = {
  version: 2,
  mainModel: "reasoning-model",
  routerModel: "fast-model",
  subagentModel: "fast-model",
};

export const modelConfigTestPromise = (async () => {
  // ── validate: null / 完整合法 / 部分非法 ─────────────────────────────
  {
    equal(validateModelConfig(null), null, "null 配置合法(未配置)");
    deepEqual(validateModelConfig(FULL), FULL, "完整 v2 应原样通过");

    equal(validateModelConfig({ version: 2, mainModel: "a", routerModel: "b", subagentModel: "" }), null, "缺一槽非法");
    equal(validateModelConfig({ version: 2, mainModel: "a", routerModel: "", subagentModel: "c" }), null);
    equal(validateModelConfig({ version: 2, mainModel: "", routerModel: "b", subagentModel: "c" }), null);
    deepEqual(
      validateModelConfig({ version: 2, mainModel: "  a  ", routerModel: "b", subagentModel: "c" }),
      { version: 2, mainModel: "a", routerModel: "b", subagentModel: "c" },
      "应 trim",
    );
  }

  // ── normalizeModelId: 长度与控制字符 ─────────────────────────────────
  {
    equal(normalizeModelId(""), null);
    equal(normalizeModelId("   "), null);
    equal(normalizeModelId("ok-model"), "ok-model");
    equal(normalizeModelId("  ok-model  "), "ok-model");
    equal(normalizeModelId("a".repeat(201)), null, "超过 200 非法");
    equal(normalizeModelId("a".repeat(200)), "a".repeat(200));
    equal(normalizeModelId("bad\nmodel"), null, "换行非法");
    equal(normalizeModelId("bad\tmodel"), null, "控制字符非法");
  }

  // ── migrate: 三类旧配置 + 幂等 + 全空→null ───────────────────────────
  {
    deepEqual(
      migrateModelConfig({ routerModel: "fast", subagentModel: "reason", model: "" }),
      { version: 2, mainModel: "reason", routerModel: "fast", subagentModel: "fast" },
      "旧推理(subagent)应迁入 main; 快速槽共享 router",
    );

    deepEqual(
      migrateModelConfig({ model: "only-one" }),
      { version: 2, mainModel: "only-one", routerModel: "only-one", subagentModel: "only-one" },
    );

    deepEqual(
      migrateModelConfig({ mainModel: "main", subagentModel: "old-reason", routerModel: "fast" }),
      { version: 2, mainModel: "main", routerModel: "fast", subagentModel: "fast" },
    );

    equal(migrateModelConfig({}), null);
    equal(migrateModelConfig({ mainModel: "", routerModel: "", subagentModel: "", model: "" }), null);

    const once = migrateModelConfig({ routerModel: "f", subagentModel: "r" })!;
    deepEqual(migrateModelConfig(once), once, "迁移必须幂等");
    deepEqual(migrateModelConfig({ ...once, model: "ignored" }), once, "迁移后 model 不再参与");
  }

  // ── resolver 全矩阵 ─────────────────────────────────────────────────
  {
    deepEqual(
      resolveExecutionModel({ config: FULL, purpose: "router" }),
      { modelId: "fast-model", modelRole: "router", executionTier: "fast" },
    );
    deepEqual(
      resolveExecutionModel({ config: FULL, purpose: "title" }),
      { modelId: "fast-model", modelRole: "router", executionTier: "fast" },
    );
    deepEqual(
      resolveExecutionModel({ config: FULL, purpose: "task", intent: "tool_task", tier: "fast" }),
      { modelId: "fast-model", modelRole: "router", executionTier: "fast" },
    );
    deepEqual(
      resolveExecutionModel({ config: FULL, purpose: "task", intent: "complex_workflow", tier: "fast" }),
      { modelId: "reasoning-model", modelRole: "main", executionTier: "reasoning" },
      "complex+fast → mainModel/reasoning",
    );
    deepEqual(
      resolveExecutionModel({ config: FULL, purpose: "task", intent: "tool_task", tier: "reasoning" }),
      { modelId: "reasoning-model", modelRole: "main", executionTier: "reasoning" },
    );
    deepEqual(
      resolveExecutionModel({ config: FULL, purpose: "specialist" }),
      { modelId: "reasoning-model", modelRole: "main", executionTier: "reasoning" },
    );
    deepEqual(
      resolveExecutionModel({ config: FULL, purpose: "subagent" }),
      { modelId: "fast-model", modelRole: "subagent", executionTier: "fast" },
    );
    deepEqual(
      resolveExecutionModel({ config: FULL, purpose: "summary" }),
      { modelId: "reasoning-model", modelRole: "main", executionTier: "reasoning" },
    );
  }

  // ── Router 三种失败原因 → mainModel + fallbackReason ────────────────
  {
    for (const reason of ["router_timeout", "router_invalid", "router_disabled"] as const) {
      deepEqual(
        resolveExecutionModel({ config: FULL, purpose: "router_fallback", fallbackReason: reason }),
        {
          modelId: "reasoning-model",
          modelRole: "main",
          executionTier: "reasoning",
          fallbackReason: reason,
        },
        `fail-safe ${reason}`,
      );
    }
  }

  // ── 相同模型 ID 下 executionTier 仍正确 ──────────────────────────────
  {
    const same: ModelConfigV2 = {
      version: 2,
      mainModel: "shared-id",
      routerModel: "shared-id",
      subagentModel: "shared-id",
    };
    equal(resolveExecutionModel({ config: same, purpose: "router" }).executionTier, "fast");
    equal(resolveExecutionModel({ config: same, purpose: "subagent" }).executionTier, "fast");
    equal(resolveExecutionModel({ config: same, purpose: "summary" }).executionTier, "reasoning");
    equal(
      resolveExecutionModel({ config: same, purpose: "task", intent: "complex_workflow", tier: "fast" }).executionTier,
      "reasoning",
    );
  }

  // ── readiness helpers ───────────────────────────────────────────────
  {
    equal(MODEL_CONFIG_INCOMPLETE, "MODEL_CONFIG_INCOMPLETE");
    deepEqual(getModelConfigReadiness(FULL), { modelConfigReady: true, missingModelRoles: [] });
    // 仅 router 推不出 main（迁移规则不含 router→main）
    deepEqual(
      getModelConfigReadiness({ routerModel: "fast" }),
      { modelConfigReady: false, missingModelRoles: ["main"] },
    );
    // 仅 subagent 可推出三槽（旧推理模型）
    deepEqual(
      getModelConfigReadiness({ subagentModel: "reason" }),
      { modelConfigReady: true, missingModelRoles: [] },
    );
    deepEqual(
      getModelConfigReadiness({}),
      { modelConfigReady: false, missingModelRoles: ["main", "router", "subagent"] },
    );
  }

  console.log("model-config tests passed");
})();

if (process.argv[1]?.includes("model-config.test")) {
  modelConfigTestPromise.catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
