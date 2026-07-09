"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SettingsSection } from "@/app/config/settings-ui";

const THEMES = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "亮色" },
  { value: "dark", label: "暗色" },
] as const;

// 技术值 default/linear 不变；label 改为"经典"/"现代"，现代在前
const STYLES = [
  { value: "linear", label: "现代" },
  { value: "default", label: "经典" },
] as const;

type StyleValue = (typeof STYLES)[number]["value"];

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  // 初值 "linear"：SSR 默认现代，避免首帧"经典"选中再跳
  const [style, setStyle] = useState<StyleValue>("linear");

  useEffect(() => {
    // 挂载后读取当前值（避免 SSR 阶段访问 document）
    const current = document.documentElement.dataset.style;
    setStyle(current === "default" ? "default" : "linear");
  }, []);

  function handleStyleChange(v: StyleValue) {
    setStyle(v);
    if (v === "default") {
      // 用户明确选择经典：写入 localStorage，no-flash 脚本下次读取
      localStorage.setItem("app-style", "default");
    } else {
      // 用户选择现代：清除标记，回归 SSR 默认(linear)
      localStorage.removeItem("app-style");
    }
    document.documentElement.dataset.style = v;
  }

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection title="主题" description="选择界面显示模式，跟随系统会自动匹配操作系统的明暗偏好。">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          size="sm"
          value={theme ?? "system"}
          onValueChange={(v) => { if (!v) return; setTheme(v); }}
        >
          {THEMES.map((t) => (
            <ToggleGroupItem key={t.value} value={t.value}>
              {t.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingsSection>
      <SettingsSection title="界面风格" description="切换整体外观风格，与明暗模式相互独立，可自由组合。">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          size="sm"
          value={style}
          onValueChange={(v) => { if (!v) return; handleStyleChange(v as StyleValue); }}
        >
          {STYLES.map((s) => (
            <ToggleGroupItem key={s.value} value={s.value}>
              {s.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingsSection>
    </div>
  );
}
