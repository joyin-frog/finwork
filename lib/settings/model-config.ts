/**
 * Two-model configuration and the single execution-model resolver.
 *
 * Model tier answers "how strong/expensive"; execution role answers "who is
 * calling". They deliberately remain separate so router/agent/subagent never
 * look like three user-configurable models.
 */

export type ExecutionRole = "router" | "agent" | "subagent";
export type ExecutionTier = "fast" | "reasoning";

export type ModelConfigV3 = {
  version: 3;
  fastModel: string;
  reasoningModel: string;
};

export type ModelConfigState = ModelConfigV3 | null;

export type ResolvedModel = {
  modelId: string;
  executionRole: ExecutionRole;
  executionTier: ExecutionTier;
  fallbackReason?: "router_timeout" | "router_invalid" | "router_disabled";
};

export type ModelFields = {
  fastModel?: string;
  reasoningModel?: string;
};

export type ResolvePurpose = "router" | "title" | "task" | "subagent" | "summary";

export type ResolveExecutionModelInput = {
  config: ModelConfigV3;
  purpose: ResolvePurpose;
  /** Main and nested Agent calls default to fast unless the caller explicitly selects reasoning. */
  tier?: ExecutionTier;
  fallbackReason?: "router_timeout" | "router_invalid" | "router_disabled";
};

export const MODEL_CONFIG_INCOMPLETE = "MODEL_CONFIG_INCOMPLETE";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function normalizeModelId(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.length > 200 || CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

export function validateModelConfig(
  input: ModelConfigV3 | null | (Partial<ModelConfigV3> & { version?: number }) | undefined,
): ModelConfigState {
  if (input == null) return null;
  const fastModel = normalizeModelId(input.fastModel);
  const reasoningModel = normalizeModelId(input.reasoningModel);
  if (!fastModel || !reasoningModel) return null;
  return { version: 3, fastModel, reasoningModel };
}

export function getModelConfigReadiness(settings: ModelFields | null | undefined): {
  modelConfigReady: boolean;
  missingModelTiers: ExecutionTier[];
} {
  const config = modelConfigFromSettings(settings);
  if (config) return { modelConfigReady: true, missingModelTiers: [] };

  const s = settings ?? {};
  const fast = normalizeModelId(s.fastModel);
  const reasoning = normalizeModelId(s.reasoningModel);
  const missingModelTiers: ExecutionTier[] = [];
  if (!fast) missingModelTiers.push("fast");
  if (!reasoning) missingModelTiers.push("reasoning");
  return { modelConfigReady: false, missingModelTiers };
}

export function resolveExecutionModel(input: ResolveExecutionModelInput): ResolvedModel {
  const tier = input.tier === "reasoning" ? "reasoning" : "fast";
  const modelId = tier === "reasoning" ? input.config.reasoningModel : input.config.fastModel;
  const executionRole: ExecutionRole = input.purpose === "router" || input.purpose === "title"
    ? "router"
    : input.purpose === "subagent"
      ? "subagent"
      : "agent";
  return {
    modelId,
    executionRole,
    executionTier: tier,
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
  };
}

export function modelConfigFromSettings(settings: ModelFields | null | undefined): ModelConfigState {
  return validateModelConfig({
    version: 3,
    fastModel: settings?.fastModel,
    reasoningModel: settings?.reasoningModel,
  });
}

export function parseModelFieldsFromBody(body: ModelFields):
  | { kind: "omit" }
  | { kind: "ok"; config: ModelConfigV3 }
  | { kind: "invalid"; errors: { fastModel?: string; reasoningModel?: string } } {
  const touching = body.fastModel !== undefined || body.reasoningModel !== undefined;
  if (!touching) return { kind: "omit" };
  const config = validateModelConfig({
    version: 3,
    fastModel: body.fastModel,
    reasoningModel: body.reasoningModel,
  });
  if (config) return { kind: "ok", config };

  const errors: { fastModel?: string; reasoningModel?: string } = {};
  if (!normalizeModelId(body.fastModel)) errors.fastModel = "快速模型不能为空";
  if (!normalizeModelId(body.reasoningModel)) errors.reasoningModel = "推理模型不能为空";
  return { kind: "invalid", errors };
}
