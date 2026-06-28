import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAppDataDir, getKnowledgeTextDir } from "@/lib/runtime/paths";

export { getKnowledgeTextDir };

export function getKnowledgeStorageDir(): string {
  return process.env.FINANCE_AGENT_KNOWLEDGE_DIR ?? path.join(getAppDataDir(), "knowledge");
}

export function writeUploadedFile(hash: string, buffer: Buffer, ext: string): string {
  const dir = getKnowledgeStorageDir();
  mkdirSync(dir, { recursive: true });
  const fileName = `${hash}${ext ? (ext.startsWith(".") ? ext : `.${ext}`) : ""}`;
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, buffer);
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

export function deleteStoredFile(filePath: string): void {
  if (filePath && existsSync(filePath)) {
    rmSync(filePath);
  }
}

export function computeFileHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
