"use client";

/**
 * agent-detail-drawer.tsx — 角色详情右侧抽屉
 *
 * 复用 usePreviewResize（listMinW=460，与 files 页对齐）。
 * maximized 时左侧网格 hidden——既有语义，照 app/files/page.tsx 接法。
 * 文件产物（finalize_deliverable 声明的文件）→ 点开渲染 FilePreviewPage。
 *
 * 注意：本组件只是抽屉内容区，由 page.tsx 控制显隐和 mainRef。
 */

import type { CSSProperties } from "react";
import { useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowExpand01Icon, ArrowShrink01Icon, Cancel01Icon, PanelRightIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { FilePreviewPage, type LocalPreviewFile } from "@/app/shared/file-preview-page";
import { ROLE_UI } from "@/lib/domain/role-ui";
import { relativeTime } from "@/lib/utils/relative-time";
import type { RoleCard } from "@/lib/domain/agent-board";
import type { DispatchRow } from "@/lib/db/dispatch-store";

type AgentDetailDrawerProps = {
  card: RoleCard;
  dispatches: DispatchRow[] | null;
  maximized: boolean;
  onMaximize: () => void;
  /** 收起预览（保留选中，顶栏可再展开）——对齐 files/knowledge 的「收起右侧栏」 */
  onCollapse: () => void;
  onClose: () => void;
};

export function AgentDetailDrawer({
  card,
  dispatches,
  maximized,
  onMaximize,
  onCollapse,
  onClose,
}: AgentDetailDrawerProps) {
  const [filePreview, setFilePreview] = useState<LocalPreviewFile | null>(null);

  const ui = ROLE_UI[card.roleId as keyof typeof ROLE_UI];
  const tone = ui?.tone ?? "--tone-neutral";
  const isRunning = card.status === "running";
  const isBlocked = card.blockedReason != null && card.blockedReason !== "";

  // 找出有文件产物的派发（label 以文件扩展名结尾的，视作 finalize_deliverable 输出）
  const fileDispatches =
    dispatches?.filter(
      (d) => d.label && /\.(xlsx|pdf|docx|csv|txt|md)$/i.test(d.label)
    ) ?? [];

  return (
    <div className="flex flex-col overflow-hidden h-full bg-card">
        {/* 头部：单行，与列表列 h-11 标题栏对齐——padding 同 .preview-head-card（中线 22px、分隔线 44px）。
            avatar / icon-btn 均 32px 高，名称+简介同一行（简介 truncate），不再撑成两行。 */}
        <div className="flex items-center gap-3 px-[14px] pt-px pb-1.5 border-b border-border shrink-0">
          <span
            className="fa-toned shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-body font-semibold select-none"
            style={{ "--tone": `var(${tone})` } as CSSProperties}
            aria-hidden="true"
          >
            {card.name.slice(0, 1)}
          </span>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className="text-body font-semibold shrink-0">{card.name}</span>
            {isRunning && (
              <span
                className="fa-tone-pill text-meta shrink-0"
                style={{ "--tone": "var(--tone-analysis)" } as CSSProperties}
              >
                进行中
              </span>
            )}
            {isBlocked && !isRunning && (
              <span
                className="fa-tone-pill text-meta shrink-0"
                style={{ "--tone": "var(--tone-notice)" } as CSSProperties}
              >
                待拍板
              </span>
            )}
            <span className="text-meta text-muted-foreground truncate">{card.charter}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="icon" onClick={onMaximize} aria-label={maximized ? "还原" : "放大"}>
              <HugeiconsIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} size={16} />
            </Button>
            {/* 收起右侧栏（保留选中，顶栏「展开预览」可再打开）——放大态下无左列可退，隐藏收起按钮 */}
            {!maximized && (
              <Button variant="ghost" size="icon" onClick={onCollapse} aria-label="收起右侧栏">
                <HugeiconsIcon icon={PanelRightIcon} size={16} />
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
              <HugeiconsIcon icon={Cancel01Icon} size={16} />
            </Button>
          </div>
        </div>

        {/* 内容 */}
        {filePreview ? (
          <div className="flex-1 overflow-hidden">
            <FilePreviewPage
              selection={filePreview}
              onSelectionChange={(s) => {
                if (!s) setFilePreview(null);
              }}
              docked
              isMaximized={maximized}
              onMaximize={onMaximize}
              onCollapse={() => setFilePreview(null)}
            />
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-4 flex flex-col gap-5">
            {/* 当前状态 */}
            {(isRunning || isBlocked) && (
              <section>
                <p className="text-meta font-medium text-muted-foreground mb-2">当前状态</p>
                {isRunning && (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                    <span
                      className="fa-tone-dot fa-dot-pulse shrink-0"
                      style={{ "--tone": "var(--tone-analysis)" } as CSSProperties}
                    />
                    <span className="text-body">正在执行任务</span>
                    {card.lastSummary && (
                      <span className="text-meta text-muted-foreground truncate flex-1">
                        — {card.lastSummary.split("\n")[0]}
                      </span>
                    )}
                  </div>
                )}
                {isBlocked && !isRunning && card.conversationId && (
                  <div
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2 fa-toned"
                    style={{ "--tone": "var(--tone-notice)" } as CSSProperties}
                  >
                    <span className="fa-tone-pill text-meta shrink-0">停在确认门</span>
                    <span className="text-body flex-1 min-w-0 truncate">
                      {card.blockedReason}
                    </span>
                    <Link href={`/chat/recent?id=${card.conversationId}`} className="shrink-0">
                      <Button variant="outline" size="sm">去确认</Button>
                    </Link>
                  </div>
                )}
              </section>
            )}

            {/* 最近任务 */}
            <section>
              <p className="text-meta font-medium text-muted-foreground mb-2">最近任务</p>
              {dispatches == null ? (
                <p className="text-meta text-muted-foreground">加载中…</p>
              ) : dispatches.length === 0 ? (
                <p className="text-meta text-muted-foreground">暂无工作记录</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {dispatches.slice(0, 8).map((row) => {
                    const isRowBlocked = row.blockedReason != null;
                    const href = row.conversationId
                      ? `/chat/recent?id=${row.conversationId}`
                      : undefined;
                    const inner = (
                      <div
                        className={`flex items-start gap-2 rounded px-2 py-1.5 text-meta ${isRowBlocked ? "fa-toned" : "bg-muted/40"}`}
                        style={
                          isRowBlocked
                            ? ({ "--tone": "var(--tone-notice)" } as CSSProperties)
                            : undefined
                        }
                      >
                        {isRowBlocked && (
                          <span
                            className="fa-tone-pill shrink-0 font-medium whitespace-nowrap"
                            style={{ "--tone": "var(--tone-notice)" } as CSSProperties}
                          >
                            待确认
                          </span>
                        )}
                        {row.status === "running" && !isRowBlocked && (
                          <span
                            className="fa-tone-pill shrink-0 whitespace-nowrap"
                            style={{ "--tone": "var(--tone-analysis)" } as CSSProperties}
                          >
                            进行中
                          </span>
                        )}
                        <span className="flex-1 min-w-0 truncate text-foreground">
                          {row.label ?? row.summary ?? `#${row.id}`}
                        </span>
                        <span className="shrink-0 text-muted-foreground whitespace-nowrap">
                          {relativeTime(row.startedAt)}
                        </span>
                      </div>
                    );
                    return href ? (
                      <Link key={row.id} href={href} className="block hover:no-underline">
                        {inner}
                      </Link>
                    ) : (
                      <div key={row.id}>{inner}</div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* 文件产物 */}
            {fileDispatches.length > 0 && (
              <section>
                <p className="text-meta font-medium text-muted-foreground mb-2">文件产物</p>
                <div className="flex flex-col gap-1.5">
                  {fileDispatches.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className="flex items-center gap-2 rounded px-2 py-1.5 bg-muted/40 hover:bg-muted/70 transition-colors text-left"
                      onClick={() => {
                        // 文件产物走 FilePreviewPage（知识库路径或会话路径）
                        if (d.label) {
                          setFilePreview({
                            kind: "local",
                            path: d.label,
                            name: d.label.split("/").pop() ?? d.label,
                          });
                        }
                      }}
                    >
                      <span className="text-meta flex-1 min-w-0 truncate text-foreground">
                        {d.label?.split("/").pop() ?? d.label}
                      </span>
                      <span className="text-meta text-muted-foreground shrink-0 whitespace-nowrap">
                        {relativeTime(d.startedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* 数据权限 */}
            <section>
              <p className="text-meta font-medium text-muted-foreground mb-2">数据权限</p>
              <div className="flex flex-wrap gap-1.5">
                {card.dataScope.map((scope) => (
                  <span
                    key={scope}
                    className="text-meta px-2 py-0.5 rounded-full border border-border bg-muted/50"
                  >
                    {scope}
                  </span>
                ))}
              </div>
            </section>

            {/* 会做的活 */}
            {card.skills.length > 0 && (
              <section>
                <p className="text-meta font-medium text-muted-foreground mb-2">会做的活</p>
                <div className="flex flex-wrap gap-1.5">
                  {card.skills.map((skill) => (
                    <span
                      key={skill.name}
                      title={skill.description}
                      className="text-meta px-2 py-0.5 rounded-full border border-border bg-muted/50 cursor-help"
                    >
                      {skill.name}
                    </span>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
  );
}
