"use client";
import { SettingsSection } from "@/app/config/settings-ui";
import { Kbd } from "@/components/ui/kbd";
import { useIsMac } from "@/app/shared/use-is-mac";
import { formatShortcut, SHORTCUTS } from "@/app/shared/shortcuts";

const GROUPS: Array<{ title: string; scopes: Array<"global" | "chat" | "composer" | "config" | "skills"> }> = [
  { title: "对话输入", scopes: ["composer"] },
  { title: "全局与面板", scopes: ["global", "chat", "config", "skills"] },
];

export function ShortcutsSettings() {
  const isMac = useIsMac();
  return (
    <div className="flex flex-col gap-8">
      {GROUPS.map((group) => (
        <SettingsSection key={group.title} title={group.title}>
          <div className="-mx-4 flex flex-col">
            {SHORTCUTS.filter((s) => group.scopes.includes(s.scope)).map((shortcut) => (
              <div key={shortcut.id} className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border last:border-b-0">
                <span className="text-body">{shortcut.description}</span>
                <Kbd>{formatShortcut(shortcut.combo, isMac)}</Kbd>
              </div>
            ))}
          </div>
        </SettingsSection>
      ))}
    </div>
  );
}
