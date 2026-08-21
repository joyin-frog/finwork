import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";

export type ResourceMetrics = { rssBytes: number; heapUsedBytes: number; userCpuMicros: number; systemCpuMicros: number; queueDepth: number; cacheBytes: number; diskBytes: number; gcReclaimedBytes: number; tokens: number; retries: number };
export function captureResourceMetrics(db: DatabaseSync, input: Partial<ResourceMetrics> & { runId?: string; caseId?: string }, now = new Date().toISOString()): ResourceMetrics {
  const memory = process.memoryUsage(); const cpu = process.resourceUsage();
  const metrics: ResourceMetrics = { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, userCpuMicros: cpu.userCPUTime, systemCpuMicros: cpu.systemCPUTime, queueDepth: input.queueDepth ?? 0, cacheBytes: input.cacheBytes ?? 0, diskBytes: input.diskBytes ?? 0, gcReclaimedBytes: input.gcReclaimedBytes ?? 0, tokens: input.tokens ?? 0, retries: input.retries ?? 0 };
  db.prepare("INSERT INTO resource_metric_snapshots(snapshot_id,run_id,case_id,metrics_json,captured_at) VALUES (?,?,?,?,?)").run(randomUUID(), input.runId ?? null, input.caseId ?? null, canonicalJson(metrics), now); return metrics;
}
export function directoryBytes(root: string): number { if (!fs.existsSync(root)) return 0; let total = 0; const stack = [root]; while (stack.length) { const current = stack.pop()!; for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const target = `${current}/${entry.name}`; if (entry.isDirectory()) stack.push(target); else if (entry.isFile()) total += fs.statSync(target).size; } } return total; }
