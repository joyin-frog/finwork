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
    <div className="flex max-w-md flex-col gap-4">
      <p className="text-small text-muted-foreground">
        为避免任务异常时持续消耗 API 额度，系统设有 5 小时与每周两档用量上限。达到上限会暂停问答，到重置时刻自动恢复。
      </p>
      {usage ? <UsageDetail usage={usage} /> : <p className="text-small text-muted-foreground">加载中…</p>}
    </div>
  );
}
