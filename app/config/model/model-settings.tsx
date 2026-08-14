"use client";

import { Input } from "@/components/ui/input";
import { SettingsSection, SettingsRow } from "@/app/config/settings-ui";
import { UsageSettings } from "@/app/config/usage/usage-settings";

export function ModelSettings({
  apiUrl, apiKey, apiKeyConfigured, apiKeyPreview,
  fastModel, reasoningModel,
  onApiUrlChange, onApiKeyChange, onApiKeyBlur,
  onFastModelChange, onReasoningModelChange,
}: {
  apiUrl: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  apiKeyPreview: string;
  fastModel: string;
  reasoningModel: string;
  onApiUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyBlur: () => void;
  onFastModelChange: (value: string) => void;
  onReasoningModelChange: (value: string) => void;
}) {
  const sameModel =
    fastModel.trim().length > 0 &&
    reasoningModel.trim().length > 0 &&
    fastModel.trim() === reasoningModel.trim();

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection title="模型连接" description="配置 LLM 端点和 API 密钥">
        <SettingsRow label="LLM URL" htmlFor="api-url" wide>
          <Input id="api-url" value={apiUrl} onChange={(e) => onApiUrlChange(e.target.value)} />
        </SettingsRow>
        <SettingsRow label="API Key" htmlFor="api-key" wide>
          <Input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            onBlur={onApiKeyBlur}
            placeholder={apiKeyConfigured ? `已配置：${apiKeyPreview}` : "sk-ant-..."}
          />
        </SettingsRow>
        <SettingsRow label="快速模型" htmlFor="fast-model" wide>
          <Input
            id="fast-model"
            value={fastModel}
            onChange={(e) => onFastModelChange(e.target.value)}
            placeholder="用于路由和默认对话"
          />
        </SettingsRow>
        <SettingsRow label="推理模型" htmlFor="reasoning-model" wide>
          <Input
            id="reasoning-model"
            value={reasoningModel}
            onChange={(e) => onReasoningModelChange(e.target.value)}
            placeholder="用于深度思考与复杂子任务"
          />
        </SettingsRow>
        {sameModel ? (
          <p className="text-meta text-muted-foreground px-1">当前没有实际模型分层</p>
        ) : null}
      </SettingsSection>
      <SettingsSection title="用量" description="查看当前用量保护状态和重置周期。">
        <UsageSettings />
      </SettingsSection>
    </div>
  );
}
