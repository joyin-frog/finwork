import SkillCenter from "@/app/config/skill-center";
import { readPublicClaudeSettings } from "@/lib/settings/claude-settings";
import { CONFIG_TAB_KEYS } from "@/app/config/tabs";

export const dynamic = "force-dynamic";

const validTabs = new Set<string>(CONFIG_TAB_KEYS);

export default async function ConfigPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const initialTab = params?.tab && validTabs.has(params.tab) ? params.tab : "general";
  const claudeSettings = await readPublicClaudeSettings();
  return (
    <SkillCenter
      initialClaudeSettings={claudeSettings}
      initialTab={initialTab}
    />
  );
}
