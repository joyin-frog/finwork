"use client";

import { Children, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Surface } from "@/components/ui/surface";

/** 设置分组:标题+说明在上,内容放圆角卡片;多项之间用首尾留缝的分隔线(与内容区同宽缩进)。 */
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
          <div key={i}>
            {/* 发丝分隔：1px + 半透明，比通栏 border 更轻；亚像素细线各端不一致，故用降不透明度 */}
            {i > 0 ? <div className="mx-4 h-px bg-border/50" aria-hidden /> : null}
            <div className="px-4 py-3">{child}</div>
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
  // 控件相对左侧整块（标题，或标题+说明）垂直居中。
  return (
    <div className="flex items-center justify-between gap-6 py-0.5">
      <label htmlFor={htmlFor} className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body">{label}</span>
        {hint ? <span className="text-meta text-muted-foreground">{hint}</span> : null}
      </label>
      <div className={cn("flex shrink-0 justify-end", wide ? "w-72 max-w-[60%]" : "w-44 max-w-[55%]")}>
        {children}
      </div>
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
