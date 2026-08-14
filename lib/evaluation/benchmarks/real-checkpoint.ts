import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "@/lib/capability/hash";
import {
  BenchmarkCaseResultV2Schema,
  RealBenchmarkRunConfigSchema,
  type BenchmarkCaseResultV2,
  type RealBenchmarkRunConfig,
} from "./contracts";
import type { RealBenchmarkStopReason } from "./real-runner";

const BaseEventSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().trim().min(1),
  at: z.iso.datetime({ offset: true }),
}).strict();

export const RealBenchmarkCheckpointEventSchema = z.discriminatedUnion("type", [
  BaseEventSchema.extend({
    type: z.literal("run_started"),
    selectedCaseIds: z.array(z.string().trim().min(1)).min(1),
    configurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("case_started"),
    caseId: z.string().trim().min(1),
    ordinal: z.number().int().nonnegative(),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("case_finished"),
    caseId: z.string().trim().min(1),
    ordinal: z.number().int().nonnegative(),
    result: BenchmarkCaseResultV2Schema,
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("case_rerun_authorized"),
    caseId: z.string().trim().min(1),
    reason: z.literal("provider_usage_and_run_state_reviewed"),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("run_stopped"),
    reason: z.object({
      code: z.string().trim().min(1),
      faultDomain: z.string().trim().min(1).optional(),
    }).strict(),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("run_finished"),
    reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
export type RealBenchmarkCheckpointEvent = z.infer<typeof RealBenchmarkCheckpointEventSchema>;

export type RealBenchmarkResumeState = {
  startedAt: string;
  resumeResults: BenchmarkCaseResultV2[];
  unknownCaseIds: string[];
  finished: boolean;
};

export function createRunStartedEvent(input: {
  runId: string;
  selectedCaseIds: string[];
  configuration: RealBenchmarkRunConfig;
  at: string;
}): RealBenchmarkCheckpointEvent {
  const configuration = RealBenchmarkRunConfigSchema.parse(input.configuration);
  return RealBenchmarkCheckpointEventSchema.parse({
    schemaVersion: 1,
    type: "run_started",
    runId: input.runId,
    at: input.at,
    selectedCaseIds: input.selectedCaseIds,
    configurationSha256: sha256(canonicalJson(configuration)),
  });
}

export async function appendRealBenchmarkCheckpointEvent(
  eventsPath: string,
  event: RealBenchmarkCheckpointEvent,
): Promise<void> {
  const parsed = RealBenchmarkCheckpointEventSchema.parse(event);
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  const handle = await fs.open(eventsPath, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(parsed)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readRealBenchmarkCheckpointEvents(
  eventsPath: string,
): Promise<RealBenchmarkCheckpointEvent[]> {
  const text = await fs.readFile(eventsPath, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return RealBenchmarkCheckpointEventSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`benchmark_checkpoint_event_invalid:${index + 1}`, { cause: error });
    }
  });
}

export function reconstructRealBenchmarkResumeState(input: {
  events: readonly RealBenchmarkCheckpointEvent[];
  runId: string;
  selectedCaseIds: readonly string[];
  configuration: RealBenchmarkRunConfig;
  confirmUnknownCaseReviewed: boolean;
}): RealBenchmarkResumeState {
  const events = input.events.map((event) => RealBenchmarkCheckpointEventSchema.parse(event));
  const started = events.filter((event) => event.type === "run_started");
  if (started.length !== 1) throw new Error("benchmark_checkpoint_requires_one_run_started_event");
  const first = started[0]!;
  if (first.runId !== input.runId || events.some((event) => event.runId !== input.runId)) {
    throw new Error("benchmark_checkpoint_run_id_mismatch");
  }
  if (canonicalJson(first.selectedCaseIds) !== canonicalJson(input.selectedCaseIds)) {
    throw new Error("benchmark_checkpoint_case_selection_mismatch");
  }
  const configurationSha256 = sha256(canonicalJson(RealBenchmarkRunConfigSchema.parse(input.configuration)));
  if (first.configurationSha256 !== configurationSha256) {
    throw new Error("benchmark_checkpoint_configuration_mismatch");
  }
  const selected = new Set(input.selectedCaseIds);
  const starts = new Map<string, number>();
  const finishes = new Map<string, BenchmarkCaseResultV2>();
  const rerunAuthorizations = new Set<string>();
  for (const event of events) {
    if (event.type === "case_started") {
      if (!selected.has(event.caseId) || finishes.has(event.caseId)) throw new Error(`benchmark_checkpoint_case_start_invalid:${event.caseId}`);
      if (starts.has(event.caseId) && !rerunAuthorizations.delete(event.caseId)) {
        throw new Error(`benchmark_checkpoint_case_start_invalid:${event.caseId}`);
      }
      starts.set(event.caseId, event.ordinal);
    }
    if (event.type === "case_rerun_authorized") {
      if (!selected.has(event.caseId) || !starts.has(event.caseId) || finishes.has(event.caseId)) {
        throw new Error(`benchmark_checkpoint_rerun_authorization_invalid:${event.caseId}`);
      }
      rerunAuthorizations.add(event.caseId);
    }
    if (event.type === "case_finished") {
      if (!selected.has(event.caseId) || finishes.has(event.caseId) || !starts.has(event.caseId)) {
        throw new Error(`benchmark_checkpoint_case_finish_invalid:${event.caseId}`);
      }
      if (event.result.caseId !== event.caseId || event.ordinal !== starts.get(event.caseId)) {
        throw new Error(`benchmark_checkpoint_case_result_mismatch:${event.caseId}`);
      }
      finishes.set(event.caseId, event.result);
    }
  }
  const unknownCaseIds = [...starts.keys()].filter((caseId) => !finishes.has(caseId));
  if (unknownCaseIds.length > 0 && !input.confirmUnknownCaseReviewed) {
    throw new Error(`benchmark_paid_case_status_unknown:${unknownCaseIds.join(",")}`);
  }
  return {
    startedAt: first.at,
    resumeResults: input.selectedCaseIds.flatMap((caseId) => finishes.has(caseId) ? [finishes.get(caseId)!] : []),
    unknownCaseIds,
    finished: events.some((event) => event.type === "run_finished"),
  };
}

export function createRunStoppedEvent(input: {
  runId: string;
  reason: RealBenchmarkStopReason;
  at: string;
}): RealBenchmarkCheckpointEvent {
  return RealBenchmarkCheckpointEventSchema.parse({
    schemaVersion: 1,
    type: "run_stopped",
    runId: input.runId,
    at: input.at,
    reason: input.reason,
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
