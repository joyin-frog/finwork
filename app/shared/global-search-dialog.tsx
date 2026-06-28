"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Command as CommandPrimitive } from "cmdk";
import { HugeiconsIcon } from "@hugeicons/react";
import { File01Icon, MessageMultiple01Icon, Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem } from "@/components/ui/command";

type FileSearchHit = { kind: "library" | "knowledge"; id: string; title: string; mimeType: string };
type ConversationSearchHit = { id: number; title: string; snippet: string; matchedInContent: boolean };
type SearchData = { files: FileSearchHit[]; conversations: ConversationSearchHit[] };

export function GlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [data, setData] = useState<SearchData>({ files: [], conversations: [] });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 空查询也请求:服务端返回最近对话(打开即见)
  const fetchResults = useCallback((query: string) => {
    fetch("/api/search?q=" + encodeURIComponent(query))
      .then((r) => r.json())
      .then((json: { ok: boolean; data?: SearchData }) => {
        if (json.ok && json.data) setData(json.data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchResults(q), 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q, open, fetchResults]);

  // 关闭时清空查询与结果
  useEffect(() => {
    if (!open) { setQ(""); setData({ files: [], conversations: [] }); }
  }, [open]);

  const searching = q.trim().length > 0;
  const hasResults = data.files.length > 0 || data.conversations.length > 0;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* 浅色、无模糊的遮罩(不要黑底 / 不要 backdrop-blur) */}
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 bg-foreground/8 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className="fixed top-[18%] left-1/2 z-50 w-full max-w-[calc(100%-2rem)] sm:max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl border-2 border-border bg-popover text-body text-popover-foreground outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <DialogPrimitive.Title className="sr-only">搜索</DialogPrimitive.Title>
          <Command shouldFilter={false} className="rounded-none bg-transparent p-0 text-body">
            {/* 输入行:无边框、无背景,下方一条横线分隔结果区 */}
            <div className="flex items-center gap-2.5 border-b border-border px-4">
              <HugeiconsIcon icon={Search01Icon} size={18} className="shrink-0 text-muted-foreground" />
              <CommandPrimitive.Input
                data-slot="command-input"
                value={q}
                onValueChange={setQ}
                placeholder="搜索文件与对话…"
                className="h-12 flex-1 border-0 bg-transparent text-body outline-none placeholder:text-muted-foreground"
              />
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" aria-label="关闭" className="-mr-1.5 shrink-0">
                  <HugeiconsIcon icon={Cancel01Icon} size={18} />
                </Button>
              </DialogPrimitive.Close>
            </div>

            {/* 结果区:过多时右侧出现原生滚动条 */}
            <CommandPrimitive.List
              data-slot="command-list"
              className="max-h-[50vh] overflow-x-hidden overflow-y-auto scroll-py-1 p-1"
            >
              {searching && !hasResults && (
                <div className="py-6 text-center text-small text-muted-foreground">无匹配</div>
              )}
              {!searching && data.conversations.length === 0 && (
                <div className="py-6 text-center text-small text-muted-foreground">暂无最近对话</div>
              )}

              {data.files.length > 0 && (
                <CommandGroup heading="文件">
                  {data.files.map((f) => (
                    <CommandItem
                      key={`file-${f.kind}-${f.id}`}
                      value={`file-${f.kind}-${f.id}-${f.title}`}
                      className="text-body"
                      onSelect={() => {
                        if (f.kind === "knowledge") {
                          router.push("/knowledge?doc=" + encodeURIComponent(f.id));
                        } else {
                          router.push("/files?file=" + encodeURIComponent(f.id));
                        }
                        onOpenChange(false);
                      }}
                    >
                      <HugeiconsIcon icon={File01Icon} size={16} className="shrink-0 text-muted-foreground" />
                      <span className="truncate">{f.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {data.conversations.length > 0 && (
                <CommandGroup heading={searching ? "对话" : "最近对话"}>
                  {data.conversations.map((c) => (
                    <CommandItem
                      key={`conv-${c.id}`}
                      value={`conv-${c.id}-${c.title}`}
                      className="text-body"
                      onSelect={() => {
                        if (c.matchedInContent) {
                          router.push(
                            "/chat/recent?id=" + c.id + "&find=" + encodeURIComponent(q)
                          );
                        } else {
                          router.push("/chat/recent?id=" + c.id);
                        }
                        onOpenChange(false);
                      }}
                    >
                      <HugeiconsIcon icon={MessageMultiple01Icon} size={16} className="shrink-0 text-muted-foreground" />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{c.title}</span>
                        {c.snippet && (
                          <span className="truncate text-small text-muted-foreground">
                            {c.snippet}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandPrimitive.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
