"use client";

/**
 * 转交卡（TransferProposalCard）— D2·刀8
 *
 * 由 propose_transfer 工具返回的 structuredContent.kind === "transfer_proposal" 触发渲染。
 * 设计：左侧 --tone-notice 警示色条 + 角色名标题 + 原因说明 + 两个操作按钮。
 *
 * 处理状态用 localStorage 持久化（key 由 targetRoleId + taskSummary 前缀构成），
 * 避免刷新后重复操作。
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Surface } from "@/components/ui/surface";
import { Button } from "@/components/ui/button";

export type TransferProposalData = {
  kind: "transfer_proposal";
  /** M3·刀8: 工具端生成的 UUID，用作 localStorage 键的稳定唯一标识 */
  proposalId: string;
  targetRoleId: string;
  targetRoleName: string;
  taskSummary: string;
  instructions: string;
  reason: string;
  originConversationId: number | null;
};

export function parseTransferProposalStructured(structured: unknown): TransferProposalData | null {
  if (structured == null || typeof structured !== "object") return null;
  const s = structured as Record<string, unknown>;
  if (s.kind !== "transfer_proposal") return null;
  if (typeof s.targetRoleId !== "string" || typeof s.targetRoleName !== "string") return null;
  if (typeof s.taskSummary !== "string" || typeof s.instructions !== "string" || typeof s.reason !== "string") return null;
  // proposalId: 新版工具端生成的 UUID；旧版数据（无此字段）回退到 targetRoleId+摘要的降级键
  const proposalId = typeof s.proposalId === "string" && s.proposalId
    ? s.proposalId
    : `${s.targetRoleId}_${(s.taskSummary as string).slice(0, 30)}`;
  return {
    kind: "transfer_proposal",
    proposalId,
    targetRoleId: s.targetRoleId,
    targetRoleName: s.targetRoleName,
    taskSummary: s.taskSummary,
    instructions: s.instructions,
    reason: s.reason,
    originConversationId: typeof s.originConversationId === "number" ? s.originConversationId : null,
  };
}

function localKey(data: TransferProposalData): string {
  // M3·刀8: 以 proposalId（工具端 UUID）为键，避免同角色同摘要的两张卡撞键。
  // 旧版数据无 proposalId，parse 时已降级为 targetRoleId+摘要前缀拼接。
  return `tp_handled_${data.proposalId}`;
}

export function TransferProposalCard({ data }: { data: TransferProposalData }) {
  const [handled, setHandled] = useState<"transferred" | "dismissed" | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(localKey(data));
      if (stored === "transferred" || stored === "dismissed") {
        setHandled(stored);
      }
    } catch {
      // localStorage 不可用（如 SSR），忽略
    }
  }, [data]);

  const handleTransfer = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/agents/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetRoleId: data.targetRoleId,
          taskSummary: data.taskSummary,
          instructions: data.instructions,
          originConversationId: data.originConversationId,
        }),
      });
      if (res.ok) {
        try { localStorage.setItem(localKey(data), "transferred"); } catch { /* ignore */ }
        setHandled("transferred");
        toast.success(`已排入「${data.targetRoleName}」队列`);
      } else {
        toast.error("转交失败，请稍后重试");
      }
    } catch {
      toast.error("转交失败，请检查网络");
    } finally {
      setLoading(false);
    }
  }, [data]);

  const handleDismiss = useCallback(() => {
    try { localStorage.setItem(localKey(data), "dismissed"); } catch { /* ignore */ }
    setHandled("dismissed");
  }, [data]);

  if (handled === "transferred") {
    return (
      <Surface className="shadow-none overflow-hidden text-body">
        <div className="px-3 py-2 text-meta text-muted-foreground">
          已排入「{data.targetRoleName}」队列，可在智能体页面查看进度。
        </div>
      </Surface>
    );
  }

  if (handled === "dismissed") {
    return (
      <Surface className="shadow-none overflow-hidden text-body">
        <div className="px-3 py-2 text-meta text-muted-foreground">
          已忽略此转交建议。
        </div>
      </Surface>
    );
  }

  return (
    <Surface className="shadow-none overflow-hidden text-body" style={{ borderLeft: "2px solid var(--tone-notice)" }}>
      {/* 标题行 */}
      <div className="px-3 py-2 border-b border-[color:var(--tone-notice)]/30 bg-[color:var(--tone-notice)]/12 text-meta flex items-center gap-2">
        <span className="font-semibold" style={{ color: "var(--tone-notice)" }}>
          建议转交 · {data.targetRoleName}
        </span>
      </div>
      {/* 原因 + 操作 */}
      <div className="px-3 py-2.5 flex flex-col gap-2">
        <p className="text-body">{data.reason}</p>
        {data.taskSummary && (
          <p className="text-meta text-muted-foreground">{data.taskSummary}</p>
        )}
        <div className="flex items-center gap-2 pt-0.5">
          <Button size="sm" onClick={handleTransfer} disabled={loading}>
            {loading ? "转交中…" : `转给${data.targetRoleName}处理`}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDismiss} disabled={loading}>
            不用了
          </Button>
        </div>
      </div>
    </Surface>
  );
}
