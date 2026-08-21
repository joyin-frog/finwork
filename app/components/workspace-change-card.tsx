"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";

type CellSnapshot = { formula?: string | null; value?: unknown };
type CellChange = { address: string; before?: CellSnapshot; after?: CellSnapshot };
type PlanItem = { description: string; address?: string; reason?: string };

export type WorkspaceChangeCardData = {
  changesetId: string;
  candidateVersionId: string;
  candidateName: string;
  iteration: number;
  complete?: boolean;
  readyForUser: boolean;
  diff: {
    kind: "xlsx" | "text" | "binary";
    summary: string;
    details: Record<string, unknown>;
  };
  plan: { complete: boolean; completed: PlanItem[]; pending: PlanItem[] };
  script?: { name: string; versionId: string; diff: { summary: string; details?: Record<string, unknown> } } | null;
};

export function parseWorkspaceChangeReview(value: unknown): WorkspaceChangeCardData | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.kind !== "workspace_change_review" || typeof row.changesetId !== "string" || typeof row.candidateVersionId !== "string") return null;
  const diff = row.diff as WorkspaceChangeCardData["diff"] | undefined;
  const plan = row.plan as WorkspaceChangeCardData["plan"] | undefined;
  if (!diff || typeof diff.summary !== "string" || !plan || !Array.isArray(plan.completed) || !Array.isArray(plan.pending)) return null;
  return {
    changesetId: row.changesetId,
    candidateVersionId: row.candidateVersionId,
    candidateName: typeof row.candidateName === "string" ? row.candidateName : "候选文件",
    iteration: typeof row.iteration === "number" ? row.iteration : 1,
    complete: row.complete === true,
    readyForUser: row.readyForUser === true,
    diff,
    plan,
    script: row.script && typeof row.script === "object" ? row.script as WorkspaceChangeCardData["script"] : null,
  };
}

export function WorkspaceChangeCard({ data }: { data: WorkspaceChangeCardData }) {
  const [status, setStatus] = useState<"pending" | "working" | "complete" | "applied" | "rejected">(
    data.complete ? "complete" : data.readyForUser ? "pending" : "working",
  );
  const [submitting, setSubmitting] = useState(false);
  const cells = cellChanges(data.diff.details).slice(0, 50);

  useEffect(() => {
    if (!data.readyForUser) return;
    let active = true;
    void fetch(`/api/workspace/changesets/${encodeURIComponent(data.changesetId)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { data?: { status?: string } } | null) => {
        if (!active) return;
        if (payload?.data?.status === "applied") setStatus("applied");
        else if (payload?.data?.status === "rejected") setStatus("rejected");
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [data.changesetId, data.readyForUser]);

  async function decide(decision: "approved" | "rejected") {
    setSubmitting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const token = await invoke<string>("workspace_auth_token");
      const response = await fetch(`/api/workspace/changesets/${encodeURIComponent(data.changesetId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-finwork-workspace-auth": token },
        body: JSON.stringify({ decision }),
      });
      const payload = await response.json() as { data?: { status?: string }; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "复核操作失败");
      setStatus(decision === "approved" ? "applied" : "rejected");
      toast.success(decision === "approved" ? "已批准文件变更" : "已拒绝文件变更");
    } catch (error) {
      toast.error("复核操作失败", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Surface level="card" edge="hairline" shape="card" className="overflow-hidden text-body">
      <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="font-medium truncate">{data.candidateName}</div>
          <div className="text-meta text-muted-foreground">第 {data.iteration} 轮 · {data.diff.summary}</div>
        </div>
        <StatusLabel status={status} />
      </div>

      <div className="space-y-3 px-3 py-2.5">
        <div className="text-small">
          已完成 {data.plan.completed.length} 项
          {data.plan.pending.length ? `，还有 ${data.plan.pending.length} 项未完成` : "，没有未完成目标"}
        </div>

        {data.plan.completed.length > 0 ? (
          <div className="space-y-1 text-small">
            <div className="text-meta text-muted-foreground">已完成目标</div>
            {data.plan.completed.slice(0, 20).map((item, index) => (
              <div key={`${item.address ?? "completed"}-${index}`}>
                <span style={{ color: "var(--tone-success)" }}>✓</span>{" "}
                {item.address ? `${item.address} · ` : ""}{item.description}
              </div>
            ))}
          </div>
        ) : null}

        {data.plan.pending.length > 0 ? (
          <div className="space-y-1 text-small" style={{ color: "var(--tone-warn)" }}>
            <div className="text-meta">待完成目标</div>
            {data.plan.pending.slice(0, 20).map((item, index) => (
              <div key={`${item.address ?? "plan"}-${index}`}>
                {item.address ? `${item.address} · ` : ""}{item.description}{item.reason ? `：${item.reason}` : ""}
              </div>
            ))}
          </div>
        ) : null}

        {cells.length ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-small">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-normal">单元格</th>
                  <th className="px-2 py-1.5 text-left font-normal">修改前</th>
                  <th className="px-2 py-1.5 text-left font-normal">修改后</th>
                </tr>
              </thead>
              <tbody>
                {cells.map((cell) => (
                  <tr key={cell.address} className="border-b border-border/60 last:border-0">
                    <td className="px-2 py-1.5 font-mono text-meta">{cell.address}</td>
                    <td className="max-w-64 px-2 py-1.5 break-words text-muted-foreground">{cellText(cell.before)}</td>
                    <td className="max-w-64 px-2 py-1.5 break-words">{cellText(cell.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {data.script ? (
          <div className="space-y-1 text-meta text-muted-foreground">
            <div>脚本 {data.script.name} · {data.script.diff.summary}</div>
            {scriptLines(data.script.diff).slice(0, 20).map((line, index) => (
              <div key={index} className="grid grid-cols-[3rem_1fr_1fr] gap-2 font-mono">
                <span>L{line.line}</span>
                <span className="break-all">− {line.before ?? ""}</span>
                <span className="break-all text-foreground">+ {line.after ?? ""}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <a
            href={`/api/workspace/versions/${encodeURIComponent(data.candidateVersionId)}/content`}
            target="_blank"
            rel="noreferrer"
            className="text-small text-primary hover:underline"
          >
            查看候选文件
          </a>
          {status === "pending" ? (
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => void decide("rejected")}>拒绝</Button>
              <Button type="button" size="sm" disabled={submitting} onClick={() => void decide("approved")}>批准变更</Button>
            </div>
          ) : null}
        </div>
      </div>
    </Surface>
  );
}

function StatusLabel({ status }: { status: "pending" | "working" | "complete" | "applied" | "rejected" }) {
  const label = status === "pending" ? "待你复核" : status === "working" ? "Agent 继续修改" : status === "complete" ? "变更已记录" : status === "applied" ? "已批准" : "已拒绝";
  return <span className="shrink-0 text-meta text-muted-foreground">{label}</span>;
}

function cellChanges(details: Record<string, unknown>): CellChange[] {
  const value = details.cellChanges as { added?: CellChange[]; removed?: CellChange[]; changed?: CellChange[] } | undefined;
  return [...(value?.changed ?? []), ...(value?.added ?? []), ...(value?.removed ?? [])];
}

function cellText(cell?: CellSnapshot): string {
  if (!cell) return "—";
  if (cell.formula) return `=${cell.formula}${cell.value == null ? "" : ` → ${printValue(cell.value)}`}`;
  return printValue(cell.value);
}

function printValue(value: unknown): string {
  if (value == null || value === "") return "空";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

function scriptLines(diff: { summary: string; details?: Record<string, unknown> }): Array<{ line: number; before: string | null; after: string | null }> {
  const lines = diff.details?.changedLines;
  if (!Array.isArray(lines)) return [];
  return lines.filter((line): line is { line: number; before: string | null; after: string | null } =>
    Boolean(line) && typeof line === "object" && typeof (line as { line?: unknown }).line === "number",
  );
}
