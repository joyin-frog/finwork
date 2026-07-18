"use client";

import { Callout } from "@/app/components/callout";
import { humanizeAgentError } from "@/lib/agent/agent-error";

/** 一个回合出错/未完成时的提示块：只展示用户可理解、可行动的中文说明。 */
export function TurnError({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    // 全宽:与对话正文同宽,不再 self-start 缩成窄条(和 usage_blocked 等其它提示统一走 Callout 全宽)。
    <div className="mt-1">
      <Callout variant="warn" className="w-full">
        {humanizeAgentError(error).message}
      </Callout>
    </div>
  );
}
