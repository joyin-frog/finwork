"use client";

import { Children, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Surface } from "@/components/ui/surface";

/** 设置分组:标题+说明在上,内容放圆角卡片,卡片内多项之间横线分隔(macOS/Codex 风格)。 */
export function SettingsSection({ title, description, children }: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const items = Children.toArray(children).filter(Boolean);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-body font-medium">{title}</h3>
        {description ? <p className="text-meta text-muted-foreground max-w-prose">{description}</p> : null}
      </div>
      <Surface level="card" edge="hairline" shape="card" className="overflow-hidden">
        {items.map((child, i) => (
          <div key={i} className={cn("px-4 py-3", i > 0 && "border-t border-border")}>
            {child}
          </div>
        ))}
      </Surface>
    </section>
  );
}

/** 设置行:label 左、控件右;短值控件自动限宽,避免整行过长。 */
export function SettingsRow({ label, htmlFor, hint, wide, children }: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-0.5">
      <label htmlFor={htmlFor} className="flex flex-col gap-0.5 min-w-0 pt-1.5">
        <span className="text-body">{label}</span>
        {hint ? <span className="text-meta text-muted-foreground">{hint}</span> : null}
      </label>
      <div className={cn("shrink-0 flex justify-end", wide ? "w-72 max-w-[60%]" : "w-44 max-w-[55%]")}>{children}</div>
    </div>
  );
}

/** 设置字段:label 上、控件整行下——只给长值(API URL / Key / 路径)用。 */
export function SettingsField({ label, htmlFor, hint, children }: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-0.5">
      <label htmlFor={htmlFor} className="text-body">{label}</label>
      {hint ? <span className="-mt-1 text-meta text-muted-foreground">{hint}</span> : null}
      {children}
    </div>
  );
}

/** 与 Input 视觉一致的原生 select 样式(28px、bg-input/20、无阴影)。 */
export const settingsSelectClass =
  "h-8 w-full rounded-md border border-input bg-input/20 px-2.5 text-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30";

/** 防抖自动保存的统一状态语言:idle 不渲染,saving/saved/error 用文字表达。 */
export type SaveStatus = "idle" | "saving" | "saved" | "error";

/** 保存状态文字指示(全设置页统一,「已保存 ✓」风格)。 */
export function SaveStatusText({ status }: { status: SaveStatus }) {
  if (status === "idle") return null;
  const text = status === "saving" ? "保存中…" : status === "saved" ? "已保存 ✓" : "保存失败,请重试";
  const tone =
    status === "error" ? "text-destructive" : status === "saved" ? "text-[color:var(--tone-ok)]" : "text-muted-foreground";
  return <span className={`text-meta ${tone}`}>{text}</span>;
}
