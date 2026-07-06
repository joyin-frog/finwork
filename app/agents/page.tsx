"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { usePreviewResize } from "@/app/shared/use-preview-resize";
import { ResizablePreviewPanel } from "@/app/shared/resizable-preview-panel";
import { cn } from "@/lib/utils";
import { AgentCard } from "./agent-card";
import { AgentDetailDrawer } from "./agent-detail-drawer";
import { AttentionPanel } from "./attention-panel";
import { partitionRoles, type RoleCard } from "@/lib/domain/agent-board";
import type { AttentionItem } from "@/lib/domain/attention";
import type { DispatchRow } from "@/lib/db/dispatch-store";

// ─── Types (mirrors /api/agents response) ──────────────────────────────────

type SkillEntry = { name: string; description: string };
type InvoiceStats = { total: number; addedThisMonth: number };

type AgentRosterItem = {
  roleId: string;
  name: string;
  domain: string;
  charter: string;
  dataScope: string[];
  skills: SkillEntry[];
  available: boolean;
  userDisabled: boolean;
  dispatchCount: number;
  lastAt: string | null;
  lastSummary?: string | null;
  status?: string | null;
  blockedReason?: string | null;
  conversationId?: string | null;
  invoiceStats?: InvoiceStats;
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const [roster, setRoster] = useState<AgentRosterItem[] | null>(null);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [dispatches, setDispatches] = useState<DispatchRow[] | null>(null);
  const [dispatchLoading, setDispatchLoading] = useState(false);

  // listMinW >= 400 per spec (评审 P2 要求：默认 300 太小，参照 files 页 460)
  const { collapsed, previewW, dragging, maximized, mainRef, beginResize, open, toggle, maximize } =
    usePreviewResize(460);

  const fetchRoster = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agents");
      const json = await res.json();
      if (json.ok) {
        setRoster(json.data.roster);
        setAttention(json.data.attention ?? []);
      } else {
        setError(json.error || "加载失败");
      }
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  }, []);

  // 进入/切回重取（MVP 实时状态）
  useEffect(() => {
    void fetchRoster();
    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchRoster();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchRoster]);

  // running 时轻量轮询（仅有 running 派发时，每 8s）
  useEffect(() => {
    if (!roster) return;
    const hasRunning = roster.some((r) => r.status === "running");
    if (!hasRunning) return;
    const timer = setInterval(() => void fetchRoster(), 8000);
    return () => clearInterval(timer);
  }, [roster, fetchRoster]);

  // 选中角色时加载派发详情
  const handleSelectRole = useCallback(
    async (roleId: string) => {
      if (selectedRoleId === roleId) {
        // 再次点击同一卡片 → 关闭抽屉
        setSelectedRoleId(null);
        toggle();
        return;
      }
      setSelectedRoleId(roleId);
      open();
      setDispatches(null);
      setDispatchLoading(true);
      try {
        const res = await fetch(`/api/agents/dispatches?roleId=${encodeURIComponent(roleId)}&limit=8`);
        const json = await res.json();
        if (json.ok) setDispatches(json.data.rows);
        else setDispatches([]);
      } catch {
        setDispatches([]);
      } finally {
        setDispatchLoading(false);
      }
    },
    [selectedRoleId, open, toggle]
  );

  const handleCloseDrawer = useCallback(() => {
    setSelectedRoleId(null);
    toggle();
  }, [toggle]);

  // 分组（partition）
  const { active, rest } = roster
    ? partitionRoles(roster)
    : { active: [], rest: [] };

  const selectedCard: RoleCard | null =
    selectedRoleId
      ? ([...active, ...rest].find((c) => c.roleId === selectedRoleId) ?? null)
      : null;

  function renderCardGroup(cards: RoleCard[], compact: boolean) {
    return cards.map((card) => (
      <AgentCard
        key={card.roleId}
        card={card}
        compact={compact}
        selected={selectedRoleId === card.roleId}
        onClick={() => void handleSelectRole(card.roleId)}
        onToggled={fetchRoster}
      />
    ));
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Topbar */}
      <header
        className={cn(
          "relative flex items-center gap-3 pr-5 h-11 shrink-0",
          maximized && "hidden"
        )}
      >
        <DragHandle />
        <SidebarToggle />
        <h1 className="text-title">智能体</h1>
      </header>

      {/* Main area — left cards + right drawer */}
      <ResizablePreviewPanel
        mainRef={mainRef}
        previewW={previewW}
        maximized={maximized}
        collapsed={collapsed}
        dragging={dragging}
        onBeginResize={beginResize}
        listMinWidthClass="min-w-[420px]"
        list={
          <div className="flex-1 overflow-auto p-6 flex flex-col gap-5">
            {error ? (
              <div className="flex flex-col items-center gap-3 py-16 text-body text-muted-foreground">
                <p>{error}</p>
                <Button variant="outline" size="sm" onClick={fetchRoster}>
                  重试
                </Button>
              </div>
            ) : loading ? (
              <div className="flex items-center justify-center py-16 text-body text-muted-foreground">
                加载中…
              </div>
            ) : (
              <>
                {/* 等你拍板区 */}
                <AttentionPanel items={attention} />

                {/* 在忙·待拍板组 */}
                {active.length > 0 && (
                  <section className="flex flex-col gap-2">
                    <h2 className="text-title font-semibold">在忙 · 待拍板</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {renderCardGroup(active, false)}
                    </div>
                  </section>
                )}

                {/* 其他角色组（含尚未启用/已停用的弱化卡） */}
                {rest.length > 0 && (
                  <section className="flex flex-col gap-2">
                    {active.length > 0 && (
                      <h2 className="text-title font-semibold text-muted-foreground">其他</h2>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {renderCardGroup(rest, active.length > 0)}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        }
        preview={
          !collapsed && selectedCard ? (
            <AgentDetailDrawer
              card={selectedCard}
              dispatches={dispatchLoading ? null : dispatches}
              maximized={maximized}
              onMaximize={maximize}
              onClose={handleCloseDrawer}
            />
          ) : null
        }
      />
    </div>
  );
}
