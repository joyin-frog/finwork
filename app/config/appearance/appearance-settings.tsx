"use client";

import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/app/config/settings-ui";

const THEMES = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "亮色" },
  { value: "dark", label: "暗色" },
] as const;

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex flex-col">
      <SettingsSection title="主题" description="选择界面显示模式，跟随系统会自动匹配操作系统的明暗偏好。">
        <div className="flex gap-2">
          {THEMES.map((t) => (
            <Button
              key={t.value}
              variant={theme === t.value ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme(t.value)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
