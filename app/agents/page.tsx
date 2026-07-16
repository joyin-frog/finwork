"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LayoutAlignRightIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { usePreviewResize } from "@/app/shared/use-preview-resize";
import { ResizablePreviewPanel } from "@/app/shared/resizable-preview-panel";
import { AgentCard } from "./agent-card";
import { AgentDetailDrawer } from "./agent-detail-drawer";
import { AttentionPanel } from "./attention-panel";
import { TaskBoardView } from "./task-board";
import { partitionRoles, type RoleCard } from "@/lib/domain/agent-board";
import type { AttentionItem } from "@/lib/domain/attention";
import type { TaskBoard } from "@/lib/domain/task-board";
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
  const [view, setView] = useState<"team" | "board">("team");
  const [roster, setRoster] = useState<AgentRosterItem[] | null>(null);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [dispatches, setDispatches] = useState<DispatchRow[] | null>(null);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [dispatchError, setDispatchError] = useState(false);
  // 派发详情请求令牌：快速切换角色时，防止慢的旧请求覆盖新角色的数据
  const dispatchReqRef = useRef(0);

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
        setBoard(json.data.board ?? null);
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

  // 派发详情拉取（供 handleSelectRole 首次加载和重试共用）
  const fetchDispatchesForRole = useCallback(async (roleId: string) => {
    setDispatchError(false);
    setDispatches(null);
    setDispatchLoading(true);
    const reqId = ++dispatchReqRef.current;
    try {
      const res = await fetch(`/api/agents/dispatches?roleId=${encodeURIComponent(roleId)}&limit=8`);
      const json = await res.json();
      // 已被更晚的选择抢占 → 丢弃这次(旧)响应，别覆盖新角色的数据/加载态
      if (reqId !== dispatchReqRef.current) return;
      if (json.ok) setDispatches(json.data.rows);
      else { setDispatchError(true); setDispatches([]); }
    } catch {
      if (reqId !== dispatchReqRef.current) return;
      setDispatchError(true); setDispatches([]);
    } finally {
      if (reqId === dispatchReqRef.current) setDispatchLoading(false);
    }
  }, []);

  // 选中角色时加载派发详情
  const handleSelectRole = useCallback(
    async (roleId: string) => {
      if (selectedRoleId === roleId) {
        // 再次点击同一卡片：已收起 → 重新展开；已展开 → 关闭抽屉
        if (collapsed) open();
        else {
          setSelectedRoleId(null);
          toggle();
        }
        return;
      }
      setSelectedRoleId(roleId);
      open();
      await fetchDispatchesForRole(roleId);
    },
    [selectedRoleId, collapsed, open, toggle, fetchDispatchesForRole]
  );

  // 收起预览（保留选中角色，可从顶栏「展开预览」再打开）。
  // 无独立「关闭」：收起已够用（对齐 files/knowledge 预览页）；再次点选中卡即完全取消选中。
  const handleCollapseDrawer = useCallback(() => {
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
    // 标题栏收进 list 插槽（只跨列表列），预览卡因此能从顶端起、盖住标题栏区——对齐 files/knowledge。
    <div className="flex flex-col h-full overflow-hidden">
      <ResizablePreviewPanel
        mainRef={mainRef}
        previewW={previewW}
        maximized={maximized}
        collapsed={collapsed}
        dragging={dragging}
        onBeginResize={beginResize}
        listMinWidthClass="min-w-[420px]"
        list={
          <>
            {/* Topbar —— 只跨列表列，不横跨预览：预览卡浮在右侧、脱离标题栏（对齐 files/knowledge） */}
            <header className="app-page-header relative flex items-center gap-3 pr-5 h-11 shrink-0">
              <DragHandle />
              <SidebarToggle />
              {/* 分段切换：团队 ｜ 本月任务（state 版，不改 URL） */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setView("team")}
                  className={[
                    "text-title transition-colors whitespace-nowrap bg-transparent border-none p-0 cursor-pointer",
                    view === "team" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                >
                  团队
                </button>
                <span className="text-title font-normal text-muted-foreground/40 select-none">｜</span>
                <button
                  type="button"
                  onClick={() => setView("board")}
                  className={[
                    "text-title transition-colors whitespace-nowrap bg-transparent border-none p-0 cursor-pointer",
                    view === "board" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                >
                  本月任务
                </button>
              </div>
              {/* 预览已收起且仍有选中角色 → 顶栏显示「展开预览」重开 */}
              {collapsed && selectedRoleId && view === "team" && (
                <button
                  type="button"
                  // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                  className="ml-auto p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  onClick={open}
                  title="展开预览"
                  aria-label="展开预览"
                  aria-expanded={false}
                >
                  <HugeiconsIcon icon={LayoutAlignRightIcon} size={16} />
                </button>
              )}
            </header>

            <div className="content-fade-top flex-1 overflow-auto p-page flex flex-col gap-5">
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
            ) : view === "board" ? (
              board ? (
                <TaskBoardView board={board} />
              ) : (
                <div className="flex items-center justify-center py-16 text-body text-muted-foreground">
                  看板数据不可用
                </div>
              )
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
          </>
        }
        preview={
          !collapsed && selectedCard ? (
            <AgentDetailDrawer
              card={selectedCard}
              dispatches={dispatchLoading ? null : dispatches}
              dispatchError={dispatchError}
              onRetryDispatches={selectedRoleId ? () => void fetchDispatchesForRole(selectedRoleId!) : undefined}
              maximized={maximized}
              onMaximize={maximize}
              onCollapse={handleCollapseDrawer}
            />
          ) : null
        }
      />
    </div>
  );
}
