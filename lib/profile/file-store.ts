import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { getProfilePath } from "@/lib/runtime/paths";

export type CompanyProfile = {
  region?: string;              // 上海市松江区
  zones?: string[];             // ["临港新片区"]
  taxpayerType?: "小规模" | "一般纳税人";
  isHighTech?: boolean;
  industry?: string;
  scaleRevenueWan?: number;     // 年营收(万)
  revenueDimensions?: string[]; // 收入拆分维度名，如 ["事业部"]——P2 下钻用
  extra?: Record<string, unknown>;
};

const MAX_BYTES = 64 * 1024; // 64 KB

export async function readCompanyProfile(filePath = getProfilePath()): Promise<CompanyProfile> {
  if (!existsSync(filePath)) return {};
  try {
    const text = await readFile(filePath, "utf-8");
    if (text.length > MAX_BYTES) {
      console.warn(`[profile] profile.json is ${text.length} bytes, truncating read`);
    }
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as CompanyProfile;
    }
    return {};
  } catch (err) {
    console.warn("[profile] failed to read profile.json", err);
    return {};
  }
}

/** 原子写：tmp + rename，保证读方永远只看到旧内容或新内容。 */
async function atomicWrite(filePath: string, data: CompanyProfile): Promise<void> {
  mkdirSync(filePath.substring(0, filePath.lastIndexOf("/")), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}

/** 进程内串行写队列，防止并发 PUT 互相覆盖。 */
let writeQueue: Promise<void> = Promise.resolve();

/** 合并更新公司画像（patch 浅合并，extra 深合并）。 */
export async function mergeCompanyProfile(
  patch: Partial<CompanyProfile>,
  filePath = getProfilePath()
): Promise<CompanyProfile> {
  const task = writeQueue.catch(() => undefined).then(async () => {
    const current = await readCompanyProfile(filePath);
    const merged: CompanyProfile = {
      ...current,
      ...patch,
      // extra 深合并，保留旧字段
      ...(patch.extra !== undefined || current.extra !== undefined
        ? { extra: { ...(current.extra ?? {}), ...(patch.extra ?? {}) } }
        : {}),
    };
    await atomicWrite(filePath, merged);
    return merged;
  });
  writeQueue = task.then(() => undefined, () => undefined);
  return task;
}

export async function writeCompanyProfile(
  profile: CompanyProfile,
  filePath = getProfilePath()
): Promise<void> {
  const innerTask = writeQueue.catch(() => undefined).then(() => atomicWrite(filePath, profile));
  writeQueue = innerTask;
  return innerTask;
}
