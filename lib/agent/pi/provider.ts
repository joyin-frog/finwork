import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "@/lib/settings/agent-settings";
import { resolveModelMetadata } from "@/lib/agent/pi/model-catalog";

export const FINWORK_ANTHROPIC_PROVIDER_ID = "finwork-anthropic";

export async function createFinworkModelRuntime(
  settings: AgentSettings,
  modelId: string,
): Promise<{ modelRuntime: ModelRuntime; model: Model<Api>; pricingKnown: boolean }> {
  if (!settings.apiKey.trim()) throw new Error("API Key 未配置");
  if (!modelId.trim()) throw new Error("模型未配置");

  // L6b：按装配指纹缓存。此前每条消息都要重建 ModelRuntime 并重注册 provider。
  // 指纹含 apiKey——密钥换了必须换 runtime，否则会拿旧凭证继续发请求。
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([settings.apiUrl, settings.apiKey, modelId, settings.modelPricing ?? null]))
    .digest("hex");
  const cached = getRuntimeCache().get(fingerprint);
  if (cached) return cached;

  const [{ InMemoryCredentialStore }, { ModelRuntime }] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-coding-agent"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  // 费率与上下文上限来自用户声明；未声明时 cost 全 0 且 pricingKnown=false，
  // 由上层把 totalCostUsd 报成 null（未知），而不是 0（免费）。
  const metadata = resolveModelMetadata(modelId, settings.modelPricing);
  modelRuntime.registerProvider(FINWORK_ANTHROPIC_PROVIDER_ID, {
    name: "Finwork Anthropic gateway",
    baseUrl: settings.apiUrl,
    apiKey: settings.apiKey,
    api: "anthropic-messages",
    authHeader: false,
    models: [{
      id: modelId,
      name: modelId,
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image"],
      cost: metadata.cost,
      contextWindow: metadata.limits.contextWindow,
      maxTokens: metadata.limits.maxTokens,
    }],
  });
  const model = modelRuntime.getModel(FINWORK_ANTHROPIC_PROVIDER_ID, modelId);
  if (!model) throw new Error(`模型注册失败：${modelId}`);
  const result = { modelRuntime, model, pricingKnown: metadata.pricingKnown };
  getRuntimeCache().set(fingerprint, result);
  return result;
}

type CachedRuntime = { modelRuntime: ModelRuntime; model: Model<Api>; pricingKnown: boolean };

const RUNTIME_CACHE_SYMBOL = Symbol.for("finwork.pi.modelRuntimeCache");

/**
 * 挂 globalThis 与 `pending-questions.ts` 同构（Next dev 会有多份模块实例）。
 * 仅支持单进程部署。
 */
function getRuntimeCache(): Map<string, CachedRuntime> {
  const root = globalThis as typeof globalThis & { [RUNTIME_CACHE_SYMBOL]?: Map<string, CachedRuntime> };
  root[RUNTIME_CACHE_SYMBOL] ??= new Map();
  return root[RUNTIME_CACHE_SYMBOL];
}

/** 仅供测试。 */
export function _resetModelRuntimeCacheForTest(): void {
  getRuntimeCache().clear();
}
