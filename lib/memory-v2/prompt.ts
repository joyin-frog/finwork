import type { DatabaseSync } from "node:sqlite";
import { sha256Json } from "@/lib/capability/hash";
import type { TaskContract } from "@/lib/agent/run-contract";
import { getDb } from "@/lib/db/sqlite";
import {
  MemoryRuntimeContextSchema,
  type MemoryRuntimeContext,
  type MemorySelection,
} from "./contracts";
import { migrateLegacyMemoryCandidates } from "./migration";
import { GovernedMemoryStore } from "./store";

export type GovernedPromptMemory = {
  status: "ready" | "degraded";
  markdown: string;
  roleMemories: string[];
  selections: MemorySelection[];
  reason?: string;
};

function companyEntityRef(company: string): string {
  return `company-${sha256Json(company.trim().toLowerCase()).slice(0, 24)}`;
}

export function parseEffectivePeriodLabel(label: string | undefined): MemoryRuntimeContext["effectivePeriod"] {
  const value = label?.trim();
  if (!value) return undefined;
  const range = /^(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|—|–|-)\s*(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (range) return { start: range[1], end: range[2], label: value };
  const quarter = /^(\d{4})\s*年?\s*(?:第?([1-4])季度|Q([1-4]))$/i.exec(value);
  if (quarter) {
    const year = Number(quarter[1]);
    const q = Number(quarter[2] ?? quarter[3]);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const endDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    return {
      start: `${year}-${String(startMonth).padStart(2, "0")}-01`,
      end: `${year}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
      label: value,
    };
  }
  const year = /^(\d{4})\s*年?$/.exec(value);
  if (year) return { start: `${year[1]}-01-01`, end: `${year[1]}-12-31`, label: value };
  return undefined;
}

export function resolveMemoryRuntimeContext(input: {
  explicit?: Partial<MemoryRuntimeContext> | null;
  taskContract?: TaskContract | null;
}): MemoryRuntimeContext {
  const company = input.taskContract?.expectationSnapshot.company?.trim();
  return MemoryRuntimeContextSchema.parse({
    tenantId: input.explicit?.tenantId ?? "local",
    principalId: input.explicit?.principalId ?? "local-user",
    caseId: input.explicit?.caseId,
    entityRefs: input.explicit?.entityRefs ?? (company ? [companyEntityRef(company)] : []),
    effectivePeriod: input.explicit?.effectivePeriod
      ?? parseEffectivePeriodLabel(input.taskContract?.expectationSnapshot.period),
    maximumSensitivity: input.explicit?.maximumSensitivity ?? "confidential",
  });
}

function renderSelection(selection: MemorySelection): string {
  return `${selection.summary} [证据:${selection.evidenceRefs.join(",")}]`;
}

export async function loadGovernedPromptMemory(options: {
  roleId?: string;
  context: MemoryRuntimeContext;
  db?: DatabaseSync;
  now?: Date;
  migrateLegacy?: boolean;
  memoryPath?: string;
}): Promise<GovernedPromptMemory> {
  const db = options.db ?? getDb();
  const now = (options.now ?? new Date()).toISOString();
  try {
    if (options.migrateLegacy !== false) {
      await migrateLegacyMemoryCandidates({ db, memoryPath: options.memoryPath, at: now });
    }
    const store = new GovernedMemoryStore(db);
    const selections = store.retrieve({
      principal: {
        id: options.context.principalId,
        type: "user",
        tenantId: options.context.tenantId,
      },
      tenantId: options.context.tenantId,
      caseId: options.context.caseId,
      roleId: options.roleId,
      entityRefs: options.context.entityRefs,
      effectivePeriod: options.context.effectivePeriod,
      kinds: [],
      maximumSensitivity: options.context.maximumSensitivity,
      minimumConfidence: 0,
      limit: 20,
      now,
    });
    const roleMemories = selections.map(renderSelection);
    return {
      status: "ready",
      markdown: roleMemories.length ? roleMemories.map((line) => `- ${line}`).join("\n") : "",
      roleMemories,
      selections,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "degraded",
      markdown: "记忆系统当前不可用；不得使用旧记忆文件、缓存记忆或自行猜测长期口径。",
      roleMemories: [],
      selections: [],
      reason,
    };
  }
}
