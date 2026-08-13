"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { SettingsSection } from "@/app/config/settings-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type MemoryKind = "working" | "episodic" | "semantic" | "procedural" | "feedback";
type MemoryStatus = "candidate" | "approved" | "rejected" | "expired" | "archived";
type Sensitivity = "public" | "internal" | "confidential" | "restricted";
type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  content: unknown;
  sourceEvidenceRefs: string[];
  confidence: number;
  sensitivity: Sensitivity;
  approvalStatus: MemoryStatus;
  supersedes: string[];
  conflictsWith: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
};
type AccessLogEntry = {
  id: string;
  memoryId: string;
  action: "created" | "selected" | "approved" | "rejected" | "expired" | "archived" | "restored" | "corrected" | "deletion_requested" | "deleted" | "retained";
  reason?: string;
  evidenceRefs: string[];
  createdAt: string;
};
type RetentionDecision = {
  id: string;
  memoryId: string;
  status: "completed" | "retained";
  retentionReason?: string;
  requestedAt: string;
};

type ApiPayload<T> = { ok: boolean; data?: T; error?: string };
type StatusFilter = "all" | MemoryStatus;

const KIND_LABEL: Record<MemoryKind, string> = {
  working: "工作记忆",
  episodic: "事件",
  semantic: "事实与偏好",
  procedural: "已验证流程",
  feedback: "反馈",
};
const STATUS_LABEL: Record<MemoryStatus, string> = {
  candidate: "待确认",
  approved: "已启用",
  rejected: "已拒绝",
  expired: "已失效",
  archived: "已归档",
};
const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  public: "公开",
  internal: "内部",
  confidential: "机密",
  restricted: "受限",
};
const ACTION_LABEL: Record<AccessLogEntry["action"], string> = {
  created: "生成候选",
  selected: "用于回答",
  approved: "批准",
  rejected: "拒绝",
  expired: "失效",
  archived: "归档",
  restored: "恢复归档",
  corrected: "发起纠正",
  deletion_requested: "请求删除",
  deleted: "完成删除",
  retained: "按策略保留",
};

function readContent(content: unknown): { topic: string; summary: string } {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const value = content as Record<string, unknown>;
    if (typeof value.summary === "string") {
      return {
        topic: typeof value.topic === "string" && value.topic.trim() ? value.topic : "未命名记忆",
        summary: value.summary,
      };
    }
  }
  return {
    topic: "未命名记忆",
    summary: typeof content === "string" ? content : JSON.stringify(content),
  };
}

function formatTime(value?: string): string {
  if (!value) return "从未";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json() as ApiPayload<T>;
  if (!response.ok || !payload.ok || !payload.data) {
    throw new Error(payload.error ?? "记忆操作失败");
  }
  return payload.data;
}

export function MemorySettings() {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [accessLog, setAccessLog] = useState<AccessLogEntry[]>([]);
  const [retentionDecisions, setRetentionDecisions] = useState<RetentionDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [topic, setTopic] = useState("");
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<MemoryKind>("semantic");
  const [sensitivity, setSensitivity] = useState<Sensitivity>("internal");
  const [expiresOn, setExpiresOn] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MemoryRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiRequest<{ records: MemoryRecord[]; accessLog: AccessLogEntry[]; retentionDecisions: RetentionDecision[] }>(
        "/api/memory/governed?limit=200",
      );
      setRecords(data.records);
      setAccessLog(data.accessLog);
      setRetentionDecisions(data.retentionDecisions);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "记忆加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return records.filter((record) => {
      const content = readContent(record.content);
      const matchesStatus = status === "all" || record.approvalStatus === status;
      const matchesQuery = !normalized
        || content.topic.toLocaleLowerCase().includes(normalized)
        || content.summary.toLocaleLowerCase().includes(normalized);
      return matchesStatus && matchesQuery;
    });
  }, [query, records, status]);

  const counts = useMemo(() => ({
    all: records.length,
    candidate: records.filter((item) => item.approvalStatus === "candidate").length,
    approved: records.filter((item) => item.approvalStatus === "approved").length,
    rejected: records.filter((item) => item.approvalStatus === "rejected").length,
    expired: records.filter((item) => item.approvalStatus === "expired").length,
    archived: records.filter((item) => item.approvalStatus === "archived").length,
  }), [records]);

  const retainedByMemory = useMemo(() => {
    const result = new Map<string, RetentionDecision>();
    for (const decision of retentionDecisions) {
      if (decision.status === "retained" && !result.has(decision.memoryId)) result.set(decision.memoryId, decision);
    }
    return result;
  }, [retentionDecisions]);

  async function createCandidate() {
    if (!topic.trim() || !draft.trim()) {
      toast.error("请填写记忆主题和内容");
      return;
    }
    setBusyId("create");
    try {
      await apiRequest("/api/memory/governed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic,
          content: draft,
          kind,
          sensitivity,
          expiresAt: expiresOn ? new Date(`${expiresOn}T23:59:59`).toISOString() : undefined,
        }),
      });
      setTopic("");
      setDraft("");
      setExpiresOn("");
      toast.success("已生成候选记忆，请确认后启用");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "候选记忆创建失败");
    } finally {
      setBusyId(null);
    }
  }

  async function updateRecord(record: MemoryRecord, action: "approve" | "reject" | "archive" | "restore") {
    setBusyId(record.id);
    try {
      await apiRequest("/api/memory/governed", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          memoryId: record.id,
          supersedeIds: action === "approve" ? record.conflictsWith : undefined,
        }),
      });
      toast.success({
        approve: "记忆已启用",
        reject: "候选记忆已拒绝",
        archive: "记忆已归档，不再进入回答上下文",
        restore: "记忆已恢复",
      }[action]);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "记忆状态更新失败");
    } finally {
      setBusyId(null);
    }
  }

  function startCorrection(record: MemoryRecord) {
    setEditingId(record.id);
    setCorrection(readContent(record.content).summary);
  }

  async function submitCorrection(record: MemoryRecord) {
    if (!correction.trim()) return;
    setBusyId(record.id);
    try {
      await apiRequest("/api/memory/governed", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "correct", memoryId: record.id, content: correction }),
      });
      setEditingId(null);
      setCorrection("");
      toast.success("纠正已生成新的候选记忆");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "记忆纠正失败");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteRecord(record: MemoryRecord) {
    setBusyId(record.id);
    try {
      const result = await apiRequest<{ status: "completed" | "retained"; proof?: string; retentionReason?: string }>(
        "/api/memory/governed",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ memoryId: record.id }),
        },
      );
      setDeleteTarget(null);
      if (result.status === "completed") {
        toast.success(`记忆已删除，删除凭证 ${result.proof?.slice(0, 10)}…`);
      } else {
        toast.warning(`记忆按策略保留：${result.retentionReason}`);
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "记忆删除失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="受控记忆"
        description="新内容先成为候选，确认后才会用于回答；相同主题的冲突必须显式替代，不会静默覆盖。"
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="主题，例如：月结报表口径"
              maxLength={120}
              aria-label="记忆主题"
            />
            <Select value={kind} onValueChange={(value) => setKind(value as MemoryKind)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="semantic">事实与偏好</SelectItem>
                <SelectItem value="feedback">反馈</SelectItem>
                <SelectItem value="episodic">事件</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="写下要长期记住的事实、口径或偏好。"
            className="min-h-24"
            maxLength={20_000}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={sensitivity} onValueChange={(value) => setSensitivity(value as Sensitivity)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="public">公开</SelectItem>
                <SelectItem value="internal">内部</SelectItem>
                <SelectItem value="confidential">机密</SelectItem>
                <SelectItem value="restricted">受限</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={expiresOn}
              onChange={(event) => setExpiresOn(event.target.value)}
              className="w-auto"
              aria-label="记忆失效日期"
            />
            <span className="text-caption text-muted-foreground">不填表示长期有效</span>
            <Button className="ml-auto" onClick={() => void createCandidate()} disabled={busyId === "create"}>
              <PlusIcon data-icon="inline-start" />
              {busyId === "create" ? "生成中…" : "生成候选"}
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="记忆库"
        description="只有“已启用”记忆会进入对话上下文。纠正会生成新候选并保留来源链。"
      >
        <div className="flex flex-col">
          <div className="flex flex-col gap-2 pb-3">
            <div className="relative">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索记忆"
                className="pl-7"
              />
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="记忆状态筛选">
              {(["all", "candidate", "approved", "rejected", "expired", "archived"] as const).map((value) => (
                <Button
                  key={value}
                  variant={status === value ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setStatus(value)}
                >
                  {value === "all" ? "全部" : STATUS_LABEL[value]} {counts[value]}
                </Button>
              ))}
            </div>
          </div>

          {loading ? (
            <p className="border-t border-border/50 py-5 text-center text-meta text-muted-foreground">加载中…</p>
          ) : filteredRecords.length === 0 ? (
            <p className="border-t border-border/50 py-5 text-center text-meta text-muted-foreground">没有匹配的记忆</p>
          ) : (
            <div className="divide-y divide-border/50 border-t border-border/50">
              {filteredRecords.map((record) => {
                const content = readContent(record.content);
                const isEditing = editingId === record.id;
                const retention = retainedByMemory.get(record.id);
                const statusTone = record.approvalStatus === "approved"
                  ? "text-[color:var(--tone-ok)]"
                  : record.approvalStatus === "candidate"
                    ? "text-[color:var(--tone-warn)]"
                    : "text-muted-foreground";
                return (
                  <article key={record.id} className="flex flex-col gap-2 py-3 first:pt-3 last:pb-0">
                    <div className="flex min-w-0 items-start gap-2">
                      <div className={cn("mt-0.5", statusTone)}>
                        {record.approvalStatus === "approved" ? <ShieldCheckIcon className="size-4" />
                          : record.approvalStatus === "candidate" ? <WarningCircleIcon className="size-4" />
                            : record.approvalStatus === "rejected" ? <XCircleIcon className="size-4" />
                              : <ClockCounterClockwiseIcon className="size-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <h4 className="text-body font-medium">{content.topic}</h4>
                          <span className={cn("text-caption", statusTone)}>{STATUS_LABEL[record.approvalStatus]}</span>
                          <span className="text-caption text-muted-foreground">{KIND_LABEL[record.kind]} · {SENSITIVITY_LABEL[record.sensitivity]}</span>
                        </div>
                        {isEditing ? (
                          <Textarea
                            value={correction}
                            onChange={(event) => setCorrection(event.target.value)}
                            className="mt-2 min-h-20"
                            autoFocus
                          />
                        ) : (
                          <p className="mt-1 whitespace-pre-wrap text-meta text-foreground/90">{content.summary}</p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground">
                          <span>来源证据 {record.sourceEvidenceRefs.length} 条</span>
                          <span>最近使用 {formatTime(record.lastUsedAt)}</span>
                          {record.expiresAt ? <span>有效至 {formatTime(record.expiresAt)}</span> : null}
                          {record.conflictsWith.length > 0 ? (
                            <span className="text-[color:var(--tone-warn)]">冲突 {record.conflictsWith.length} 条</span>
                          ) : null}
                        </div>
                        {retention?.retentionReason ? (
                          <p className="mt-1 text-caption text-[color:var(--tone-warn)]">
                            保留原因：{retention.retentionReason}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap justify-end gap-1">
                      {isEditing ? (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>取消</Button>
                          <Button size="sm" onClick={() => void submitCorrection(record)} disabled={busyId === record.id}>生成纠正候选</Button>
                        </>
                      ) : (
                        <>
                          {record.approvalStatus === "candidate" ? (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => void updateRecord(record, "reject")} disabled={busyId === record.id}>
                                拒绝
                              </Button>
                              <Button size="sm" onClick={() => void updateRecord(record, "approve")} disabled={busyId === record.id}>
                                <CheckCircleIcon data-icon="inline-start" />
                                {record.conflictsWith.length > 0 ? `批准并替代 ${record.conflictsWith.length} 条` : "批准"}
                              </Button>
                            </>
                          ) : null}
                          {record.approvalStatus === "approved" || record.approvalStatus === "candidate" ? (
                            <Button variant="ghost" size="sm" onClick={() => startCorrection(record)}>
                              <NotePencilIcon data-icon="inline-start" />纠正
                            </Button>
                          ) : null}
                          {record.approvalStatus === "approved" || record.approvalStatus === "candidate" ? (
                            <Button variant="ghost" size="sm" onClick={() => void updateRecord(record, "archive")} disabled={busyId === record.id}>
                              <ClockCounterClockwiseIcon data-icon="inline-start" />归档
                            </Button>
                          ) : null}
                          {record.approvalStatus === "archived" ? (
                            <Button variant="ghost" size="sm" onClick={() => void updateRecord(record, "restore")} disabled={busyId === record.id}>
                              <ClockCounterClockwiseIcon data-icon="inline-start" />恢复
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleteTarget(record)}>
                            <TrashIcon data-icon="inline-start" />删除
                          </Button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title="使用与审计"
        description="查看记忆何时被创建、批准、用于回答、纠正或删除。"
      >
        <div className="divide-y divide-border/50">
          {accessLog.length === 0 ? (
            <p className="py-2 text-meta text-muted-foreground">还没有审计记录</p>
          ) : accessLog.slice(0, 20).map((entry) => (
            <div key={entry.id} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
              <ClockCounterClockwiseIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-meta">{ACTION_LABEL[entry.action]}</span>
                  <time className="text-caption text-muted-foreground">{formatTime(entry.createdAt)}</time>
                </div>
                {entry.reason ? <p className="truncate text-caption text-muted-foreground" title={entry.reason}>{entry.reason}</p> : null}
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这条记忆？</DialogTitle>
            <DialogDescription>
              将删除内容及关系并生成删除凭证。已有审计记录会保留，但不会继续包含记忆正文。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && void deleteRecord(deleteTarget)}
              disabled={!deleteTarget || busyId === deleteTarget.id}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
