"use client";

import { useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { PageSearchBar } from "@/app/shared/page-search-dialog";
import { ShortcutHint } from "@/app/shared/shortcut-hint";
import type { PublicClaudeSettings } from "@/lib/settings/claude-settings";
import { CONFIG_TABS, type ConfigTabKey } from "@/app/config/tabs";
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
  const [searchOpen, setSearchOpen] = useState(false);
  const identity = useUserIdentity();
  useShortcutEvent("search-settings", () => setSearchOpen(true));

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
    <div className="flex flex-col h-full overflow-hidden">
      {/* 页头:复用全站 header 模式(h-11 + app-page-header 统一底线),含拖拽区与侧栏收起按钮 */}
      <header className="app-page-header relative flex items-center gap-3 pr-5 h-11 shrink-0">
        <DragHandle />
        <SidebarToggle />
        <h1 className="text-title font-semibold">设置</h1>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ShortcutHint label="搜索" combo="mod+f">
            <button
              type="button"
              // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
              className={cn("inline-grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", query && "bg-accent text-foreground")}
              onClick={() => setSearchOpen(true)}
              aria-label="搜索设置"
            >
              <HugeiconsIcon icon={Search01Icon} size={16} />
            </button>
          </ShortcutHint>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar: shares the outer box with content, just a vertical divider — no gap, no separate corners */}
        <aside className="w-52 shrink-0 flex flex-col border-r border-border overflow-hidden">
          <PageSearchBar
            open={searchOpen}
            onOpenChange={(open) => { setSearchOpen(open); if (!open) setQuery(""); }}
            value={query}
            onValueChange={setQuery}
            placeholder="搜索设置"
            label="设置"
          />
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

        {/* Right content */}
        <div className="relative flex-1 flex flex-col overflow-hidden">
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
      </div>
    </div>
  );
}

function isSettingsTab(value: string): value is SettingsTab {
  return CONFIG_TABS.some((t) => t.key === value);
}
