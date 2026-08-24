"use client";

import { useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { PageSearchBar } from "@/app/shared/page-search-dialog";
import type { PublicAgentSettings } from "@/lib/settings/agent-settings";
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
import { useUserIdentity } from "@/app/shared/user-identity";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";

type SettingsTab = ConfigTabKey;

export default function SkillCenter({
  initialAgentSettings,
  initialTab = "general",
  presentation = "page",
  onClose,
}: {
  initialAgentSettings: PublicAgentSettings;
  initialTab?: SettingsTab | string;
  presentation?: "page" | "modal";
  onClose?: () => void;
}) {
  const [agentSettings, setAgentSettings] = useState(initialAgentSettings);
  const [apiUrl, setApiUrl] = useState(initialAgentSettings.apiUrl);
  const [apiKey, setApiKey] = useState("");
  const [fastModel, setFastModel] = useState(initialAgentSettings.fastModel);
  const [reasoningModel, setReasoningModel] = useState(initialAgentSettings.reasoningModel);
  const [companyName, setCompanyName] = useState(initialAgentSettings.companyName);
  const [agentName, setAgentName] = useState(initialAgentSettings.agentName);
  const [userName, setUserName] = useState(initialAgentSettings.userName);
  const [userAvatar, setUserAvatar] = useState(initialAgentSettings.userAvatar);
  const [roleMode, setRoleMode] = useState(initialAgentSettings.roleMode);
  const [activeTab, setActiveTab] = useState<SettingsTab>(isSettingsTab(initialTab) ? initialTab : "general");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [query, setQuery] = useState("");
  const identity = useUserIdentity();

  const saveAgentRef = useRef(saveAgentSettings);
  saveAgentRef.current = saveAgentSettings;
  const agentSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleAgentSave() {
    if (agentSaveTimerRef.current) clearTimeout(agentSaveTimerRef.current);
    agentSaveTimerRef.current = setTimeout(() => void saveAgentRef.current(false), 800);
  }

  async function saveAgentSettings(clearApiKey = false) {
    setSaveStatus("saving");
    try {
      const fast = fastModel.trim();
      const reasoning = reasoningModel.trim();
      // 双空 = 尚未配置模型 → omit，不挡其他设置落盘；单填或不完整 → 交给 API 400。
      const modelFields = !fast && !reasoning ? {} : { fastModel, reasoningModel };
      const res = await fetch("/api/settings/agent", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiUrl,
          apiKey: apiKey.trim() || undefined,
          clearApiKey,
          ...modelFields,
          companyName,
          agentName,
          userName,
          userAvatar,
          roleMode,
        }),
      });
      if (!res.ok) {
        setSaveStatus("error");
        return;
      }
      const payload = (await res.json()) as { ok?: boolean; data: PublicAgentSettings };
      if (!payload.data) {
        setSaveStatus("error");
        return;
      }
      setAgentSettings(payload.data);
      setApiUrl(payload.data.apiUrl);
      setFastModel(payload.data.fastModel);
      setReasoningModel(payload.data.reasoningModel);
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

  const settingsBody = (
    <div className="flex h-full flex-col overflow-hidden">
      {presentation === "page" ? (
        /* 页头:复用全站 header 模式(h-11 + app-page-header 统一底线),含拖拽区与侧栏收起按钮 */
        <header className="app-page-header relative flex items-center gap-3 pr-5 shrink-0">
          <DragHandle />
          <SidebarToggle />
          <h1 className="text-title font-semibold">设置</h1>
        </header>
      ) : (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <DialogPrimitive.Title className="flex-1 font-heading text-title">设置</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon" aria-label="关闭设置">
              <HugeiconsIcon icon={Cancel01Icon} size={18} />
            </Button>
          </DialogPrimitive.Close>
        </header>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left sidebar: shares the outer box with content, just a vertical divider — no gap, no separate corners */}
        <aside className="w-52 shrink-0 flex flex-col border-r border-border overflow-hidden">
          <PageSearchBar
            open
            onOpenChange={() => setQuery("")}
            value={query}
            onValueChange={setQuery}
            placeholder="搜索设置"
            label="设置"
            className="px-2"
            alwaysVisible
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
                    "flex min-h-[30px] items-center gap-2 px-3 py-1 rounded-md text-body transition-colors",
                    activeTab === tab.key
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  )}
                >
                  <HugeiconsIcon icon={tab.icon} size={14} />
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
                onAgentNameChange={(v) => { setAgentName(v); scheduleAgentSave(); }}
                onCompanyNameChange={(v) => { setCompanyName(v); scheduleAgentSave(); }}
                onUserNameChange={(v) => { setUserName(v); identity.setIdentity({ name: v, avatar: userAvatar }); scheduleAgentSave(); }}
                onUserAvatarChange={(v) => { setUserAvatar(v); identity.setIdentity({ name: userName, avatar: v }); scheduleAgentSave(); }}
              />
            )}
            {activeTab === "appearance" && <AppearanceSettings />}
            {activeTab === "personalization" && (
              <PersonalizationSettings
                roleMode={roleMode}
                onRoleModeChange={(v) => { setRoleMode(v); scheduleAgentSave(); }}
              />
            )}
            {activeTab === "model" && (
              <ModelSettings
                apiUrl={apiUrl}
                apiKey={apiKey}
                apiKeyConfigured={agentSettings.apiKeyConfigured}
                apiKeyPreview={agentSettings.apiKeyPreview}
                fastModel={fastModel}
                reasoningModel={reasoningModel}
                onApiUrlChange={(v) => { setApiUrl(v); scheduleAgentSave(); }}
                onApiKeyChange={setApiKey}
                onApiKeyBlur={() => { if (apiKey.trim()) void saveAgentSettings(false); }}
                onFastModelChange={(v) => { setFastModel(v); scheduleAgentSave(); }}
                onReasoningModelChange={(v) => { setReasoningModel(v); scheduleAgentSave(); }}
              />
            )}
            {activeTab === "shortcuts" && <ShortcutsSettings />}
            {activeTab === "about" && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );

  if (presentation === "page") return settingsBody;

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim-modal data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          aria-label="设置"
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex h-[min(720px,calc(100vh-3rem))] w-[min(920px,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden text-popover-foreground outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            surfaceVariants({ level: "overlay", edge: "hairline", shape: "overlay" }),
          )}
        >
          {settingsBody}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function isSettingsTab(value: string): value is SettingsTab {
  return CONFIG_TABS.some((t) => t.key === value);
}
