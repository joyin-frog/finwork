"use client";

import type { ReactNode } from "react";

/** 设置分组:纸面上的区块(顶部发丝线分隔),取代白卡——消除"白块跳眼"。 */
export function SettingsSection({ title, description, children }: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-body font-medium">{title}</h3>
        {description ? <p className="text-meta text-muted-foreground max-w-prose">{description}</p> : null}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
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
      <div className={wide ? "shrink-0 w-72 max-w-[60%]" : "shrink-0 w-56 max-w-[55%]"}>{children}</div>
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
