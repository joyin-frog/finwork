"use client";

import { useRef } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Input } from "@/components/ui/input";
import { SettingsSection, SettingsRow } from "@/app/config/settings-ui";
import { UserAvatar } from "@/app/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { useTheme } from "next-themes";

const THEMES = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "亮色" },
  { value: "dark", label: "暗色" },
] as const;

/** 选中的图片压到 ~96px 方形 data URL(JPEG),避免把大图塞进 settings.json。 */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 不可用");
  // cover 裁剪:短边铺满、居中,不拉伸变形。
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function GeneralSettings({
  agentName,
  companyName,
  userName,
  userAvatar,
  onAgentNameChange,
  onCompanyNameChange,
  onUserNameChange,
  onUserAvatarChange,
  roleMode,
  onRoleModeChange,
}: {
  agentName: string;
  companyName: string;
  userName: string;
  userAvatar: string;
  onAgentNameChange: (value: string) => void;
  onCompanyNameChange: (value: string) => void;
  onUserNameChange: (value: string) => void;
  onUserAvatarChange: (value: string) => void;
  roleMode: "daily" | "tech";
  onRoleModeChange: (value: "daily" | "tech") => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { theme, setTheme } = useTheme();

  async function onPickAvatar(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片文件");
      return;
    }
    try {
      onUserAvatarChange(await fileToAvatarDataUrl(file));
    } catch {
      toast.error("头像处理失败,请换一张图片");
    }
  }

  return (
    <div className="flex flex-col">
      <SettingsSection title="用户" description="显示在侧栏底部,仅本地保存,用于个性化。">
        <div className="py-0.5">
          {/* 点头像=换头像;右上角 × =移除(仅有头像时出现)。 */}
          <div className="relative w-fit">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="block rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label={userAvatar ? "更换头像" : "上传头像"}
              title={userAvatar ? "更换头像" : "上传头像"}
            >
              <UserAvatar name={userName} avatar={userAvatar} size="lg" />
            </button>
            {userAvatar ? (
              <button
                type="button"
                onClick={() => onUserAvatarChange("")}
                aria-label="移除头像"
                title="移除头像"
                className="absolute -right-1 -top-1 inline-flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background transition-colors hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={10} />
              </button>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPickAvatar(file);
              e.target.value = "";
            }}
          />
        </div>
        <SettingsRow label="用户名" htmlFor="user-name">
          <Input
            id="user-name"
            value={userName}
            onChange={(e) => onUserNameChange(e.target.value)}
            placeholder="你的名字"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="助手身份" description="设置助手的名称和所属公司，用于对外展示和系统提示词。">
        <SettingsRow label="助手名称" htmlFor="agent-name">
          <Input
            id="agent-name"
            value={agentName}
            onChange={(e) => onAgentNameChange(e.target.value)}
            placeholder="小财"
          />
        </SettingsRow>
        <SettingsRow label="公司名称" htmlFor="company-name">
          <Input
            id="company-name"
            value={companyName}
            onChange={(e) => onCompanyNameChange(e.target.value)}
            placeholder="例如：XX 科技"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="主题" description="选择界面显示模式，跟随系统会自动匹配操作系统的明暗偏好。">
        <div className="flex gap-2" role="group" aria-label="主题">
          {THEMES.map((item) => (
            <Button
              key={item.value}
              variant={theme === item.value ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="回复风格"
        description={roleMode === "tech" ? "展示工具调用等工作过程，便于核查任务执行。" : "隐藏工作过程，只展示结论和必要说明。"}
      >
        <SettingsRow label="展示工作过程" hint="需要核查小财如何完成任务时开启">
          <div className="flex justify-end gap-2" role="group" aria-label="展示工作过程">
            {(["tech", "daily"] as const).map((mode) => (
              <Button
                key={mode}
                variant={roleMode === mode ? "default" : "outline"}
                size="sm"
                onClick={() => onRoleModeChange(mode)}
              >
                {mode === "tech" ? "展示" : "隐藏"}
              </Button>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
