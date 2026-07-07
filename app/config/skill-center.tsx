"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import type { PublicClaudeSettings } from "@/lib/settings/claude-settings";
import { CONFIG_TABS, type ConfigTabKey } from "@/app/config/tabs";
import { Surface } from "@/components/ui/surface";
import { GeneralSettings } from "./general/general-settings";
import { AppearanceSettings } from "./appearance/appearance-settings";
import { PersonalizationSettings } from "./personalization/personalization-settings";
import { ModelSettings } from "./model/model-settings";
import { ShortcutsSettings } from "./shortcuts/shortcuts-settings";
import { AboutSettings } from "./about/about-settings";
import { SaveStatusText, type SaveStatus } from "@/app/config/settings-ui";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { useShortcutEvent } from "@/app/shared/global-shortcuts";
import { useUserIdentity } from "@/app/shared/user-identity";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

type SettingsTab = ConfigTabKey;

export default function SkillCenter({
  initialClaudeSettings,
  initialTab = "general",
}: {
  initialClaudeSettings: PublicClaudeSettings;
  initialTab?: SettingsTab | string;
}) {
  const [claudeSettings, setClaudeSettings] = useState(initialClaudeSettings);
  const [apiUrl, setApiUrl] = useState(initialClaudeSettings.apiUrl);
  const [model, setModel] = useState(initialClaudeSettings.model);
  const [apiKey, setApiKey] = useState("");
  const [routerModel, setRouterModel] = useState(initialClaudeSettings.routerModel);
  const [subagentModel, setSubagentModel] = useState(initialClaudeSettings.subagentModel);
  const [companyName, setCompanyName] = useState(initialClaudeSettings.companyName);
  const [agentName, setAgentName] = useState(initialClaudeSettings.agentName);
  const [userName, setUserName] = useState(initialClaudeSettings.userName);
  const [userAvatar, setUserAvatar] = useState(initialClaudeSettings.userAvatar);
  const [roleMode, setRoleMode] = useState(initialClaudeSettings.roleMode);
  const [activeTab, setActiveTab] = useState<SettingsTab>(isSettingsTab(initialTab) ? initialTab : "general");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [query, setQuery] = useState("");
  const identity = useUserIdentity();
  const router = useRouter();
  const searchInputRef = useRef<HTMLInputElement>(null);
  useShortcutEvent("search-settings", () => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  });

  const saveClaudeRef = useRef(saveClaudeSettings);
  saveClaudeRef.current = saveClaudeSettings;
  const claudeSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleClaudeSave() {
    if (claudeSaveTimerRef.current) clearTimeout(claudeSaveTimerRef.current);
    claudeSaveTimerRef.current = setTimeout(() => void saveClaudeRef.current(false), 800);
  }

  async function saveClaudeSettings(clearApiKey = false) {
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/settings/claude", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiUrl, model, apiKey: apiKey.trim() || undefined, clearApiKey, routerModel, subagentModel, companyName, agentName, userName, userAvatar, roleMode }),
      });
      const payload = (await res.json()) as { data: PublicClaudeSettings };
      setClaudeSettings(payload.data);
      setApiUrl(payload.data.apiUrl);
      setModel(payload.data.model);
      setRouterModel(payload.data.routerModel);
      setSubagentModel(payload.data.subagentModel);
      setCompanyName(payload.data.companyName);
      setAgentName(payload.data.agentName);
      setUserName(payload.data.userName);
      setUserAvatar(payload.data.userAvatar);
      setRoleMode(payload.data.roleMode);
      setApiKey("");
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  function openTab(tab: SettingsTab) {
    setActiveTab(tab);
    window.history.replaceState(null, "", tab === "general" ? "/config" : `/config?tab=${tab}`);
  }

  const activeTabMeta = CONFIG_TABS.find((t) => t.key === activeTab) ?? CONFIG_TABS[0];
  const filteredTabs = CONFIG_TABS.filter((t) => t.label.includes(query.trim()));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-modal p-4"
      onClick={() => router.push("/cockpit")}
    >
      <Surface
        level="overlay"
        edge="none"
        shape="panel"
        className="relative flex w-full max-w-3xl h-[82vh] max-h-[700px] ring-1 ring-foreground/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left sidebar: shares the outer box with content, just a vertical divider — no gap, no separate corners */}
        <aside className="w-52 shrink-0 flex flex-col border-r border-border overflow-hidden">
          {/* Search box — left-flush with the tab list's own left padding below; drag/toggle sit after it so they don't push the search icon/text off-center */}
          <div className="flex items-center gap-1 px-3 pt-3 pb-2 border-b border-border">
            <DragHandle />
            <div className="relative flex-1">
              <HugeiconsIcon
                icon={Search01Icon}
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索设置..."
                // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                className="w-full h-8 pl-7 pr-3 text-body rounded-md placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
            <SidebarToggle />
          </div>
          {/* Tab list */}
          <nav className="flex flex-col gap-0.5 px-2 py-2 flex-1 overflow-y-auto">
            {filteredTabs.length === 0 ? (
              <p className="px-3 py-2 text-meta text-muted-foreground">未找到匹配项</p>
            ) : (
              filteredTabs.map((tab) => (
                <a
                  key={tab.key}
                  href={tab.key === "general" ? "/config" : `/config?tab=${tab.key}`}
                  aria-current={activeTab === tab.key ? "page" : undefined}
                  onClick={(e) => { e.preventDefault(); openTab(tab.key); }}
                  // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-md text-body transition-colors",
                    activeTab === tab.key
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <HugeiconsIcon icon={tab.icon} size={15} />
                  <span>{tab.label}</span>
                </a>
              ))
            )}
          </nav>
        </aside>

        {/* Right content: the close button only occupies this panel's space, not the sidebar's */}
        <div className="relative flex-1 flex flex-col overflow-hidden">
          <Link
            href="/cockpit"
            // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
            className="absolute right-3 top-3 z-10 p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
            aria-label="关闭设置"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} />
          </Link>
          <div className="flex items-center justify-between px-6 pt-5 pb-4 shrink-0">
            <h2 className="text-title font-semibold">{activeTabMeta.label}</h2>
            <SaveStatusText status={saveStatus} />
          </div>
          <div className="flex-1 overflow-auto px-6 pb-6">
            {activeTab === "general" && (
              <GeneralSettings
                agentName={agentName}
                companyName={companyName}
                userName={userName}
                userAvatar={userAvatar}
                onAgentNameChange={(v) => { setAgentName(v); scheduleClaudeSave(); }}
                onCompanyNameChange={(v) => { setCompanyName(v); scheduleClaudeSave(); }}
                onUserNameChange={(v) => { setUserName(v); identity.setIdentity({ name: v, avatar: userAvatar }); scheduleClaudeSave(); }}
                onUserAvatarChange={(v) => { setUserAvatar(v); identity.setIdentity({ name: userName, avatar: v }); scheduleClaudeSave(); }}
              />
            )}
            {activeTab === "appearance" && <AppearanceSettings />}
            {activeTab === "personalization" && (
              <PersonalizationSettings
                roleMode={roleMode}
                onRoleModeChange={(v) => { setRoleMode(v); scheduleClaudeSave(); }}
              />
            )}
            {activeTab === "model" && (
              <ModelSettings
                apiUrl={apiUrl}
                model={model}
                apiKey={apiKey}
                apiKeyConfigured={claudeSettings.apiKeyConfigured}
                apiKeyPreview={claudeSettings.apiKeyPreview}
                routerModel={routerModel}
                subagentModel={subagentModel}
                onApiUrlChange={(v) => { setApiUrl(v); scheduleClaudeSave(); }}
                onModelChange={(v) => { setModel(v); scheduleClaudeSave(); }}
                onApiKeyChange={setApiKey}
                onApiKeyBlur={() => { if (apiKey.trim()) void saveClaudeSettings(false); }}
                onRouterModelChange={(v) => { setRouterModel(v); scheduleClaudeSave(); }}
                onSubagentModelChange={(v) => { setSubagentModel(v); scheduleClaudeSave(); }}
              />
            )}
            {activeTab === "shortcuts" && <ShortcutsSettings />}
            {activeTab === "about" && <AboutSettings />}
          </div>
        </div>
      </Surface>
    </div>
  );
}

function isSettingsTab(value: string): value is SettingsTab {
  return CONFIG_TABS.some((t) => t.key === value);
}
