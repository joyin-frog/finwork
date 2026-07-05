"use client";
import { Switch } from "@/components/ui/switch";
import { SettingsSection, SettingsRow } from "@/app/config/settings-ui";
import { ProfileSettings } from "@/app/config/profile/profile-settings";
import { MemorySettings } from "@/app/config/memory/memory-settings";

export function PersonalizationSettings({
  roleMode,
  onRoleModeChange,
}: {
  roleMode: "daily" | "tech";
  onRoleModeChange: (value: "daily" | "tech") => void;
}) {
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection title="回复风格">
        <SettingsRow label="技术细节" hint="用于展示对话输出过程细节">
          <Switch
            checked={roleMode === "tech"}
            onCheckedChange={(v) => onRoleModeChange(v ? "tech" : "daily")}
          />
        </SettingsRow>
      </SettingsSection>
      <ProfileSettings />
      <MemorySettings />
    </div>
  );
}
