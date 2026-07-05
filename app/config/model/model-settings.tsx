"use client";

import { Input } from "@/components/ui/input";
import { SettingsSection, SettingsRow } from "@/app/config/settings-ui";
import { UsageSettings } from "@/app/config/usage/usage-settings";

export function ModelSettings({
  apiUrl, model, apiKey, apiKeyConfigured, apiKeyPreview,
  routerModel, subagentModel,
  onApiUrlChange, onModelChange, onApiKeyChange, onApiKeyBlur,
  onRouterModelChange, onSubagentModelChange,
}: {
  apiUrl: string;
  model: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  apiKeyPreview: string;
  routerModel: string;
  subagentModel: string;
  onApiUrlChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyBlur: () => void;
  onRouterModelChange: (value: string) => void;
  onSubagentModelChange: (value: string) => void;
}) {
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
        <SettingsRow label="快速模型" htmlFor="router-model" wide>
          <Input id="router-model" value={routerModel} onChange={(e) => onRouterModelChange(e.target.value)} placeholder="claude-haiku-4-5-20251001" />
        </SettingsRow>
        <SettingsRow label="推理模型" htmlFor="subagent-model" wide>
          <Input id="subagent-model" value={subagentModel} onChange={(e) => onSubagentModelChange(e.target.value)} placeholder="claude-sonnet-4-6" />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="用量" description="查看当前用量保护状态和重置周期。">
        <UsageSettings />
      </SettingsSection>
    </div>
  );
}
