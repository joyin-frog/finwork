"use client";

import type { AttachmentQualityState } from "@/lib/deliverable/types";
import { attachmentQualityLabel } from "@/lib/agent/run-status-labels";
import { cn } from "@/lib/utils";

const TONE: Record<AttachmentQualityState, string> = {
  working_unverified: "bg-[color:var(--tone-unverified)]/15 text-[color:var(--tone-unverified)]",
  validating: "bg-muted text-muted-foreground",
  validation_failed: "bg-[color:var(--tone-alarm)]/15 text-[color:var(--tone-alarm)]",
  delivered: "bg-[color:var(--tone-ok)]/15 text-[color:var(--tone-ok)]",
};

/**
 * CR-R2：附件质量徽标（OpenableFileRow 旁）。
 */
export function AttachmentQualityBadge({
  state,
  className,
}: {
  state: AttachmentQualityState;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-caption font-medium",
        TONE[state],
        className,
      )}
      title={attachmentQualityLabel(state)}
    >
      {attachmentQualityLabel(state)}
    </span>
  );
}
