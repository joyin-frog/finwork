import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TaskContract } from "@/lib/agent/run-contract";
import type {
  AssertionResult,
  GoldenTask,
  RuntimeConfirmation,
  RuntimeEventRecord,
  SideEffectSnapshot,
} from "./types";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TRACKED_TABLES = [
  "audit_log",
  "completion_evidence",
  "deliverables",
  "fact_invoices",
  "fact_obligations",
  "fact_payroll",
  "knowledge_documents",
];

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeToolName(name: string): string {
  return name.replace(/^mcp__[^_]+_worker__/, "").replace(/^mcp__[^_]+__/, "");
}

export function normalizeSkillName(name: string): string {
  return name.split(":").at(-1) ?? name;
}

export function buildTaskContract(task: GoldenTask): TaskContract {
  const mimes = task.expected.delivery?.mimeTypes ?? [];
  const ids = new Map<string, number>();
  const requiredDeliverables = mimes.map((mime) => {
    const base = mime === XLSX_MIME ? "workbook" : mime === DOCX_MIME ? "document" : "file";
    const count = (ids.get(base) ?? 0) + 1;
    ids.set(base, count);
    return {
      id: count === 1 ? base : `${base}-${count}`,
      mime,
      count: 1,
      qualityProfile: "generic" as const,
    };
  });
  const hasSpreadsheet = mimes.includes(XLSX_MIME);
  return {
    version: 1,
    taskKind: hasSpreadsheet ? "spreadsheet" : "text",
    ...(hasSpreadsheet
      ? {
          spreadsheetRequirement: {
            needsLegacyXlsRead: false,
            needsWrite: true,
            needsRecalc: false,
            needsRender: false,
            needsMacroPreservation: false,
          },
        }
      : {}),
    requiredDeliverables,
    expectationSnapshot: {},
  };
}

export function sanitizeSettingsJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSettingsJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["apikey", "telemetrytoken", "useravatar"].includes(key.toLowerCase()))
      .map(([key, child]) => {
        const normalized = key.toLowerCase();
        if (normalized === "companyname") return [key, "AS0 测试公司"];
        if (normalized === "agentname") return [key, "小财"];
        if (normalized === "username") return [key, "AS0 测试用户"];
        if (normalized === "telemetryenabled") return [key, false];
        if (normalized === "telemetryendpoint") return [key, ""];
        if (normalized === "telemetryinstallid") return [key, "as0-isolated"];
        return [key, sanitizeSettingsJson(child)];
      }),
  );
}

export function redactSessionId(sessionId: string | null): string | null {
  return sessionId ? sha256(sessionId).slice(0, 16) : null;
}

function snapshotFiles(root: string): SideEffectSnapshot["files"] {
  if (!existsSync(root)) return [];
  const rows: SideEffectSnapshot["files"] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const content = readFileSync(absolute);
        rows.push({
          path: path.relative(root, absolute),
          sizeBytes: content.length,
          sha256: sha256(content),
        });
      }
    }
  };
  walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export function snapshotSideEffects(args: {
  appDataDir: string;
  outputRoot: string;
  db: DatabaseSync;
  memoryPath: string;
}): SideEffectSnapshot {
  const database: Record<string, number> = {};
  for (const table of TRACKED_TABLES) {
    const exists = args.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    database[table] = exists
      ? Number((args.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
      : 0;
  }
  const memorySha256 = existsSync(args.memoryPath) ? sha256(readFileSync(args.memoryPath)) : null;
  return {
    files: snapshotFiles(args.outputRoot),
    database,
    memorySha256,
  };
}

function toolExpressionHit(expression: string, calls: string[]): boolean {
  return expression.split("|").some((candidate) => calls.includes(candidate));
}

function loadedSkills(events: RuntimeEventRecord[]): string[] {
  return events
    .filter((record) => record.event.type === "tool_started" && normalizeToolName(record.event.toolName) === "Skill")
    .map((record) => {
      const input = record.event.type === "tool_started" ? record.event.input : undefined;
      if (!input || typeof input !== "object") return "";
      const data = input as Record<string, unknown>;
      return normalizeSkillName(String(data.skill ?? data.name ?? data.skillName ?? ""));
    })
    .filter(Boolean);
}

export function evaluateAttempt(args: {
  task: GoldenTask;
  events: RuntimeEventRecord[];
  confirmations: RuntimeConfirmation[];
  completionEvidence: Array<{ mime?: unknown }>;
}): { assertions: AssertionResult[]; toolCalls: string[]; skillLoads: string[] } {
  const toolCalls = args.events
    .filter((record) => record.event.type === "tool_started")
    .map((record) => normalizeToolName((record.event as { toolName: string }).toolName));
  const skillLoads = loadedSkills(args.events);
  const assertions: AssertionResult[] = [];
  const add = (id: string, description: string, ok: boolean, actual?: unknown) => {
    assertions.push({ id, description, status: ok ? "pass" : "fail", actual });
  };

  for (const required of args.task.expected.requiredTools) {
    add(`tool.required.${required}`, `必须调用 ${required}`, toolExpressionHit(required, toolCalls), toolCalls);
  }
  for (const forbidden of args.task.expected.forbiddenTools) {
    const violated = forbidden === "*" ? toolCalls.length > 0 : toolExpressionHit(forbidden, toolCalls);
    add(`tool.forbidden.${forbidden}`, `不得调用 ${forbidden}`, !violated, toolCalls);
  }
  if (args.task.expected.firstToolOneOf?.length) {
    const firstBusinessTool = toolCalls.find((tool) => tool !== "Skill");
    add(
      "tool.first",
      `首次业务工具应为 ${args.task.expected.firstToolOneOf.join("|")}`,
      Boolean(firstBusinessTool && args.task.expected.firstToolOneOf.some((tool) => toolExpressionHit(tool, [firstBusinessTool]))),
      firstBusinessTool ?? null,
    );
  }
  for (const skill of args.task.expected.skills) {
    add(
      `skill.${skill}`,
      `应加载 Skill ${skill}`,
      skill.split("|").some((candidate) => skillLoads.includes(candidate)),
      skillLoads,
    );
  }

  const confirmEvents = args.confirmations.filter((item) => item.kind === "confirm");
  if (args.task.expected.confirmation === "none") {
    add("confirmation.none", "不应请求风险确认", confirmEvents.length === 0, confirmEvents);
  } else if (args.task.expected.confirmation === "accept") {
    add("confirmation.accept", "必须请求并接受确认", confirmEvents.some((item) => /确认|accept/i.test(item.answer)), confirmEvents);
  } else if (args.task.expected.confirmation === "reject") {
    add("confirmation.reject", "必须请求并拒绝确认", confirmEvents.some((item) => /取消|拒绝|reject/i.test(item.answer)), confirmEvents);
  }

  if (args.task.expected.delivery?.required) {
    for (const mime of args.task.expected.delivery.mimeTypes) {
      add(
        `delivery.${mime}`,
        `必须有通过质量门的 ${mime}`,
        args.completionEvidence.some((evidence) => evidence.mime === mime),
        args.completionEvidence,
      );
    }
  }

  for (const [index, description] of args.task.expected.assertions.entries()) {
    assertions.push({
      id: `business.${index + 1}`,
      description,
      status: "not_observable",
    });
  }
  return { assertions, toolCalls, skillLoads };
}

export function fileMime(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".csv") return "text/csv";
  if (ext === ".md") return "text/markdown";
  if (ext === ".json") return "application/json";
  if (ext === ".xlsx") return XLSX_MIME;
  if (ext === ".docx") return DOCX_MIME;
  return "application/octet-stream";
}

export function fileSize(filePath: string): number {
  return statSync(filePath).size;
}
