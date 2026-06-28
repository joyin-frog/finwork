"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * 「文件库」区的两个 tab:对话文件(/files,上传/生成/已保留)与 知识库(/knowledge,可检索)。
 * 用页面标题一样的文字样式呈现「对话文件 ｜ 知识库」,当前页加重——不要分段控件/边框。
 */
export function ResourceTabs({ active }: { active: "files" | "knowledge" }) {
  const cls = (on: boolean) =>
    cn(
      "text-title transition-colors whitespace-nowrap",
      on ? "text-foreground" : "text-muted-foreground hover:text-foreground"
    );
  return (
    <div className="flex items-center gap-2 shrink-0">
      <Link href="/files" className={cls(active === "files")}>
        对话文件
      </Link>
      <span className="text-title font-normal text-muted-foreground/40 select-none">｜</span>
      <Link href="/knowledge" className={cls(active === "knowledge")}>
        知识库
      </Link>
    </div>
  );
}
