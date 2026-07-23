/**
 * ModelConfig v2 + 纯 resolveExecutionModel（CR-M1）。
 * 三槽原子配置；运行时唯一模型解析入口。Query Pipeline 接线归 CR-R1。
 */

export type ModelRole = "main" | "router" | "subagent";
export type ExecutionTier = "reasoning" | "fast";

export type ModelConfigV2 = {
  version: 2;
  mainModel: string;
  routerModel: string;
  subagentModel: string;
};

export type ModelConfigState = ModelConfigV2 | null;

export type ResolvedModel = {
  modelId: string;
  modelRole: ModelRole;
  executionTier: ExecutionTier;
  fallbackReason?: "router_timeout" | "router_invalid" | "router_disabled";
};

export type LegacyModelFields = {
  version?: number;
  mainModel?: string;
  routerModel?: string;
  subagentModel?: string;
  /** 仅参与一次迁移，迁移后不再参与运行时选择 */
  model?: string;
};

export type ResolvePurpose =
  | "router"
  | "title"
  | "task"
  | "subagent"
  | "summary"
  | "specialist"
  | "router_fallback";

export type ResolveExecutionModelInput = {
  config: ModelConfigV2;
  purpose: ResolvePurpose;
  /** purpose=task 时的 router intent */
  intent?: string;
  /** purpose=task 时的用户档位；缺省按 fast */
  tier?: "fast" | "reasoning";
  /** purpose=router_fallback */
  fallbackReason?: "router_timeout" | "router_invalid" | "router_disabled";
};

export const MODEL_CONFIG_INCOMPLETE = "MODEL_CONFIG_INCOMPLETE";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** trim 后 1–200 字符，禁止换行与控制字符；非法返回 null。 */
export function normalizeModelId(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

/**
 * 校验完整 v2 或 null。部分配置 / 非法 ID → null（调用方应拒绝写入）。
 * 合法非空配置会 trim 后返回。
 */
export function validateModelConfig(
  input: ModelConfigV2 | null | (Partial<ModelConfigV2> & { version?: number }) | undefined,
): ModelConfigState {
  if (input == null) return null;
  const mainModel = normalizeModelId(input.mainModel);
  const routerModel = normalizeModelId(input.routerModel);
  const subagentModel = normalizeModelId(input.subagentModel);
  if (!mainModel || !routerModel || !subagentModel) return null;
  return { version: 2, mainModel, routerModel, subagentModel };
}

/**
 * 旧配置迁移规则（精确）:
 *   mainModel     = old.mainModel || old.subagentModel || old.model
 *   routerModel   = old.routerModel || old.model || old.subagentModel
 *   subagentModel = old.routerModel || old.model || old.subagentModel
 * 三槽均可推导才返回 v2，否则 null。幂等。
 */
export function migrateModelConfig(old: LegacyModelFields | null | undefined): ModelConfigState {
  if (!old) return null;
  const mainRaw = old.mainModel || old.subagentModel || old.model || "";
  const routerRaw = old.routerModel || old.model || old.subagentModel || "";
  const subRaw = old.routerModel || old.model || old.subagentModel || "";
  return validateModelConfig({
    version: 2,
    mainModel: mainRaw,
    routerModel: routerRaw,
    subagentModel: subRaw,
  });
}

/** 从设置对象得到就绪状态（含迁移推导）。供 doctor / first-run 后续调用。 */
export function getModelConfigReadiness(settings: LegacyModelFields | null | undefined): {
  modelConfigReady: boolean;
  missingModelRoles: ModelRole[];
} {
  const config = migrateModelConfig(settings ?? {});
  if (config) return { modelConfigReady: true, missingModelRoles: [] };

  const s = settings ?? {};
  const main = normalizeModelId(s.mainModel || s.subagentModel || s.model || "");
  const router = normalizeModelId(s.routerModel || s.model || s.subagentModel || "");
  const sub = normalizeModelId(s.routerModel || s.model || s.subagentModel || "");
  const missing: ModelRole[] = [];
  if (!main) missing.push("main");
  if (!router) missing.push("router");
  if (!sub) missing.push("subagent");
  return { modelConfigReady: false, missingModelRoles: missing };
}

/**
 * 唯一纯模型解析器。矩阵见 spec-model-routing-v2.md。
 * Router 失败不得落到快速模型——一律 mainModel + fallbackReason。
 */
export function resolveExecutionModel(input: ResolveExecutionModelInput): ResolvedModel {
  const { config, purpose } = input;

  if (purpose === "router_fallback") {
    const reason = input.fallbackReason ?? "router_invalid";
    return {
      modelId: config.mainModel,
      modelRole: "main",
      executionTier: "reasoning",
      fallbackReason: reason,
    };
  }

  if (purpose === "router" || purpose === "title") {
    return { modelId: config.routerModel, modelRole: "router", executionTier: "fast" };
  }

  if (purpose === "subagent") {
    return { modelId: config.subagentModel, modelRole: "subagent", executionTier: "fast" };
  }

  if (purpose === "summary" || purpose === "specialist") {
    return { modelId: config.mainModel, modelRole: "main", executionTier: "reasoning" };
  }

  // purpose === "task"
  const tier = input.tier === "reasoning" ? "reasoning" : "fast";
  if (tier === "reasoning" || input.intent === "complex_workflow") {
    return { modelId: config.mainModel, modelRole: "main", executionTier: "reasoning" };
  }
  return { modelId: config.routerModel, modelRole: "router", executionTier: "fast" };
}

/** 从设置字段取 ModelConfigState（经迁移）。 */
export function modelConfigFromSettings(settings: LegacyModelFields | null | undefined): ModelConfigState {
  return migrateModelConfig(settings ?? {});
}

/**
 * UI fast/reasoning → 三槽映射。
 * routerModel = subagentModel = fastModel; mainModel = reasoningModel。
 */
export function mapFastReasoningToSlots(fastModel: string, reasoningModel: string): ModelConfigState {
  return validateModelConfig({
    version: 2,
    mainModel: reasoningModel,
    routerModel: fastModel,
    subagentModel: fastModel,
  });
}

export type ModelFieldErrors = {
  fastModel?: string;
  reasoningModel?: string;
  mainModel?: string;
  routerModel?: string;
  subagentModel?: string;
};

/**
 * 解析设置 API body 中的模型字段。
 * - 提供 fastModel/reasoningModel → 映射三槽
 * - 或提供三槽之一 → 要求三槽齐全
 * - 均未提供 → { kind: "omit" }（不更新模型）
 * - 提供但不完整/非法 → { kind: "invalid", errors }
 */
export function parseModelFieldsFromBody(body: {
  fastModel?: string;
  reasoningModel?: string;
  mainModel?: string;
  routerModel?: string;
  subagentModel?: string;
}):
  | { kind: "omit" }
  | { kind: "ok"; config: ModelConfigV2 }
  | { kind: "invalid"; errors: ModelFieldErrors } {
  const hasFastPair = body.fastModel !== undefined || body.reasoningModel !== undefined;
  const hasSlots =
    body.mainModel !== undefined || body.routerModel !== undefined || body.subagentModel !== undefined;

  if (!hasFastPair && !hasSlots) return { kind: "omit" };

  if (hasFastPair) {
    const errors: ModelFieldErrors = {};
    const fast = normalizeModelId(body.fastModel);
    const reasoning = normalizeModelId(body.reasoningModel);
    if (!fast) errors.fastModel = "快速模型不能为空";
    if (!reasoning) errors.reasoningModel = "推理模型不能为空";
    if (Object.keys(errors).length) return { kind: "invalid", errors };
    const config = mapFastReasoningToSlots(fast!, reasoning!);
    if (!config) return { kind: "invalid", errors: { fastModel: "模型 ID 非法", reasoningModel: "模型 ID 非法" } };
    return { kind: "ok", config };
  }

  const errors: ModelFieldErrors = {};
  const main = normalizeModelId(body.mainModel);
  const router = normalizeModelId(body.routerModel);
  const sub = normalizeModelId(body.subagentModel);
  if (!main) errors.mainModel = "mainModel 不能为空";
  if (!router) errors.routerModel = "routerModel 不能为空";
  if (!sub) errors.subagentModel = "subagentModel 不能为空";
  if (Object.keys(errors).length) return { kind: "invalid", errors };
  return {
    kind: "ok",
    config: { version: 2, mainModel: main!, routerModel: router!, subagentModel: sub! },
  };
}
