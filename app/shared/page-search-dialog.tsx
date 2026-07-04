"use client";

import { useEffect, useRef } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";

export function PageSearchDialog({ open, onOpenChange, value, onValueChange, placeholder, label, onSubmit }: {
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
    function handleFind(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        onOpenChange(true);
      }
    }
    window.addEventListener("keydown", handleFind);
    return () => window.removeEventListener("keydown", handleFind);
  }, [onOpenChange]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim-modal duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
          className="fixed top-[18%] left-1/2 z-50 w-full max-w-[calc(100%-2rem)] sm:max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl border-2 border-border bg-popover text-body text-popover-foreground outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          <form
            className="flex items-center gap-2.5 px-4"
            onSubmit={(event) => { event.preventDefault(); onSubmit?.(); onOpenChange(false); }}
          >
            <HugeiconsIcon icon={Search01Icon} size={18} className="shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              placeholder={placeholder}
              aria-label={label}
              className="h-12 flex-1 border-0 bg-transparent text-body outline-none placeholder:text-muted-foreground"
            />
            {value ? (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => { onValueChange(""); inputRef.current?.focus(); }}
                className="inline-grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={16} />
              </button>
            ) : null}
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="关闭" className="-mr-1.5 shrink-0">
                <HugeiconsIcon icon={Cancel01Icon} size={18} />
              </Button>
            </DialogPrimitive.Close>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
