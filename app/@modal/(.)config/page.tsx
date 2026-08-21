import { redirect } from "next/navigation";
import { readPublicAgentSettings } from "@/lib/settings/agent-settings";
import { CONFIG_TAB_KEYS, LEGACY_CONFIG_TAB_REDIRECTS } from "@/app/config/tabs";
import { SettingsDialog } from "@/app/config/settings-dialog";

export const dynamic = "force-dynamic";

const validTabs = new Set<string>(CONFIG_TAB_KEYS);

export default async function ConfigModal({
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
  return <SettingsDialog initialAgentSettings={agentSettings} initialTab={initialTab} />;
}
