"use client";

/**
 * message-scroller 采用评估 demo(不进生产路由导航,仅 /dev 下手动访问)。
 * 验证三个问题:
 *  1. 流式追加时自动跟随;用户上滚打断跟随;「回到底部」按钮出现/点击回落
 *  2. 与可展开/折叠内容(模拟过程块 details)共存时,content-visibility 是否引起跳动
 *  3. 大量历史消息(300+)的滚动流畅度(逐条 content-visibility 轻虚拟化)
 */

import { useCallback, useRef, useState } from "react";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";

type DemoMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  hasDetails?: boolean;
};

let nextId = 1;

function makeHistory(count: number): DemoMessage[] {
  const out: DemoMessage[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    out.push({
      id: nextId++,
      role,
      text:
        role === "user"
          ? `历史提问 #${i + 1}:这批单据的科目映射规则是什么?`
          : `历史回答 #${i + 1}:按知识库对照表映射,水电费走 6602.08 管理费用_水电费,银行手续费走 6603.04 财务费用_手续费。命中不了的进待确认清单,人工复核后回填。`,
      hasDetails: role === "assistant" && i % 5 === 4,
    });
  }
  return out;
}

const STREAM_CHUNKS = [
  "先扫一遍文件夹里的单据。",
  "识别到 3 份文件:浦发.pdf、水电费回单.pdf、付款申请单.jpg。",
  "科目对上了,水电费走 6602.08,",
  "手续费走 6603.04,结息方向为收款(借银行存款/贷利息收入)。",
  "开始生成对照手填清单,共 9 笔业务、18 行分录。",
  "生成完毕:金蝶对照手填清单.xlsx(3 sheets · 9 笔凭证),借贷合计已校平。",
];

export default function MessageScrollerDemo() {
  const [messages, setMessages] = useState<DemoMessage[]>(() => makeHistory(12));
  const [streaming, setStreaming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopStream = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setStreaming(false);
  }, []);

  const startStream = useCallback(() => {
    stopStream();
    setStreaming(true);
    const id = nextId++;
    setMessages((prev) => [
      ...prev,
      { id: nextId++, role: "user", text: "把这批单据做成金蝶凭证" },
      { id, role: "assistant", text: "" },
    ]);
    let step = 0;
    timerRef.current = setInterval(() => {
      const chunk = STREAM_CHUNKS[step % STREAM_CHUNKS.length];
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, text: `${m.text}${m.text ? "\n" : ""}${chunk}` } : m))
      );
      step++;
      if (step >= 18) stopStream(); // 3 轮 chunk 后收尾
    }, 700);
  }, [stopStream]);

  const addHistory = useCallback(() => {
    setMessages((prev) => [...makeHistory(300), ...prev]);
  }, []);

  return (
    <div className="flex h-dvh flex-col gap-3 p-6">
      <div className="flex items-center gap-2">
        <h1 className="text-display mr-auto">message-scroller 评估台</h1>
        <button type="button" onClick={addHistory} className="rounded-md border border-border px-3 py-1.5 text-small text-muted-foreground hover:text-foreground">
          +300 条历史(性能)
        </button>
        <button type="button" onClick={streaming ? stopStream : startStream} className="rounded-md border border-border px-3 py-1.5 text-small text-muted-foreground hover:text-foreground">
          {streaming ? "停止流式" : "模拟流式回答"}
        </button>
      </div>

      <div className="min-h-0 flex-1 rounded-xl border border-border">
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport className="px-6 py-4">
              <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-4">
                {messages.map((m) => (
                  <MessageScrollerItem key={m.id} data-testid={`msg-${m.id}`}>
                    {m.role === "user" ? (
                      <div className="ml-auto w-fit max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-body">
                        {m.text}
                      </div>
                    ) : (
                      <div className="text-body whitespace-pre-wrap">
                        {m.text || <span className="text-muted-foreground">…</span>}
                        {m.hasDetails && (
                          /* 模拟过程块:验证 content-visibility 与 details 展开收起共存不跳动 */
                          <details className="mt-2">
                            <summary className="cursor-pointer text-body text-muted-foreground">
                              已处理 6 步 · 用时 32s
                            </summary>
                            <div className="mt-1 flex flex-col gap-1 text-body text-muted-foreground">
                              <div>识别单据 ×3:浦发.pdf、水电费回单…</div>
                              <div>检索知识库 ×2:金蝶科目对照表…</div>
                              <div>匹配科目 ×8:水电费、手续费…</div>
                              <div>生成清单:金蝶对照手填清单.xlsx</div>
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton aria-label="滚动到最新消息" />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
    </div>
  );
}
