"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { pickTipIndex } from "@/app/chat/tip-picker";
import { ThinkingSpark } from "@/app/shared/thinking-spark";

// 新会话空状态的轮换小技巧池:每条都对应真实功能(红线 4:不画饼,查不到的不写)。
// key 字符(/ @)走内联柔和 mono、无边框——去掉旧版「代码编辑器快捷键图例」的工具感。
const KEY_CHAR = "rounded bg-muted px-1 py-0.5 font-mono text-foreground/80";

export const COMPOSER_TIPS: ReactNode[] = [
  <>输入 <span className={KEY_CHAR}>/</span> 引用技能</>,
  <>输入 <span className={KEY_CHAR}>@</span> 引用已有文件</>,
  <>开「深度思考」解决复杂推理问题</>,
  <>拖文件到窗口也能上传</>,
  <>点生成的文件可直接预览</>,
  <>对话里的文件可加入知识库</>,
  <>发我金蝶报表,可做经营分析</>,
  <>报销单据发我,可批量核对</>,
  <>发薪前可让我算工资和个税</>,
  <>月末让我列结账核对清单</>,
  <>可把报销 / 薪资导成金蝶凭证草稿</>,
  <>问我公司能享哪些税收优惠</>,
];

// 模块级游标:同一 SPA 会话内跨「新会话」记住上一条,保证连续两次不重复。
let lastTipIndex = -1;

/**
 * 新会话空状态的一条安静轮换提示:静态星芒图标 + 一句话。
 * 随机挑选放在挂载后(客户端),与 SSR 首屏一致渲染占位以避免注水不一致,再淡入真正选中的那条。
 */
export function ComposerTip() {
  const [index, setIndex] = useState<number | null>(null);

  useEffect(() => {
    const next = pickTipIndex(lastTipIndex, COMPOSER_TIPS.length);
    lastTipIndex = next;
    setIndex(next);
  }, []);

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-caption text-muted-foreground/70 transition-opacity duration-300",
        index === null ? "opacity-0" : "opacity-100"
      )}
      aria-hidden={index === null}
    >
      <ThinkingSpark size={14} animated={false} />
      <span>{COMPOSER_TIPS[index ?? 0]}</span>
    </div>
  );
}
