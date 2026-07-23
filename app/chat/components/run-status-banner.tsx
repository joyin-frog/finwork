"use client";

import { Callout } from "@/app/components/callout";
import type { QualityStatus, RunStatus, TerminationReason } from "@/lib/agent/run-contract";
import {
  qualityStatusLabel,
  runStatusLabel,
  terminationReasonLabel,
} from "@/lib/agent/run-status-labels";

export type RunStatusBannerProps = {
  status: RunStatus;
  qualityStatus?: QualityStatus | null;
  terminationReason?: TerminationReason | null;
  /** 最近步骤摘要（checkpoint / replay）；可空 */
  recentStep?: string | null;
  className?: string;
};

function bannerVariant(
  status: RunStatus,
  quality: QualityStatus | null | undefined,
): "info" | "ok" | "warn" | "neutral" {
  if (status === "completed" && (quality === "passed" || quality === "not_applicable" || !quality)) {
    return "ok";
  }
  if (status === "failed" || status === "canceled") return "warn";
  if (status === "paused" || status === "waiting_user" || status === "waiting_dependency") return "warn";
  if (status === "running" || status === "queued") return "info";
  return "neutral";
}

/**
 * CR-R2：权威 Run 状态横幅。不以旧 done 帧单独宣称文件任务成功。
 */
export function RunStatusBanner({
  status,
  qualityStatus,
  terminationReason,
  recentStep,
  className,
}: RunStatusBannerProps) {
  const title = runStatusLabel(status);
  const reason = terminationReasonLabel(terminationReason);
  const quality = qualityStatusLabel(qualityStatus);
  const parts = [reason, quality, recentStep].filter(Boolean);

  return (
    <Callout variant={bannerVariant(status, qualityStatus)} title={title} className={className}>
      {parts.length ? parts.join(" · ") : null}
    </Callout>
  );
}
