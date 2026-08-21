"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, LayoutAlignRightIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { usePreviewResize } from "@/app/shared/use-preview-resize";
import { ResizablePreviewPanel } from "@/app/shared/resizable-preview-panel";
import { AgentCard } from "./agent-card";
import { AgentDetailDrawer } from "./agent-detail-drawer";
import { AttentionPanel } from "./attention-panel";
import type { RoleCard } from "@/lib/domain/agent-board";
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
  reviewPending?: boolean;
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

  // 卡片首页按当前状态排序：进行中/待拍板的角色优先，其余角色保持注册表顺序。
  const cards: RoleCard[] = roster
    ? [...roster]
        .map((item) => ({
          ...item,
          isActive: item.status === "running" || Boolean(item.blockedReason) || item.reviewPending === true,
        }))
        .sort((a, b) => Number(b.isActive) - Number(a.isActive))
    : [];

  const selectedCard: RoleCard | null =
    selectedRoleId
      ? (cards.find((c) => c.roleId === selectedRoleId) ?? null)
      : null;

  const runningCount = roster?.filter((item) => item.status === "running").length ?? 0;
  const pendingCount = roster?.filter((item) => Boolean(item.blockedReason) || item.reviewPending === true).length ?? 0;
  const enabledCount = roster?.filter((item) => item.available && !item.userDisabled).length ?? 0;

  function renderCardGroup(items: RoleCard[]) {
    return items.map((card) => (
      <AgentCard
        key={card.roleId}
        card={card}
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
              <h1 className="text-title font-semibold">智能体</h1>
              {/* 预览已收起且仍有选中角色 → 顶栏显示「展开预览」重开 */}
              {collapsed && selectedRoleId && (
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

            <div className="content-fade-top flex-1 overflow-auto p-page flex flex-col gap-6">
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
                <section className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <h1 className="text-display font-semibold">智能体</h1>
                    <p className="mt-1 text-body text-muted-foreground">管理你的财务专员，查看状态并进入专属对话。</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled
                    title="自定义智能体将在后续版本开放"
                    aria-label="新增智能体（后续版本开放）"
                  >
                    <HugeiconsIcon icon={Add01Icon} size={15} />
                    新增智能体
                  </Button>
                </section>

                <div className="flex items-center gap-2 flex-wrap" aria-label="智能体状态汇总">
                  <Surface level="page" edge="hairline" shape="pill" className="text-meta px-2.5 py-1">
                    {roster?.length ?? 0} 个智能体
                  </Surface>
                  <Surface level="page" edge="hairline" shape="pill" className="text-meta px-2.5 py-1">
                    <span className="text-primary">{runningCount}</span> 进行中
                  </Surface>
                  <Surface level="page" edge="hairline" shape="pill" className="text-meta px-2.5 py-1">
                    <span style={{ color: "var(--tone-notice)" }}>{pendingCount}</span> 待拍板
                  </Surface>
                  <Surface level="page" edge="hairline" shape="pill" className="text-meta px-2.5 py-1">
                    {enabledCount} 个已启用
                  </Surface>
                </div>

                <AttentionPanel items={attention} />

                {cards.length > 0 && (
                  <section className="flex flex-col gap-2">
                    <h2 className="text-title font-semibold">全部智能体</h2>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                      {renderCardGroup(cards)}
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
