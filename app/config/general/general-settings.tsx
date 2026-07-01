"use client";

import { useRef } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Input } from "@/components/ui/input";
import { SettingsSection, SettingsRow } from "@/app/config/settings-ui";
import { UserAvatar } from "@/app/shared/user-avatar";

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
}: {
  agentName: string;
  companyName: string;
  userName: string;
  userAvatar: string;
  onAgentNameChange: (value: string) => void;
  onCompanyNameChange: (value: string) => void;
  onUserNameChange: (value: string) => void;
  onUserAvatarChange: (value: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    </div>
  );
}
