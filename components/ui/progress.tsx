"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

export function clampProgressValue(value: number | null | undefined) {
  if (value == null) return value
  return Math.min(100, Math.max(0, value))
}

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const clampedValue = clampProgressValue(value)
  const visualValue = clampedValue ?? 0
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-md bg-muted",
        className
      )}
      value={clampedValue}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full origin-left flex-1 bg-primary transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        style={{ transform: `scaleX(${visualValue / 100})` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
