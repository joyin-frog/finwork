"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { UserIcon } from "@hugeicons/core-free-icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * 用户头像:有图显示图,没图用姓名首字兜底(主色底),连姓名都没有则一个用户图标。
 * 侧栏底部头像行与设置页共用,尺寸走 Avatar 的 sm/default/lg 三档。
 */
export function UserAvatar({
  name,
  avatar,
  size = "default",
  className,
}: {
  name: string;
  avatar: string;
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  const initial = [...name.trim()][0] ?? "";
  return (
    <Avatar size={size} className={className}>
      {avatar ? <AvatarImage src={avatar} alt={name || "用户头像"} /> : null}
      <AvatarFallback className={initial ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground"}>
        {initial || <HugeiconsIcon icon={UserIcon} size={16} />}
      </AvatarFallback>
    </Avatar>
  );
}
