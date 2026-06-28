"use client";

import { Input } from "@/components/ui/input";
import { SettingsSection, SettingsRow } from "@/app/config/settings-ui";

export function GeneralSettings({
  agentName,
  companyName,
  onAgentNameChange,
  onCompanyNameChange,
}: {
  agentName: string;
  companyName: string;
  onAgentNameChange: (value: string) => void;
  onCompanyNameChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col">
      <SettingsSection title="助手身份" description="设置助手的名称和所属公司，用于对外展示和系统提示词。">
        <SettingsRow label="助手名称" htmlFor="agent-name">
          <Input
            id="agent-name"
            value={agentName}
            onChange={(e) => onAgentNameChange(e.target.value)}
            placeholder="小财"
          />
        </SettingsRow>
        <SettingsRow label="公司名称" htmlFor="company-name">
          <Input
            id="company-name"
            value={companyName}
            onChange={(e) => onCompanyNameChange(e.target.value)}
            placeholder="例如：XX 科技"
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
