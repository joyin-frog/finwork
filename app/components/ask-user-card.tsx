"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { SuccessIcon, HelpIcon } from "@/lib/icons";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { EASE_OUT_QUICK, SPRING_DEFAULT } from "@/app/shared/motion-presets";
import type { AskUserQuestionPayload } from "@/app/chat/chat-types";
import { cn } from "@/lib/utils";
import { surfaceVariants } from "@/components/ui/surface";

const FALLBACK_OPTIONS: Array<{ label: string; description?: string }> = [{ label: "确认" }, { label: "取消" }];

/**
 * 对话流内的人机确认卡片:agent 提问/高风险操作确认在此应答,
 * 答案经 POST /api/agent/answer 以机制信号回到 hook 链(而非自由文本)。
 */
export function AskUserCard({
  questionId,
  question,
  answer,
  active
}: {
  questionId: string;
  question: AskUserQuestionPayload;
  /** 已落库/已流回的答案;空串表示超时未确认 */
  answer?: string;
  /** 该轮 agent 是否仍在运行(否则按历史卡片只读展示) */
  active: boolean;
}) {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const reduce = useReducedMotion();
  const finalAnswer = answer !== undefined ? answer : submitted;
  const answered = finalAnswer !== null && finalAnswer !== undefined;
  const expired = !active && !answered;
  const options = question.options?.length ? question.options : FALLBACK_OPTIONS;

  async function submit(label: string) {
    if (answered || expired || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/agent/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId, answer: label })
      });
      if (res.ok) {
        setSubmitted(label);
      } else {
        toast.error("确认没有提交成功。检查网络后再点一次");
      }
    } catch {
      toast.error("确认没有提交成功。检查网络后再点一次");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <motion.div
      className={cn(surfaceVariants({ level: "card", edge: "none", shape: "card" }), "border border-primary/30 bg-primary/5 px-3 py-2.5 text-body flex flex-col gap-2")}
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(6px) scale(0.98)" }}
      animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
      transition={reduce ? EASE_OUT_QUICK : SPRING_DEFAULT}
    >
      <div className="flex items-start gap-2">
        <HugeiconsIcon icon={HelpIcon} size={15} className="text-primary shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex flex-col gap-0.5 min-w-0">
          {question.header ? <span className="text-meta text-muted-foreground">{question.header}</span> : null}
          <span className="whitespace-pre-line">{question.question}</span>
        </div>
      </div>
      {answered ? (
        <div className="flex items-center gap-2 text-meta text-muted-foreground pl-6">
          <HugeiconsIcon icon={SuccessIcon} size={13} aria-hidden="true" />
          <span>{finalAnswer?.trim() ? `已选择:${finalAnswer}` : "未确认(已超时或取消)"}</span>
        </div>
      ) : expired ? (
        <div className="text-meta text-muted-foreground pl-6">未确认(会话已结束)</div>
      ) : (
        <div className="flex flex-wrap gap-2 pl-6">
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={submitting}
              title={option.description}
              // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
              className={cn(
                "px-3 py-1 rounded-full border border-border bg-card text-meta",
                "hover:bg-accent transition-colors cursor-pointer disabled:opacity-50"
              )}
              onClick={() => void submit(option.label)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}

/** 剥掉选项尾部的 (推荐)/(Recommended) 噪声。 */
function stripRecommended(s: string): string {
  return s.replace(/\s*[（(]\s*(?:Recommended|推荐)\s*[）)]\s*$/i, "").trim();
}

/** 多问一次确认时,答案是 JSON 对象 {问:答};解析成 [问,答][],解析失败或非对象返回 null。 */
function parseMultiAnswer(answer: string): Array<[string, string]> | null {
  const t = answer.trim();
  if (!t.startsWith("{")) return null;
  try {
    const obj = JSON.parse(t) as Record<string, unknown>;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const entries = Object.entries(obj).filter(([, v]) => typeof v === "string") as Array<[string, string]>;
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

/** 单条 问→答 chip 行(多问展开与单问共用同一视觉)。 */
function AnswerPair({ question, answer }: { question?: string; answer: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      {question ? <span className="shrink-0 text-muted-foreground">{question}</span> : null}
      <HugeiconsIcon icon={ArrowRight01Icon} size={12} className="shrink-0 text-muted-foreground/40" aria-hidden="true" />
      {/* eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则 */}
      <span className="min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-medium text-foreground">{stripRecommended(answer)}</span>
    </div>
  );
}

/** 已答 / 超时的 ask_user 在时间线里的紧凑摘要(待答的大卡片已移到输入框上方的浮层)。
 *  单问:「[header] → [所选]」一行。多问(答案为 JSON 对象):默认折叠「已确认 N 项」,展开逐条 问→答。 */
export function AskAnsweredSummary({ header, answer }: { header?: string; answer?: string }) {
  const answered = answer != null && answer.trim() !== "";
  if (!answered) {
    return (
      <div className="flex items-center gap-2 py-0.5 text-meta min-w-0">
        {header ? <span className="shrink-0 text-muted-foreground">{header}</span> : null}
        <span className="shrink-0 text-muted-foreground/60">· 未确认</span>
      </div>
    );
  }

  const multi = parseMultiAnswer(answer!);
  // 多问:折叠成一行「用户已确认 N 个问题」,点开在框内逐条 问→答 —— 不再把 JSON 平铺成一坨。
  if (multi && multi.length > 1) {
    return (
      <details className="details-fold text-body min-w-0">
        {/* 与工具步骤组的折叠头同款:无前导图标 + group flex + py-1 + gap-2,chevron 默认隐藏 hover 显现 */}
        <summary className="group flex w-full items-center gap-2 py-1 text-body text-left cursor-pointer list-none text-muted-foreground hover:text-foreground transition-colors">
          <span className="min-w-0 truncate">用户已确认 {multi.length} 个问题</span>
          <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="details-chevron details-chevron-closed shrink-0 text-muted-foreground/70 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity" aria-hidden="true" />
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="details-chevron details-chevron-open shrink-0 text-muted-foreground/70 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity" aria-hidden="true" />
        </summary>
        <div className="mt-1.5 flex flex-col gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          {multi.map(([q, a], i) => (
            <div key={i} className="flex flex-col gap-1 min-w-0">
              <p className="text-body font-normal leading-relaxed text-muted-foreground">
                <span className="text-muted-foreground/60">问：</span>{q}
              </p>
              <p className="text-body font-medium leading-relaxed text-foreground">
                <span className="font-normal text-muted-foreground/60">答：</span>{stripRecommended(a)}
              </p>
            </div>
          ))}
        </div>
      </details>
    );
  }

  // 单问:原样一行 chip。
  return (
    <div className="py-0.5 text-body min-w-0">
      <AnswerPair question={header} answer={answer!} />
    </div>
  );
}
