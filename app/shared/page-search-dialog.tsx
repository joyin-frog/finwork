"use client";

import { useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function PageSearchBar({ open, onOpenChange, value, onValueChange, placeholder, label, onSubmit, className, alwaysVisible = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  label: string;
  onSubmit?: () => void;
  /** 覆盖外层左右缩进；设置侧栏应与菜单 nav 同为 px-2，使搜索宽与 hover 齐。 */
  className?: string;
  /** 常驻搜索栏：用于设置侧栏，与下方菜单保持同一行高和宽度。 */
  alwaysVisible?: boolean;
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

  if (!open && !alwaysVisible) return null;

  return (
    <div className={cn("flex h-[46px] shrink-0 items-center border-b border-border px-2", className)}>
      <form
        role="search"
        // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
        className="flex h-[30px] w-full items-center gap-2 rounded-md border border-input bg-background px-2 shadow-xs"
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
        {!alwaysVisible && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="关闭搜索"
            onClick={() => onOpenChange(false)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} />
          </Button>
        )}
      </form>
    </div>
  );
}
