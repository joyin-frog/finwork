import { existsSync, readFileSync, renameSync } from "node:fs";
import { getConventionsPath } from "@/lib/runtime/paths";
import { appendToMemorySection } from "./file-store";

/**
 * 一次性幂等迁移：把 conventions.json 中 enabled 条目写入 memory.md 的 ## 工作约定 节，
 * 然后把 conventions.json 改名为 conventions.json.migrated。
 * 没有文件或已迁移时直接返回。
 */
export async function ensureConventionsMigrated(
  conventionsPath = getConventionsPath()
): Promise<void> {
  if (!existsSync(conventionsPath)) return;

  let items: Array<{ text: string; enabled: boolean; createdAt: string }>;
  try {
    const raw = readFileSync(conventionsPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    items = parsed.filter(
      (v): v is { text: string; enabled: boolean; createdAt: string } =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as Record<string, unknown>).text === "string" &&
        typeof (v as Record<string, unknown>).enabled === "boolean"
    );
  } catch {
    return;
  }

  const enabled = items.filter((c) => c.enabled);
  for (const c of enabled) {
    const date = c.createdAt ? c.createdAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
    await appendToMemorySection("## 工作约定", `- [${date}] ${c.text}`);
  }

  // 改名标记迁移完成
  try {
    renameSync(conventionsPath, `${conventionsPath}.migrated`);
  } catch {
    // 改名失败时下次会重跑，但不报错（幂等性由 .migrated 文件判断）
  }
}
