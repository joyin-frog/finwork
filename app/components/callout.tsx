"use client";

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { InfoIcon, SuccessCircleIcon, WarningIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";

export type CalloutVariant = "info" | "ok" | "warn" | "neutral";

// 统一的提示块语言:卡片底 + 细边 + 微影,语义色只落在图标(+可选标题),描述统一灰。
// 手写 div(不基于 shadcn Alert:其 *:[svg]:text-current 会把语义图标色拉回灰)。
// accent 用字面 Tailwind 任意值类(Tailwind 需字面串才能生成,故每档枚举)。
const VARIANTS: Record<CalloutVariant, { icon: IconSvgElement; accent: string }> = {
  info: { icon: InfoIcon, accent: "text-[color:var(--tone-neutral)]" },
  ok: { icon: SuccessCircleIcon, accent: "text-[color:var(--tone-ok)]" },
  warn: { icon: WarningIcon, accent: "text-[color:var(--tone-alarm)]" },
  neutral: { icon: InfoIcon, accent: "text-muted-foreground" },
};

export function Callout({
  variant = "neutral",
  icon,
  title,
  children,
  className,
}: {
  variant?: CalloutVariant;
  /** 覆盖该 variant 的默认图标(如溯源块用 SecurityCheckIcon)。 */
  icon?: IconSvgElement;
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const { icon: defaultIcon, accent } = VARIANTS[variant];
  return (
    <div
      role={variant === "warn" ? "alert" : "status"}
      className={cn(
        "grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 max-w-full rounded-lg border border-border bg-card px-3 py-2.5 text-small shadow-[var(--elevation-1)]",
        className,
      )}
    >
      <HugeiconsIcon icon={icon ?? defaultIcon} size={14} className={cn("row-span-2 mt-0.5 shrink-0", accent)} />
      {title ? <div className="self-center font-medium text-foreground">{title}</div> : null}
      <div className={cn("col-start-2 text-muted-foreground", !title && "self-center")}>{children}</div>
    </div>
  );
}
