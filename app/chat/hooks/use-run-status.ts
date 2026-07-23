"use client";

import { useCallback, useEffect, useState } from "react";
import type { QualityStatus, RunStatus, TerminationReason } from "@/lib/agent/run-contract";
import type { AttachmentQualityState, DeliverableRecord } from "@/lib/deliverable/types";
import { attachmentStateFromStatus } from "@/lib/deliverable/types";

export type RunSnapshot = {
  runId: string;
  status: RunStatus;
  qualityStatus: QualityStatus;
  terminationReason: TerminationReason | null;
  lastEventId: number | null;
  latestCheckpoint: { lastCompletedStage?: string } | null;
};

export type DeliverableWithQuality = DeliverableRecord & {
  qualityState: AttachmentQualityState;
};

/**
 * CR-R2：从持久 Run / deliverables API 拉取权威状态（流式结束后或重进对话时）。
 */
export function useRunStatus(runId: string | null | undefined) {
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [deliverables, setDeliverables] = useState<DeliverableWithQuality[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!runId) {
      setRun(null);
      setDeliverables([]);
      return;
    }
    setLoading(true);
    try {
      const [runRes, delRes] = await Promise.all([
        fetch(`/api/agent/runs/${encodeURIComponent(runId)}`),
        fetch(`/api/agent/runs/${encodeURIComponent(runId)}/deliverables`),
      ]);
      const runJson = (await runRes.json().catch(() => null)) as {
        ok?: boolean;
        data?: { run?: Record<string, unknown> };
      } | null;
      const delJson = (await delRes.json().catch(() => null)) as {
        ok?: boolean;
        data?: { deliverables?: DeliverableWithQuality[] };
      } | null;

      if (runJson?.ok && runJson.data?.run) {
        const r = runJson.data.run;
        setRun({
          runId: String(r.runId ?? runId),
          status: r.status as RunStatus,
          qualityStatus: (r.qualityStatus as QualityStatus) ?? "not_applicable",
          terminationReason: (r.terminationReason as TerminationReason | null) ?? null,
          lastEventId: typeof r.lastEventId === "number" ? r.lastEventId : null,
          latestCheckpoint: (r.latestCheckpoint as RunSnapshot["latestCheckpoint"]) ?? null,
        });
      } else {
        setRun(null);
      }

      if (delJson?.ok && Array.isArray(delJson.data?.deliverables)) {
        setDeliverables(
          delJson.data!.deliverables.map((d) => ({
            ...d,
            qualityState: d.qualityState ?? attachmentStateFromStatus(d.status),
          })),
        );
      } else {
        setDeliverables([]);
      }
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 按文件名或路径匹配质量态；无匹配 → null（不假装已验证） */
  function qualityForFile(fileName: string, storagePath?: string | null): AttachmentQualityState | null {
    const hit = deliverables.find((d) => {
      if (d.fileName === fileName) return true;
      if (storagePath && (d.deliveredPath === storagePath || d.workingPath === storagePath)) return true;
      if (storagePath && (d.deliveredPath?.endsWith(fileName) || d.workingPath?.endsWith(fileName))) return true;
      return false;
    });
    return hit?.qualityState ?? null;
  }

  return { run, deliverables, loading, refresh, qualityForFile };
}

export async function stopAgentRun(runId: string): Promise<{ ok: boolean; status?: string }> {
  const res = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    data?: { status?: string };
  } | null;
  return { ok: Boolean(json?.ok), status: json?.data?.status };
}
