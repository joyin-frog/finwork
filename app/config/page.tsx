import SkillCenter from "@/app/config/skill-center";
import { readPublicAgentSettings } from "@/lib/settings/agent-settings";
import { redirect } from "next/navigation";
import { CONFIG_TAB_KEYS, LEGACY_CONFIG_TAB_REDIRECTS } from "@/app/config/tabs";

export const dynamic = "force-dynamic";

const validTabs = new Set<string>(CONFIG_TAB_KEYS);

export default async function ConfigPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  if (params?.tab === "skills") redirect("/skills");
  const legacyTarget = params?.tab && params.tab in LEGACY_CONFIG_TAB_REDIRECTS
    ? LEGACY_CONFIG_TAB_REDIRECTS[params.tab as keyof typeof LEGACY_CONFIG_TAB_REDIRECTS]
    : null;
  if (legacyTarget) redirect(`/config?tab=${legacyTarget}`);
  const initialTab = params?.tab && validTabs.has(params.tab) ? params.tab : "general";
  const agentSettings = await readPublicAgentSettings();
  return (
    <SkillCenter
      initialAgentSettings={agentSettings}
      initialTab={initialTab}
    />
  );
}
