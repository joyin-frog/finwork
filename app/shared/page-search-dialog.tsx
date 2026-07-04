"use client";

import { useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";

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
        onOpenChange(true);
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
        className="flex h-9 w-full max-w-[280px] items-center gap-2 rounded-lg border border-input bg-background px-3 shadow-xs"
        onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}
      >
        <HugeiconsIcon icon={Search01Icon} size={16} className="shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
          className="min-w-0 flex-1 border-0 bg-transparent text-body outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label="关闭搜索"
          onClick={() => onOpenChange(false)}
          className="inline-grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} />
        </button>
      </form>
    </div>
  );
}
