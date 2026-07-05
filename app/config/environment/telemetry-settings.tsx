"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "@/app/config/settings-ui";
import type { PublicClaudeSettings } from "@/lib/settings/claude-settings";

async function saveSettings(patch: Partial<PublicClaudeSettings>): Promise<void> {
  await fetch("/api/settings/claude", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/** 「使用数据上报」区块正文:仅保留开关。标题/说明由外层 SettingsSection 提供。 */
export function TelemetryBody() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/settings/claude");
      const body = (await res.json()) as { data: PublicClaudeSettings };
      setEnabled(body.data.telemetryEnabled ?? false);
    })();
  }, []);

  // 开关直接保存(§17.2:无阻塞确认弹框,已改为首启告知)
  async function handleToggle(next: boolean) {
    setEnabled(next);
    await saveSettings({ telemetryEnabled: next });
  }

  return (
    <SettingsRow label="启用上报" htmlFor="telemetry-enabled">
      <Switch
        id="telemetry-enabled"
        checked={enabled}
        onCheckedChange={(v) => void handleToggle(v)}
      />
    </SettingsRow>
  );
}
