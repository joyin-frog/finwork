"use client";

/**
 * ResourceCard – 资料区统一卡片(全部文件 + 知识库共用)。
 *
 * 规格(spec-resource-parity.md § B):
 * - 点卡片 = 预览
 * - hover 底部露 2 个常用图标:对话 + 下载
 * - 右上角 ⋮ 下拉菜单放其余操作
 * - 唯一差异:meta 节点 / ⋮ 菜单项由调用方注入
 */

import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BubbleChatAddIcon, Download01Icon, More01Icon } from "@hugeicons/core-free-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileTypeIcon } from "@/app/shared/file-type-icon";
import { cn } from "@/lib/utils";

export type ResourceCardMenuItem = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** 在此项上方插入分割线 */
  separator?: boolean;
};

export type ResourceCardProps = {
  /** 文件名(用于 FileTypeIcon + title 属性) */
  name: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 是否选中(高亮预览) */
  selected: boolean;
  /** 卡片整圈边框/背景 class(不选中时) */
  colorCls?: string;
  /** meta 区:保留书签/检索信息等差异节点 */
  meta?: ReactNode;
  /** 对话按钮点击:知识库=addToChat / 全部文件=跳转来源对话 */
  onChat?: () => void;
  /** 下载按钮点击 */
  onDownload?: () => void;
  /** 点卡片=预览 */
  onClick: () => void;
  /** ⋮ 菜单项 */
  menuItems?: ResourceCardMenuItem[];
  /** hover/disabled 遮罩:操作中显示 spinner */
  busy?: boolean;
  /** 卡片是否已归档(半透明) */
  archived?: boolean;
};

export function ResourceCard({
  name,
  mimeType,
  selected,
  colorCls,
  meta,
  onChat,
  onDownload,
  onClick,
  menuItems = [],
  busy = false,
  archived = false,
}: ResourceCardProps) {
  const hasMenu = menuItems.length > 0;

  return (
    <article
      className={cn(
        "group relative flex flex-col gap-2 rounded-lg border p-3 transition-colors cursor-pointer",
        selected
          ? "border-primary bg-accent ring-1 ring-primary/40"
          : colorCls ?? "border-border hover:border-primary/40 hover:bg-accent/40",
        archived && "opacity-60",
      )}
      onClick={onClick}
    >
      {/* ⋮ 菜单 – 右上角 */}
      {hasMenu && (
        <div
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="更多操作"
                disabled={busy}
              >
                <HugeiconsIcon icon={More01Icon} size={14} />
              </button>
            </DropdownMenuTrigger>
            {/* 图标行:无文字,hover/title 出说明 */}
            <DropdownMenuContent align="end" className="flex flex-col gap-0.5 p-1 w-auto min-w-0">
              {menuItems.map((item, i) => (
                <DropdownMenuItem
                  key={i}
                  variant={item.destructive ? "destructive" : "default"}
                  disabled={item.disabled || busy}
                  onClick={(e) => { e.stopPropagation(); item.onClick(); }}
                  title={item.label}
                  className="p-1.5 justify-center cursor-pointer"
                >
                  {item.icon}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* 图标 + 名称 */}
      <div className="flex items-start gap-2 pr-4">
        <div className="size-9 shrink-0 flex items-center justify-center">
          <FileTypeIcon name={name} mimeType={mimeType} width={26} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-body font-medium line-clamp-2" title={name}>
            {name}
          </div>
        </div>
      </div>

      {/* Meta 区(差异:保留书签 vs 检索信息) */}
      {meta && (
        <div className="flex items-center gap-2 text-meta text-muted-foreground flex-wrap">
          {meta}
        </div>
      )}

      {/* hover 常用图标:对话(最左)+ 下载(最右) */}
      <div
        className="flex items-center justify-between pt-1 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {onChat ? (
          <button
            type="button"
            title="添加到对话"
            disabled={busy}
            onClick={onChat}
            className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-accent transition-colors"
          >
            <HugeiconsIcon icon={BubbleChatAddIcon} size={14} />
          </button>
        ) : <span />}
        {onDownload ? (
          <button
            type="button"
            title="下载/另存为"
            disabled={busy}
            onClick={onDownload}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <HugeiconsIcon icon={Download01Icon} size={14} />
          </button>
        ) : <span />}
      </div>
    </article>
  );
}
