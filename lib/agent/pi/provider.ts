import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "@/lib/settings/agent-settings";

export const FINWORK_ANTHROPIC_PROVIDER_ID = "finwork-anthropic";

export async function createFinworkModelRuntime(
  settings: AgentSettings,
  modelId: string,
): Promise<{ modelRuntime: ModelRuntime; model: Model<Api> }> {
  if (!settings.apiKey.trim()) throw new Error("API Key 未配置");
  if (!modelId.trim()) throw new Error("模型未配置");

  const [{ InMemoryCredentialStore }, { ModelRuntime }] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-coding-agent"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    }],
  });
  const model = modelRuntime.getModel(FINWORK_ANTHROPIC_PROVIDER_ID, modelId);
  if (!model) throw new Error(`模型注册失败：${modelId}`);
  return { modelRuntime, model };
}
