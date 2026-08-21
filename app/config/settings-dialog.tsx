"use client";

import { useRouter } from "next/navigation";
import type { PublicAgentSettings } from "@/lib/settings/agent-settings";
import SkillCenter from "@/app/config/skill-center";

export function SettingsDialog({
  initialAgentSettings,
  initialTab,
}: {
  initialAgentSettings: PublicAgentSettings;
  initialTab?: string;
}) {
  const router = useRouter();
  return (
    <SkillCenter
      initialAgentSettings={initialAgentSettings}
      initialTab={initialTab}
      presentation="modal"
      onClose={() => router.back()}
    />
  );
}
