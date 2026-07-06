"use client";

import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * ResizablePreviewPanel — 共享的可拖宽预览面板外层装配壳。
 *
 * 纯表现型：不持有任何选择/内容状态，不 import 任何具体内容组件。
 * 消费方仍自持 usePreviewResize() 状态并将其传入。
 *
 * 布局：
 *   flex flex-1 overflow-hidden (ref=mainRef)
 *     左列 (flex-1, listMinWidthClass, maximized→hidden)  ← list 插槽
 *     分隔条 (w-1 cursor-col-resize)                      ← 只在 !collapsed && preview 时渲染
 *     右面板 (shrink-0, 宽=previewW / maximized→flex-1)   ← preview 插槽
 */

type ResizablePreviewPanelProps = {
  /** ref 绑定到外层 flex 容器，usePreviewResize 需要它计算容器宽 */
  mainRef: RefObject<HTMLDivElement | null>;
  /** 右侧预览面板当前宽度（px），来自 usePreviewResize */
  previewW: number;
  /** 放大模式：左列 hidden，右面板 flex-1 */
  maximized: boolean;
  /** 折叠状态：分隔条和右面板均不渲染 */
  collapsed: boolean;
  /** 拖拽中状态：分隔条高亮 */
  dragging: boolean;
  /** 分隔条 mousedown 开始拖拽 */
  onBeginResize: (e: React.MouseEvent) => void;
  /** 双击分隔条还原默认宽 */
  onResetWidth?: () => void;
  /**
   * 左列最小宽 Tailwind class，各页不同：
   * - files/knowledge: "min-w-[280px]"（默认）
   * - agents: "min-w-[420px]"
   */
  listMinWidthClass?: string;
  /**
   * 右面板外框样式 class，各页不同：
   * - files/knowledge: "preview-card-frame"（默认，浮起卡片：4px 边距+圆角+阴影，见 app/styles/preview.css）
   * - agents: "bg-card border-l border-border overflow-hidden"（贴边抽屉，无浮起卡片）
   * 别在壳里写死——两处外观本就不同。
   */
  previewFrameClassName?: string;
  /** 左列内容（列表、网格等） */
  list: ReactNode;
  /**
   * 右侧预览内容。
   * 传 null/undefined 时不渲染分隔条和右面板（等同于 collapsed）。
   */
  preview: ReactNode;
};

export function ResizablePreviewPanel({
  mainRef,
  previewW,
  maximized,
  collapsed,
  dragging,
  onBeginResize,
  onResetWidth,
  listMinWidthClass = "min-w-[280px]",
  previewFrameClassName = "preview-card-frame",
  list,
  preview,
}: ResizablePreviewPanelProps) {
  const showRight = !collapsed && preview != null;

  return (
    <div className="flex flex-1 overflow-hidden" ref={mainRef}>
      {/* 左列 —— 放大时整列隐藏:预览宽=容器宽-4 已假定兄弟列消失(对齐 chat 隐藏主内容区),
          否则 min-w 列不收缩会把预览撑出容器、右侧「还原」按钮被 overflow-hidden 裁掉(看不见取消全屏) */}
      <div className={cn("flex flex-col flex-1 overflow-hidden", listMinWidthClass, maximized && "hidden")}>
        {list}
      </div>

      {/* 分隔拖拽条 */}
      {showRight && (
        <div
          className={cn(
            "w-1 shrink-0 cursor-col-resize bg-clip-content px-[1.5px] hover:bg-primary/30 transition-colors",
            dragging && "bg-primary/30"
          )}
          onMouseDown={onBeginResize}
          onDoubleClick={onResetWidth}
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
        />
      )}

      {/* 右侧预览面板 */}
      {showRight && (
        <div
          className={cn("flex flex-col shrink-0", previewFrameClassName, maximized && "is-maximized")}
          style={{ width: previewW }}
        >
          {preview}
        </div>
      )}
    </div>
  );
}
