"use client";

import { useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PageSearchBar({ open, onOpenChange, value, onValueChange, placeholder, label, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  label: string;
  onSubmit?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (open) inputRef.current?.focus();
        else onOpenChange(true);
      } else if (event.key === "Escape" && open) {
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="flex shrink-0 justify-end border-b border-border px-3.5 py-2">
      <form
        role="search"
        // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
        className="flex h-9 w-full max-w-[280px] items-center gap-2 rounded-lg border border-input bg-background px-3 shadow-xs"
        onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}
      >
        <HugeiconsIcon icon={Search01Icon} size={16} className="shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
          className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-body shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="关闭搜索"
          onClick={() => onOpenChange(false)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} />
        </Button>
      </form>
    </div>
  );
}
