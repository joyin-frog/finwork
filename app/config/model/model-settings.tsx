"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SettingsSection } from "@/app/config/settings-ui";

export function ModelSettings({
  apiUrl, model, apiKey, apiKeyConfigured, apiKeyPreview,
  routerModel, subagentModel, roleMode,
  onApiUrlChange, onModelChange, onApiKeyChange, onApiKeyBlur,
  onRouterModelChange, onSubagentModelChange, onRoleModeChange,
}: {
  apiUrl: string;
  model: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  apiKeyPreview: string;
  routerModel: string;
  subagentModel: string;
  roleMode: "daily" | "tech";
  onApiUrlChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyBlur: () => void;
  onRouterModelChange: (value: string) => void;
  onSubagentModelChange: (value: string) => void;
  onRoleModeChange: (value: "daily" | "tech") => void;
}) {
  return (
    <div className="flex flex-col">
      <SettingsSection title="模型连接" description="配置 LLM 端点和 API 密钥">
        <Badge variant={apiKeyConfigured ? "secondary" : "outline"} className="self-start">
          {apiKeyConfigured ? "已配置" : "未配置"}
        </Badge>

        {/* Connection path visualization */}
        <div className="flex w-fit items-center gap-3 p-3 rounded-lg bg-muted text-meta">
          <div className="flex flex-col items-center gap-0.5 text-center">
            <span className="font-medium">Finance Agent</span>
            <span className="text-muted-foreground">本机桌面应用</span>
          </div>
          <div className="w-12 h-px bg-border" />
          <div className="flex flex-col items-center gap-0.5 text-center">
            <span className="font-medium text-primary">Claude Adapter</span>
            <span className="text-muted-foreground">请求编排与工具调用</span>
          </div>
          <div className="w-12 h-px bg-border" />
          <div className="flex flex-col items-center gap-0.5 text-center">
            <span className="font-medium">LLM Endpoint</span>
            <span className="text-muted-foreground truncate max-w-24">{apiUrl || "等待配置"}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 flex flex-col gap-2">
            <Label htmlFor="api-url">LLM URL</Label>
            <Input id="api-url" value={apiUrl} onChange={(e) => onApiUrlChange(e.target.value)} />
          </div>
          <div className="col-span-2 flex flex-col gap-2">
            <Label htmlFor="api-key">API Key</Label>
            <Input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              onBlur={onApiKeyBlur}
              placeholder={apiKeyConfigured ? `已配置：${apiKeyPreview}` : "sk-ant-..."}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="main-model">主模型</Label>
            <Input id="main-model" value={model} onChange={(e) => onModelChange(e.target.value)} placeholder="claude-opus-4-8" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="router-model">快速模型</Label>
            <Input id="router-model" value={routerModel} onChange={(e) => onRouterModelChange(e.target.value)} placeholder="claude-haiku-4-5-20251001" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="subagent-model">推理模型</Label>
            <Input id="subagent-model" value={subagentModel} onChange={(e) => onSubagentModelChange(e.target.value)} placeholder="claude-sonnet-4-6" />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="角色模式"
        description={roleMode === "tech" ? "详细回复，展示完整工具与思考链" : "简洁回复，隐藏工具与思考过程"}
      >
        <div className="flex gap-2" role="group" aria-label="角色模式">
          {(["tech", "daily"] as const).map((mode) => (
            <Button
              key={mode}
              variant={roleMode === mode ? "default" : "outline"}
              size="sm"
              onClick={() => onRoleModeChange(mode)}
            >
              {mode === "tech" ? "技术模式" : "日常模式"}
            </Button>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
