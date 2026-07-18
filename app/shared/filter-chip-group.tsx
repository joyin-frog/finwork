"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type FilterChipOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
};

export function FilterChipGroup<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: FilterChipOption<T>[];
  onValueChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "shrink-0 overflow-x-auto px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <ToggleGroup
        type="single"
        value={value}
        variant="filter"
        spacing={1}
        aria-label={ariaLabel}
        onValueChange={(next) => {
          if (next) onValueChange(next as T);
        }}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} className="px-3">
            {option.label}{option.count === undefined ? "" : ` ${option.count}`}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
