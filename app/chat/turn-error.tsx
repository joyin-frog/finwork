"use client";

import { Callout } from "@/app/components/callout";
import { humanizeAgentError } from "@/lib/agent/agent-error";

/**
 * 一个回合出错/未完成时的提示块:warn 档 Callout(友好文案 + 可折叠原始详情)。
 * error 为空则不渲染。
 * 「重试」动作已并入回合底部操作行(见 chat-page 的 AssistantTurn 操作区),这里只负责「翻译 + 详情」。
 * 原始错误正文(message.content)仍由上方 markdown 渲染。
 */
export function TurnError({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <div className="self-start flex flex-col items-start gap-1 mt-1 max-w-full">
      <Callout variant="warn">
        {humanizeAgentError(error).message}
        <details className="mt-1">
          <summary className="cursor-pointer list-none text-meta text-muted-foreground hover:text-foreground">详情</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 text-meta text-muted-foreground">{error}</pre>
        </details>
      </Callout>
    </div>
  );
}
