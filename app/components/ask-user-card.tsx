"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { SuccessIcon, HelpIcon } from "@/lib/icons";
import { motion } from "motion/react";
import { toast } from "sonner";
import { SPRING_DEFAULT } from "@/app/shared/motion-presets";
import type { AskUserQuestionPayload } from "@/app/chat/chat-types";
import { cn } from "@/lib/utils";

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
        toast.error("确认提交失败，请重试");
      }
    } catch {
      toast.error("确认提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <motion.div
      className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-body flex flex-col gap-2"
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={SPRING_DEFAULT}
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

/** 已答 / 超时的 ask_user 在时间线里的紧凑摘要(待答的大卡片已移到输入框上方的浮层)。
 *  设计:无 ✓ 勾;「问题 → [所选]」,所选用浅灰 chip 强调;剥掉选项尾部的 (Recommended) 噪声。 */
export function AskAnsweredSummary({ header, answer }: { header?: string; answer?: string }) {
  const answered = answer != null && answer.trim() !== "";
  const clean = answered ? answer!.replace(/\s*[（(]\s*Recommended\s*[）)]\s*$/i, "").trim() : "";
  return (
    <div className="flex items-center gap-2 py-0.5 text-meta min-w-0">
      {header ? <span className="shrink-0 text-muted-foreground">{header}</span> : null}
      {answered ? (
        <>
          <HugeiconsIcon icon={ArrowRight01Icon} size={12} className="shrink-0 text-muted-foreground/40" aria-hidden="true" />
          <span className="min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-medium text-foreground">{clean}</span>
        </>
      ) : (
        <span className="shrink-0 text-muted-foreground/60">· 未确认</span>
      )}
    </div>
  );
}
