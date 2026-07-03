"use client";

import { Input } from "@/components/ui/input";
import { SettingsSection, SettingsRow, SettingsField } from "@/app/config/settings-ui";

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
    <div className="flex flex-col">
      <SettingsSection title="模型连接" description="配置 LLM 端点和 API 密钥">
        <p className="text-meta">
          {apiKeyConfigured ? (
            <span className="text-[color:var(--tone-ok)]">已配置 ✓</span>
          ) : (
            <span className="text-muted-foreground">未配置</span>
          )}
        </p>

        <SettingsField label="LLM URL" htmlFor="api-url">
          <Input id="api-url" value={apiUrl} onChange={(e) => onApiUrlChange(e.target.value)} />
        </SettingsField>
        <SettingsField label="API Key" htmlFor="api-key">
          <Input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            onBlur={onApiKeyBlur}
            placeholder={apiKeyConfigured ? `已配置：${apiKeyPreview}` : "sk-ant-..."}
          />
        </SettingsField>
        <details className="rounded-lg border border-border px-4 py-3">
          <summary className="cursor-pointer text-body font-medium">高级</summary>
          <div className="mt-4 flex flex-col gap-3">
            <SettingsRow label="主模型" htmlFor="main-model" wide>
              <Input id="main-model" value={model} onChange={(e) => onModelChange(e.target.value)} placeholder="claude-opus-4-8" />
            </SettingsRow>
            <SettingsRow label="快速模型" htmlFor="router-model" wide>
              <Input id="router-model" value={routerModel} onChange={(e) => onRouterModelChange(e.target.value)} placeholder="claude-haiku-4-5-20251001" />
            </SettingsRow>
            <SettingsRow label="推理模型" htmlFor="subagent-model" wide>
              <Input id="subagent-model" value={subagentModel} onChange={(e) => onSubagentModelChange(e.target.value)} placeholder="claude-sonnet-4-6" />
            </SettingsRow>
          </div>
        </details>
      </SettingsSection>
    </div>
  );
}
