"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import type { PublicClaudeSettings } from "@/lib/settings/claude-settings";
import { CONFIG_TABS, type ConfigTabKey } from "@/app/config/tabs";
import { AppearanceSettings } from "./appearance/appearance-settings";
import { MemorySettings } from "./memory/memory-settings";
import { GeneralSettings } from "./general/general-settings";
import { ModelSettings } from "./model/model-settings";
import { AboutSettings } from "./about/about-settings";
import { ProfileSettings } from "./profile/profile-settings";
import { UsageSettings } from "./usage/usage-settings";
import { SkillsManager } from "@/app/skills/skills-manager";
import { Input } from "@/components/ui/input";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
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
  const [menuQuery, setMenuQuery] = useState("");
  const identity = useUserIdentity();
  const router = useRouter();

  const saveClaudeRef = useRef(saveClaudeSettings);
  saveClaudeRef.current = saveClaudeSettings;
  const claudeSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleClaudeSave() {
    if (claudeSaveTimerRef.current) clearTimeout(claudeSaveTimerRef.current);
    claudeSaveTimerRef.current = setTimeout(() => void saveClaudeRef.current(false), 800);
  }

  const filteredTabs = CONFIG_TABS.filter((tab) =>
    `${tab.label} ${tab.key}`.toLowerCase().includes(menuQuery.trim().toLowerCase())
  );

  async function saveClaudeSettings(clearApiKey = false) {
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
  }

  function openTab(tab: SettingsTab) {
    setActiveTab(tab);
    window.history.replaceState(null, "", tab === "general" ? "/config" : `/config?tab=${tab}`);
  }

  const activeTabMeta = CONFIG_TABS.find((t) => t.key === activeTab) ?? CONFIG_TABS[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 supports-backdrop-filter:backdrop-blur-xs"
      onClick={() => router.push("/cockpit")}
    >
      <div
        className="flex flex-col w-full max-w-3xl h-[82vh] max-h-[700px] bg-popover rounded-xl ring-1 ring-foreground/10 shadow-[var(--shadow-lg)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
      <header className="relative flex items-center gap-3 pr-5 h-11 shrink-0">
        <DragHandle />
        <SidebarToggle />
        <h1 className="text-title font-semibold">设置</h1>
        <Link href="/cockpit" className="ml-auto p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors" aria-label="关闭设置">
          <HugeiconsIcon icon={Cancel01Icon} size={16} />
        </Link>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <aside className="w-52 border-r border-border flex flex-col gap-3 p-3 shrink-0">
          <div className="relative">
            <HugeiconsIcon icon={Search01Icon} size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={menuQuery}
              onChange={(e) => setMenuQuery(e.target.value)}
              placeholder="搜索"
              className="pl-8 h-8 text-body"
            />
          </div>
          <nav className="flex flex-col gap-0.5">
            <p className="px-3 py-1 text-meta text-muted-foreground">设置</p>
            {filteredTabs.map((tab) => (
              <a
                key={tab.key}
                href={tab.key === "general" ? "/config" : `/config?tab=${tab.key}`}
                aria-current={activeTab === tab.key ? "page" : undefined}
                onClick={(e) => { e.preventDefault(); openTab(tab.key); }}
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
            ))}
          </nav>
        </aside>

        {/* Right content */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
            <h2 className="text-title font-semibold">{activeTabMeta.label}</h2>
          </div>
          <div className="flex-1 overflow-auto px-6 py-6">
            {activeTab === "appearance" && <AppearanceSettings />}
            {activeTab === "general" && (
              <GeneralSettings
                agentName={agentName}
                companyName={companyName}
                userName={userName}
                userAvatar={userAvatar}
                onAgentNameChange={(v) => { setAgentName(v); scheduleClaudeSave(); }}
                onCompanyNameChange={(v) => { setCompanyName(v); scheduleClaudeSave(); }}
                // 名字/头像改了先乐观同步到侧栏(identity),再防抖落库。
                onUserNameChange={(v) => { setUserName(v); identity.setIdentity({ name: v, avatar: userAvatar }); scheduleClaudeSave(); }}
                onUserAvatarChange={(v) => { setUserAvatar(v); identity.setIdentity({ name: userName, avatar: v }); scheduleClaudeSave(); }}
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
                roleMode={roleMode}
                onApiUrlChange={(v) => { setApiUrl(v); scheduleClaudeSave(); }}
                onModelChange={(v) => { setModel(v); scheduleClaudeSave(); }}
                onApiKeyChange={setApiKey}
                onApiKeyBlur={() => { if (apiKey.trim()) void saveClaudeSettings(false); }}
                onRouterModelChange={(v) => { setRouterModel(v); scheduleClaudeSave(); }}
                onSubagentModelChange={(v) => { setSubagentModel(v); scheduleClaudeSave(); }}
                onRoleModeChange={(v) => { setRoleMode(v); scheduleClaudeSave(); }}
              />
            )}
            {activeTab === "skills" && (
              <div className="flex flex-col gap-2">
                <div className="flex justify-end">
                  <Link href="/skills" className="text-meta text-muted-foreground hover:text-foreground transition-colors">
                    全屏打开 ↗
                  </Link>
                </div>
                <SkillsManager />
              </div>
            )}
            {activeTab === "memory" && <MemorySettings />}
            {activeTab === "profile" && <ProfileSettings />}
            {activeTab === "usage" && <UsageSettings />}
            {activeTab === "about" && <AboutSettings />}
          </div>
        </main>
      </div>
      </div>
    </div>
  );
}

function isSettingsTab(value: string): value is SettingsTab {
  return CONFIG_TABS.some((t) => t.key === value);
}
