import { Surface } from "@/components/ui/surface";
import type { FoundationManagementSnapshot } from "@/lib/observability/foundation-read-model";
import { FoundationOperationsClient } from "./foundation-operations-client";

type CountMap = Record<string, number>;

const LABELS: Record<string, string> = {
  active: "进行中", available: "可用", blocked: "已阻塞", completed: "已完成",
  failed: "失败", passed: "通过", pending: "待处理", approved: "已批准",
  proposed: "待批准", rejected: "已拒绝", completed_with_warnings: "带警告完成",
  deleted: "已删除", retained: "依法保留", none: "未分类", matched: "一致",
  mismatched: "不一致", inconclusive: "无法判定", queued: "排队中", running: "运行中",
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function Counts({ values, empty = "暂无数据" }: { values: CountMap; empty?: string }) {
  const entries = Object.entries(values);
  if (!entries.length) return <p className="text-caption text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([key, value]) => (
        <span key={key} className="rounded-md bg-muted px-2 py-1 text-meta text-muted-foreground">
          {LABELS[key] ?? key} {value}
        </span>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <span className="text-body text-sidebar-foreground">{label}</span>
      <strong className="text-body font-medium text-foreground">{value}</strong>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Surface level="card" edge="hairline" shape="panel" pad="card" className="min-w-0">
      <h2 className="mb-3 text-title font-medium">{title}</h2>
      {children}
    </Surface>
  );
}

export function FoundationManagementView({ snapshot }: { snapshot: FoundationManagementSnapshot }) {
  return (
    <main className="min-h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5 px-6 py-8">
        <div>
          <h1 className="text-h1">能力基础设施</h1>
          <p className="mt-1 text-body text-muted-foreground">
            聚合查看能力、案件、证据、记忆、文件生命周期与资源状态。此页面不显示原始业务内容。
          </p>
        </div>

        <p className="text-caption text-muted-foreground">快照 {snapshot.generatedAt}</p>

        <div className="grid gap-4 md:grid-cols-2">
          <Section title="能力注册与可用性"><Counts values={snapshot.capabilities.totals} /></Section>
          <Section title="案件与长任务"><Counts values={snapshot.cases.totals} /></Section>
          <Section title="证据与断言">
            <Counts values={snapshot.evidence.records} />
            <div className="mt-3"><Metric label="引用记录" value={snapshot.evidence.citations} /></div>
          </Section>
          <Section title="文件生命周期">
            <Counts values={snapshot.artifacts.lifecycle} />
            <div className="mt-3">
              <Metric label="逻辑占用" value={formatBytes(snapshot.artifacts.logicalBytes)} />
              <Metric label="去重占用" value={formatBytes(snapshot.artifacts.uniqueBytes)} />
              <Metric label="有效保留锁" value={snapshot.artifacts.activeHolds} />
              <Metric label="有效租约" value={snapshot.artifacts.activeLeases} />
            </div>
          </Section>
          <Section title="记忆治理">
            <Counts values={snapshot.memory.approval} />
            <div className="mt-3">
              <Metric label="访问审计" value={snapshot.memory.accessEvents} />
              <p className="mb-1 mt-3 text-meta text-muted-foreground">删除请求处置</p>
              <Counts values={snapshot.memory.deletionRequests} />
            </div>
          </Section>
          <Section title="资源治理">
            <Counts values={snapshot.resources.jobs} />
            <div className="mt-3">
              <Metric label="缓存条目" value={snapshot.resources.cacheEntries} />
              <Metric label="缓存占用" value={formatBytes(snapshot.resources.cacheBytes)} />
            </div>
          </Section>
          <Section title="质量评测">
            <Counts values={snapshot.evaluation.runs} />
            <p className="mb-1 mt-3 text-meta text-muted-foreground">故障域</p>
            <Counts values={snapshot.evaluation.faults} />
          </Section>
          <Section title="最近案件">
            <div className="max-h-72 overflow-y-auto">
              {snapshot.cases.items.length ? snapshot.cases.items.map((item) => {
                const row = item as { caseId: string; state: string; nodes: number; failedNodes: number; waitingNodes: number };
                return (
                  <div key={row.caseId} className="border-b border-border py-2 last:border-b-0">
                    <p className="truncate text-body font-medium">{row.caseId}</p>
                    <p className="text-caption text-muted-foreground">
                      {LABELS[row.state] ?? row.state} · {row.nodes} 节点 · {row.failedNodes} 失败 · {row.waitingNodes} 待确认
                    </p>
                  </div>
                );
              }) : <p className="text-caption text-muted-foreground">暂无案件</p>}
            </div>
          </Section>
        </div>
        <FoundationOperationsClient />
      </div>
    </main>
  );
}
