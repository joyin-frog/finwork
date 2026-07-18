"use client";

import { useUsage } from "@/app/chat/use-usage";
import { UsageDetail } from "@/app/chat/usage-ring";

/** 设置·用量页:展示 5h / 周两档额度比例(只看比例,不露绝对数与上限)。 */
export function UsageSettings() {
  const { usage } = useUsage();

  if (usage && !usage.enabled) {
    return <p className="text-small text-muted-foreground">用量限制当前未启用。</p>;
  }

  return (
    <div className="flex w-full flex-col">
      {usage ? <UsageDetail usage={usage} separated /> : <p className="text-small text-muted-foreground">加载中…</p>}
    </div>
  );
}
