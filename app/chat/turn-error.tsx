"use client";

import { Callout } from "@/app/components/callout";
import { humanizeAgentError } from "@/lib/agent/agent-error";

/** 一个回合出错/未完成时的提示块：只展示用户可理解、可行动的中文说明。 */
export function TurnError({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    // 错误提示与 usage_blocked 使用同一信息卡宽度，避免短提示铺满整行。
    <div className="mt-1">
      <Callout variant="warn" className="w-2/3 min-w-[280px] max-w-full">
        {humanizeAgentError(error).message}
      </Callout>
    </div>
  );
}
