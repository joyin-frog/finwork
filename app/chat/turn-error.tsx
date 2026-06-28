"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { Callout } from "@/app/components/callout";
import { humanizeAgentError } from "@/lib/agent/agent-error";

/**
 * 一个回合出错/未完成时的提示块:warn 档 Callout(友好文案 + 可折叠原始详情)
 * + 一个幽灵「重试」按钮(无底,刷新图标,hover 才浮底)。
 * error 为空则不渲染框;onRetry 为空则不渲染按钮;两者都空时整体不渲染。
 * 原始错误正文(message.content)仍由上方 markdown 渲染,这里只负责「翻译 + 详情 + 重试」。
 */
export function TurnError({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  if (!error && !onRetry) return null;
  return (
    <div className="self-start flex flex-col items-start gap-1 mt-1 max-w-full">
      {error ? (
        <Callout variant="warn">
          {humanizeAgentError(error).message}
          <details className="mt-1">
            <summary className="cursor-pointer list-none text-meta text-muted-foreground hover:text-foreground">详情</summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 text-meta text-muted-foreground">{error}</pre>
          </details>
        </Callout>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-small text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={RefreshIcon} size={14} />
          重试
        </button>
      ) : null}
    </div>
  );
}
