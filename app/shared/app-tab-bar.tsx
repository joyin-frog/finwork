"use client";

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  DashboardSquare02Icon,
  BubbleChatIcon,
  LibraryIcon,
  Folder02Icon,
  UserGroupIcon,
  NoteIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { DragHandle } from "@/app/shared/window-controls";
import { NavTopControls } from "@/app/shared/nav-top-controls";

type TabActive =
  | "cockpit"
  | "chat"
  | "knowledge"
  | "config"
  | "files"
  | "agents"
  | "skills";

const LABEL: Record<TabActive, string> = {
  cockpit: "总览",
  chat: "对话",
  knowledge: "知识库",
  files: "文件",
  agents: "智能体",
  skills: "技能",
  config: "设置",
};

const ICON: Record<TabActive, IconSvgElement> = {
  cockpit: DashboardSquare02Icon,
  chat: BubbleChatIcon,
  knowledge: LibraryIcon,
  files: Folder02Icon,
  agents: UserGroupIcon,
  skills: NoteIcon,
  config: Settings02Icon,
};

export function AppTabBar({ active }: { active: TabActive }) {
  return (
    <div className="app-tabbar hidden relative shrink-0 items-center gap-2">
      <DragHandle />
      <div className="app-tabbar-lead flex items-center gap-1 shrink-0">
        <NavTopControls />
      </div>
      {/* 纯展示元素:页名已由 AppNav 提供给读屏器,这里隐藏避免重复朗读 */}
      <div aria-hidden="true" className="app-tab flex items-center gap-1.5 px-3 h-7 text-small">
        <HugeiconsIcon icon={ICON[active]} className="size-3.5" />
        <span>{LABEL[active]}</span>
      </div>
    </div>
  );
}
