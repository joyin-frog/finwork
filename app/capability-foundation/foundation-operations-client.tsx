"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Surface } from "@/components/ui/surface";

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
type CaseSummary = {
  caseId: string; taskId: string; runId: string | null; kind: string; state: string;
  planVersion: number; nodeCount: number; failedNodeCount: number; pendingDecisionCount: number; updatedAt: string;
};
type CaseDetail = { summary: CaseSummary; snapshot: Record<string, unknown> };
type ClaimSummary = {
  claimId: string; caseId: string; status: string; statementHash: string;
  evidenceCount: number; citationCount: number; updatedAt: string;
};
type EvidenceExport = {
  claim: { claimId: string; caseId: string; status: string; statementHash: string };
  evidence: Array<{ evidenceId: string; type: string; artifactVersionId: string; locator: unknown; outputHash: string }>;
  citations: Array<{ citationId: string; artifactVersionId: string; locator: unknown; quoteHash: string }>;
  assertions: Array<{ assertionId: string; validatorId: string; status: string; blocking: boolean }>;
};
type ArtifactSummary = {
  artifactId: string; kind: string; logicalName: string; ownerCaseId: string | null; classification: string;
  lifecycleState: string; currentVersionId: string | null; versionCount: number; logicalBytes: number; updatedAt: string;
};
type ArtifactDetail = {
  artifact: ArtifactSummary;
  versions: Array<{ versionId: string; versionNo: number; sha256: string; sizeBytes: number; mediaType: string; state: string; createdAt: string }>;
  holds: Array<{ holdId: string; artifactVersionId: string; type: string; reason: string; expiresAt: string | null; releasedAt: string | null }>;
  events: Array<{ eventId: string; artifactVersionId: string | null; type: string; actorId: string; detailsHash: string; createdAt: string }>;
};
type GcPlan = { runId: string; candidates: Array<{ artifactVersionId: string; artifactId: string; sizeBytes: number; reason: string }>; reclaimableBytes: number };
type Tab = "cases" | "evidence" | "artifacts";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "cases", label: "案件" }, { id: "evidence", label: "证据链" }, { id: "artifacts", label: "文件生命周期" },
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !body.ok) throw new Error(body.ok ? `请求失败 (${response.status})` : body.error);
  return body.data;
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function Empty({ children }: { children: string }) {
  return <p className="py-8 text-center text-body text-muted-foreground">{children}</p>;
}

function JsonView({ value }: { value: unknown }) {
  return <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-input p-3 text-caption">{JSON.stringify(value, null, 2)}</pre>;
}

export function FoundationOperationsClient() {
  const [tab, setTab] = useState<Tab>("cases");
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [evidenceDetail, setEvidenceDetail] = useState<EvidenceExport | null>(null);
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetail | null>(null);
  const [gcPlan, setGcPlan] = useState<GcPlan | null>(null);
  const [holdReason, setHoldReason] = useState("用户固定保留");
  const [sweepConfirm, setSweepConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLists = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const [caseData, claimData, artifactData] = await Promise.all([
        api<{ cases: CaseSummary[] }>("/api/capability-foundation/cases?limit=100"),
        api<{ claims: ClaimSummary[] }>("/api/capability-foundation/evidence?limit=100"),
        api<{ artifacts: ArtifactSummary[] }>("/api/capability-foundation/artifacts?limit=100"),
      ]);
      setCases(caseData.cases); setClaims(claimData.claims); setArtifacts(artifactData.artifacts);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "加载失败"); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void loadLists(); }, [loadLists]);

  const act = useCallback(async (body: Record<string, unknown>, success: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const data = await api<unknown>("/api/capability-foundation/artifacts", { method: "POST", body: JSON.stringify(body) });
      setNotice(success);
      await loadLists();
      if (artifactDetail) setArtifactDetail(await api<ArtifactDetail>(`/api/capability-foundation/artifacts?artifactId=${encodeURIComponent(artifactDetail.artifact.artifactId)}`));
      return data;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); return null; }
    finally { setBusy(false); }
  }, [artifactDetail, loadLists]);

  const selectedVersion = artifactDetail?.versions[0];
  const activeHolds = useMemo(() => artifactDetail?.holds.filter((item) => !item.releasedAt) ?? [], [artifactDetail]);

  return (
    <section aria-labelledby="foundation-operations-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="foundation-operations-title" className="text-h2">治理工作台</h2>
          <p className="mt-1 text-body text-muted-foreground">安全查看案件、证据链与制品版本；危险操作必须显式确认。</p>
        </div>
        <Button variant="outline" onClick={() => void loadLists()} disabled={busy}>刷新</Button>
      </div>

      <div className="flex gap-1" role="tablist" aria-label="能力基础设施治理区域">
        {TABS.map((item) => <Button key={item.id} role="tab" aria-selected={tab === item.id} variant={tab === item.id ? "secondary" : "ghost"} onClick={() => setTab(item.id)}>{item.label}</Button>)}
      </div>
      {error && <Surface level="page" edge="hairline" shape="control" className="border-destructive/50 p-3 text-body text-destructive" role="alert">{error}</Surface>}
      {notice && <Surface level="page" edge="hairline" shape="control" className="p-3 text-body" role="status">{notice}</Surface>}

      {tab === "cases" && <div className="grid min-h-80 gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
        <Surface level="card" edge="hairline" shape="panel" className="overflow-hidden">
          {cases.length ? cases.map((item) => <button key={item.caseId} type="button" onClick={async () => {
            setError(null); try { setCaseDetail(await api<CaseDetail>(`/api/capability-foundation/cases?caseId=${encodeURIComponent(item.caseId)}`)); } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
          }} className="block w-full border-b border-border p-3 text-left last:border-b-0 hover:bg-muted">
            <span className="block truncate text-body font-medium">{item.caseId}</span>
            <span className="text-caption text-muted-foreground">{item.kind} · {item.state} · {item.nodeCount} 节点 · {item.pendingDecisionCount} 待确认</span>
          </button>) : <Empty>暂无案件</Empty>}
        </Surface>
        <Surface level="card" edge="hairline" shape="panel" pad="card">
          {caseDetail ? <><h3 className="mb-1 text-title font-medium">案件快照</h3><p className="mb-3 text-caption text-muted-foreground">任务 {caseDetail.summary.taskId} · 计划 v{caseDetail.summary.planVersion}</p><JsonView value={caseDetail.snapshot} /></> : <Empty>选择案件查看不可变快照</Empty>}
        </Surface>
      </div>}

      {tab === "evidence" && <div className="grid min-h-80 gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
        <Surface level="card" edge="hairline" shape="panel" className="overflow-hidden">
          {claims.length ? claims.map((item) => <button key={item.claimId} type="button" onClick={async () => {
            setError(null); try { setEvidenceDetail(await api<EvidenceExport>(`/api/capability-foundation/evidence?claimId=${encodeURIComponent(item.claimId)}`)); } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
          }} className="block w-full border-b border-border p-3 text-left last:border-b-0 hover:bg-muted">
            <span className="block truncate text-body font-medium">{item.claimId}</span>
            <span className="text-caption text-muted-foreground">{item.status} · {item.evidenceCount} 证据 · {item.citationCount} 引用</span>
            <span className="mt-1 block truncate font-mono text-caption text-muted-foreground">{item.statementHash}</span>
          </button>) : <Empty>暂无断言</Empty>}
        </Surface>
        <Surface level="card" edge="hairline" shape="panel" pad="card">
          {evidenceDetail ? <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-title font-medium">脱敏证据链</h3><p className="text-caption text-muted-foreground">正文、工具输入和文件名默认只返回哈希。</p></div><Button variant="outline" onClick={() => {
              const blob = new Blob([JSON.stringify(evidenceDetail, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `evidence-${evidenceDetail.claim.claimId}.json`; link.click(); URL.revokeObjectURL(url);
            }}>导出脱敏链</Button></div>
            <JsonView value={evidenceDetail} />
          </> : <Empty>选择断言查看证据与精确定位</Empty>}
        </Surface>
      </div>}

      {tab === "artifacts" && <div className="grid min-h-80 gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
        <Surface level="card" edge="hairline" shape="panel" className="overflow-hidden">
          {artifacts.length ? artifacts.map((item) => <button key={item.artifactId} type="button" onClick={async () => {
            setError(null); try { setArtifactDetail(await api<ArtifactDetail>(`/api/capability-foundation/artifacts?artifactId=${encodeURIComponent(item.artifactId)}`)); } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
          }} className="block w-full border-b border-border p-3 text-left last:border-b-0 hover:bg-muted">
            <span className="block truncate text-body font-medium">{item.logicalName}</span>
            <span className="text-caption text-muted-foreground">{item.kind} · {item.lifecycleState} · {item.versionCount} 版本 · {bytes(item.logicalBytes)}</span>
          </button>) : <Empty>暂无制品</Empty>}
        </Surface>
        <Surface level="card" edge="hairline" shape="panel" pad="card">
          {artifactDetail ? <div className="flex flex-col gap-4">
            <div><h3 className="text-title font-medium">{artifactDetail.artifact.logicalName}</h3><p className="text-caption text-muted-foreground">{artifactDetail.artifact.classification} · {artifactDetail.artifact.lifecycleState} · 路径不对外暴露</p></div>
            <div className="flex flex-wrap gap-2">
              {selectedVersion && <><Button variant="outline" disabled={busy} onClick={() => void act({ action: "hold", versionId: selectedVersion.versionId, type: "pin", reason: holdReason }, "已固定保留")}>固定保留</Button>{selectedVersion.state === "tombstoned" && <Button variant="outline" disabled={busy} onClick={() => void act({ action: "restore", versionId: selectedVersion.versionId }, "已从回收站恢复")}>恢复版本</Button>}</>}
              {activeHolds.map((hold) => <Button key={hold.holdId} variant="ghost" disabled={busy} onClick={() => void act({ action: "release_hold", holdId: hold.holdId }, "已解除保留")}>解除 {hold.type}</Button>)}
            </div>
            <label className="text-meta text-muted-foreground">保留原因<Input value={holdReason} onChange={(event) => setHoldReason(event.target.value)} className="mt-1" /></label>
            <JsonView value={artifactDetail} />
          </div> : <Empty>选择制品查看版本、保留锁和审计事件</Empty>}
        </Surface>
        <Surface level="panel" edge="hairline" shape="panel" pad="card" className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-title font-medium">两阶段回收</h3><p className="text-caption text-muted-foreground">先 dry-run，再进入宽限期；物理清除只处理已过宽限期的墓碑版本。</p></div><Button variant="outline" disabled={busy} onClick={async () => {
            const result = await act({ action: "dry_run", minimumAgeMs: 86_400_000, gracePeriodMs: 604_800_000, lowWatermarkBytes: null }, "回收预演完成");
            if (result && typeof result === "object" && "plan" in result) setGcPlan((result as { plan: GcPlan }).plan);
          }}>回收预演</Button></div>
          {gcPlan && <div className="mt-3"><p className="text-body">候选 {gcPlan.candidates.length} 个，可回收 {bytes(gcPlan.reclaimableBytes)}</p><div className="mt-2 flex flex-wrap gap-2"><Button variant="destructive" disabled={busy || gcPlan.candidates.length === 0} onClick={() => void act({ action: "tombstone", runId: gcPlan.runId }, "候选已移入回收站")}>移入回收站</Button></div></div>}
          <div className="mt-4 border-t border-border pt-4"><label className="text-meta text-muted-foreground">输入 DELETE_EXPIRED_ARTIFACTS 才可清理已过宽限期内容<Input value={sweepConfirm} onChange={(event) => setSweepConfirm(event.target.value)} className="mt-1 font-mono" /></label><Button className="mt-2" variant="destructive" disabled={busy || sweepConfirm !== "DELETE_EXPIRED_ARTIFACTS"} onClick={() => void act({ action: "sweep", confirm: "DELETE_EXPIRED_ARTIFACTS" }, "过期墓碑清理完成")}>物理清理</Button></div>
        </Surface>
      </div>}
    </section>
  );
}
