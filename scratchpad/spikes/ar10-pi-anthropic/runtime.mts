import path from "node:path";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { readAgentSettings } from "../../../lib/settings/agent-settings.ts";

export const AR10_PROVIDER_ID = "finwork-anthropic";

export type Ar10Runtime = {
  session: AgentSession;
  events: AgentSessionEvent[];
  sessionRoot: string;
  modelId: string;
  gatewayOrigin: string;
};

const probeTool = defineTool({
  name: "ar10_contract_probe",
  label: "AR10 contract probe",
  description:
    "Call this tool exactly once when asked to verify the AR10 tool contract. It returns the supplied nonce unchanged.",
  parameters: Type.Object({
    nonce: Type.String({ minLength: 1 }),
    nested: Type.Object({
      values: Type.Array(Type.Integer()),
      optionalNote: Type.Optional(Type.String()),
    }),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, nonce: params.nonce }) }],
      details: { received: params },
    };
  },
});

export async function createAr10Runtime(options: {
  sessionRoot: string;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  sessionFile?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  compactionKeepRecentTokens?: number;
}): Promise<Ar10Runtime> {
  const settings = await readAgentSettings();
  if (!settings.apiKey.trim()) {
    throw new Error("AR10 requires the existing Finwork API key in the secure secret store");
  }
  const modelId = settings.mainModel.trim();
  if (!modelId) {
    throw new Error("AR10 requires settings.mainModel");
  }

  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(AR10_PROVIDER_ID, {
    name: "Finwork Anthropic gateway",
    baseUrl: settings.apiUrl,
    apiKey: settings.apiKey,
    api: "anthropic-messages",
    authHeader: false,
    models: [
      {
        id: modelId,
        name: modelId,
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    ],
  });
  const model = modelRuntime.getModel(AR10_PROVIDER_ID, modelId);
  if (!model) {
    throw new Error(`AR10 model registration failed: ${modelId}`);
  }

  const cwd = process.cwd();
  const agentDir = path.join(options.sessionRoot, "agent-config");
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: options.compactionKeepRecentTokens ?? 8_192,
    },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt:
      options.systemPrompt ??
      "You are an AR10 compatibility probe. Follow the user's exact output and tool instructions.",
  });
  await resourceLoader.reload();

  const sessionManager = options.sessionFile
    ? SessionManager.open(options.sessionFile, options.sessionRoot, cwd)
    : SessionManager.create(cwd, options.sessionRoot);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: options.thinkingLevel ?? "off",
    noTools: "builtin",
    customTools: options.tools ?? [probeTool],
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  return {
    session,
    events,
    sessionRoot: options.sessionRoot,
    modelId,
    gatewayOrigin: new URL(settings.apiUrl).origin,
  };
}

export function getProbeTool(): ToolDefinition {
  return probeTool;
}
