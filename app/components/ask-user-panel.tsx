"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon, HelpCircleIcon, ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AskUserQuestionPayload } from "@/app/chat/chat-types";
import { getSubQuestions, formatSelection, buildAnswer, allAnswered } from "@/app/components/ask-user-multi-state";

/**
 * 待答的 ask_user 提问面板:覆盖输入框(待答时用户在此应答,不走主输入框)。
 * 单题:单/多选编号选项 + 自由输入。多题:一次下发,左右切换逐题作答,末题提交合并为 JSON。
 * 答案经 POST /api/agent/answer 回到 hook 链(单题纯文本;多题 JSON,由 parseMultiAnswers 解析)。
 */
export function AskUserPanel({
  questionId,
  question,
  onResolved,
}: {
  questionId: string;
  question: AskUserQuestionPayload;
  onResolved?: () => void;
}) {
  const subs = useMemo(() => getSubQuestions(question), [question]);
  const multiQ = subs.length > 1;

  const [curIdx, setCurIdx] = useState(0);
  const [selectedPerQ, setSelectedPerQ] = useState<string[][]>(() => subs.map(() => []));
  const [customPerQ, setCustomPerQ] = useState<string[]>(() => subs.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

  const sub = subs[curIdx];
  const options = sub.options ?? [];
  const selected = selectedPerQ[curIdx] ?? [];
  const custom = customPerQ[curIdx] ?? "";
  const answers = subs.map((s, i) => formatSelection(s, selectedPerQ[i] ?? [], customPerQ[i] ?? ""));
  const isLast = curIdx === subs.length - 1;

  async function submit(answer: string) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch("/api/agent/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId, answer }),
      });
      if (!res.ok) throw new Error();
      onResolved?.();
    } catch {
      submittedRef.current = false;
      setSubmitting(false);
      toast.error("提交失败,请重试");
    }
  }

  function toggle(label: string) {
    setSelectedPerQ((all) => {
      const next = all.map((x) => [...x]);
      const cur = next[curIdx];
      next[curIdx] = sub.multiSelect
        ? cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
        : [label];
      return next;
    });
  }

  function setCustom(val: string) {
    setCustomPerQ((all) => {
      const next = [...all];
      next[curIdx] = val;
      return next;
    });
  }

  // 单题:直接提交(答案=纯文本)。多题:非末题→下一题;末题→合并 JSON 提交。
  function proceed() {
    if (multiQ && !isLast) {
      setCurIdx((i) => Math.min(i + 1, subs.length - 1));
      return;
    }
    if (multiQ) {
      if (!allAnswered(answers, subs.length)) {
        toast.error("还有题未作答,请补齐");
        return;
      }
      void submit(buildAnswer(subs, answers));
      return;
    }
    const ans = answers[0];
    if (!ans) {
      toast.error("先选一项或输入内容");
      return;
    }
    void submit(ans);
  }

  function ignore() {
    void submit("");
  }

  // ESC = 忽略(提交空,等同跳过/取消)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        ignore();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-2xl border border-border bg-card px-4 pt-3 pb-3 flex flex-col gap-3">
      {/* 顶部:走光「正在询问」+ header;多题显示进度点 */}
      <div className="flex items-center justify-between gap-2 text-meta">
        <span className="fa-shimmer-text">正在询问{sub.header ? ` · ${sub.header}` : ""}</span>
        {multiQ ? (
          <div className="flex items-center gap-1.5">
            <span className="text-caption text-muted-foreground tabular-nums">{curIdx + 1}/{subs.length}</span>
            <div className="flex items-center gap-1">
              {subs.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "size-1.5 rounded-full",
                    i === curIdx ? "bg-primary" : answers[i] ? "bg-primary/40" : "bg-border",
                  )}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* 问题 */}
      <div className="text-title whitespace-pre-line">{sub.question}</div>

      {/* 编号选项(Command 提供高亮/键盘导航;无 CommandInput→不过滤、全列) */}
      {options.length > 0 && (
        <Command loop shouldFilter={false} className="bg-transparent">
          <CommandList className="max-h-60">
            <CommandGroup className="p-0">
              {options.map((o, i) => {
                const on = selected.includes(o.label);
                return (
                  <CommandItem
                    key={o.label}
                    value={o.label}
                    onSelect={() => toggle(o.label)}
                    className="gap-2 rounded-lg px-2 py-2 cursor-pointer"
                  >
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border text-caption tabular-nums",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
                      )}
                    >
                      {on && sub.multiSelect ? "✓" : i + 1}
                    </span>
                    <span className="flex-1 text-body">{o.label}</span>
                    {o.description ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-muted-foreground/50 hover:text-muted-foreground">
                            <HugeiconsIcon icon={HelpCircleIcon} size={14} />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">{o.description}</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      )}

      {/* 自由输入(输了就以它为答案) */}
      <InputGroup>
        <InputGroupAddon>
          <HugeiconsIcon icon={Edit02Icon} size={14} className="text-muted-foreground" />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="或直接告诉我你的想法…"
          value={custom}
          disabled={submitting}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              proceed();
            }
          }}
        />
      </InputGroup>

      {/* 底部操作:多题=上一题/下一题·末题提交;单题=忽略/提交 */}
      <div className="flex items-center justify-between gap-2">
        {multiQ ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCurIdx((i) => Math.max(i - 1, 0))}
            disabled={submitting || curIdx === 0}
            className="text-muted-foreground"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} size={14} /> 上一题
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={ignore} disabled={submitting} className="text-muted-foreground">
            忽略 <Kbd>ESC</Kbd>
          </Button>
        )}

        {multiQ && !isLast ? (
          <Button size="sm" onClick={proceed} disabled={submitting}>
            下一题 <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
          </Button>
        ) : (
          <Button size="sm" onClick={proceed} disabled={submitting}>
            提交 <span className="ml-0.5 opacity-60">⏎</span>
          </Button>
        )}
      </div>
    </div>
  );
}
