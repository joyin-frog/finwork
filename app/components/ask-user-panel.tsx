"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon, HelpCircleIcon } from "@hugeicons/core-free-icons";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AskUserQuestionPayload } from "@/app/chat/chat-types";

/**
 * 待答的 ask_user 提问面板:覆盖输入框(待答时用户在此应答,不走主输入框)。
 * 单选/多选编号选项(Command 键盘导航)+ 自由输入;忽略(ESC,提交空)/ 继续(提交所选或自由文本)。
 * 答案经 POST /api/agent/answer 以任意字符串回到 hook 链(端点已收任意串)。
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
  const multi = Boolean(question.multiSelect);
  const options = question.options ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

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
    setSelected((s) => (multi ? (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]) : [label]));
  }
  function proceed() {
    const ans = custom.trim() || selected.join(multi ? "、" : "");
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
      {/* 顶部:走光「正在询问」+ header */}
      <div className="flex items-center gap-2 text-meta">
        <span className="fa-shimmer-text">正在询问{question.header ? ` · ${question.header}` : ""}</span>
      </div>

      {/* 问题 */}
      <div className="text-title whitespace-pre-line">{question.question}</div>

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
                      {on && multi ? "✓" : i + 1}
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

      {/* 忽略 / 继续 */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={ignore} disabled={submitting} className="text-muted-foreground">
          忽略 <Kbd>ESC</Kbd>
        </Button>
        {/* 单题=最后一题→「提交」(多题翻页是后续);⏎ 用按钮同色轻字,不套白底 Kbd 以免突兀 */}
        <Button size="sm" onClick={proceed} disabled={submitting}>
          提交 <span className="ml-0.5 opacity-60">⏎</span>
        </Button>
      </div>
    </div>
  );
}
