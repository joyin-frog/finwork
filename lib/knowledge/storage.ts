import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAppDataDir, getKnowledgeTextDir } from "@/lib/runtime/paths";

export { getKnowledgeTextDir };

export function getKnowledgeStorageDir(): string {
  return process.env.FINANCE_AGENT_KNOWLEDGE_DIR ?? path.join(getAppDataDir(), "knowledge");
}

export function knowledgeStoragePath(hash: string, ext: string): string {
  const normalizedHash = hash.toLowerCase();
  const normalizedExt = ext
    ? `.${ext.replace(/^\.+/, "").toLowerCase()}`
    : "";
  return path.join(getKnowledgeStorageDir(), `${normalizedHash}${normalizedExt}`);
}

export function canonicalStoragePathKey(filePath: string): string {
  const resolved = path.resolve(filePath).normalize("NFC");
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

type LeaseRegistry = Map<string, number>;
const LEASE_REGISTRY_SYMBOL = Symbol.for("finance-agent.knowledge-ingest-leases");

function leaseRegistry(): LeaseRegistry {
  const root = globalThis as typeof globalThis & { [LEASE_REGISTRY_SYMBOL]?: LeaseRegistry };
  return root[LEASE_REGISTRY_SYMBOL] ??= new Map<string, number>();
}

function hashLeaseKey(hash: string): string {
  return `hash:${hash.toLowerCase()}`;
}

function pathLeaseKey(filePath: string): string {
  return `path:${canonicalStoragePathKey(filePath)}`;
}

export function acquireKnowledgeIngestLease(hash: string, storagePath: string): () => void {
  const registry = leaseRegistry();
  const keys = [hashLeaseKey(hash), pathLeaseKey(storagePath)];
  for (const key of keys) registry.set(key, (registry.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const remaining = (registry.get(key) ?? 0) - 1;
      if (remaining > 0) registry.set(key, remaining);
      else registry.delete(key);
    }
  };
}

export function hasActiveKnowledgeHashLease(hash: string): boolean {
  return (leaseRegistry().get(hashLeaseKey(hash)) ?? 0) > 0;
}

export function hasActiveKnowledgePathLease(storagePath: string): boolean {
  return (leaseRegistry().get(pathLeaseKey(storagePath)) ?? 0) > 0;
}

export function writeUploadedFile(hash: string, buffer: Buffer, ext: string): string {
  const dir = getKnowledgeStorageDir();
  mkdirSync(dir, { recursive: true });
  const normalizedHash = hash.toLowerCase();
  const filePath = knowledgeStoragePath(normalizedHash, ext);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.upload-${randomUUID()}`);
  writeFileSync(tmpPath, buffer, { flag: "wx" });
  try {
    try {
      linkSync(tmpPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const actualHash = computeFileHash(readFileSync(filePath));
      if (actualHash !== normalizedHash) {
        throw new Error(`知识库目标文件 hash 冲突: ${filePath}`);
      }
    }
  } finally {
    rmSync(tmpPath, { force: true });
  }
  return filePath;
}

export function writeTextMirror(hash: string, text: string): string {
  const dir = getKnowledgeTextDir();
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${hash}.txt`);
  writeFileSync(filePath, text, "utf-8");
  return filePath;
}

export function readTextMirror(hash: string): string | null {
  const filePath = path.join(getKnowledgeTextDir(), `${hash}.txt`);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

export function deleteTextMirror(hash: string): void {
  const filePath = path.join(getKnowledgeTextDir(), `${hash}.txt`);
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}

export function deleteStoredFile(filePath: string): boolean {
  if (!filePath || !existsSync(filePath)) return false;

  const storageDir = getKnowledgeStorageDir();
  if (!existsSync(storageDir)) return false;

  let realStorageDir: string;
  let realTarget: string;
  try {
    realStorageDir = realpathSync(storageDir);
    realTarget = realpathSync(filePath);
  } catch {
    return false;
  }

  if (!realTarget.startsWith(`${realStorageDir}${path.sep}`)) return false;

  rmSync(filePath);
  return true;
}

export function computeFileHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
