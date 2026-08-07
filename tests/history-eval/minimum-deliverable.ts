import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { HistoricalFinanceCase } from "./cases";

export function checkMinimumDeliverables(
  contract: HistoricalFinanceCase["taskContract"],
  outputDir: string,
): { ok: boolean; message?: string } {
  const files = listCandidateFiles(outputDir);
  const missing: string[] = [];
  for (const required of contract.requiredDeliverables) {
    const candidates = files.filter((file) => mimeType(file) === required.mime);
    const valid = candidates.some((file) => isStructurallyValidCandidate(file, required.mime));
    if (!valid) missing.push(`${required.id}(${required.mime})`);
  }
  return missing.length === 0
    ? { ok: true }
    : {
        ok: false,
        message: `缺少最小可交付文件：${missing.join("、")}。请先生成真实、可打开的候选文件，再调用 finalize_deliverable。`,
      };
}

function mimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf": "application/pdf",
    ".png": "image/png",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

function listCandidateFiles(root: string): string[] {
  const result: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else result.push(full);
    }
  };
  walk(root, 0);
  return result;
}

function isStructurallyValidCandidate(filePath: string, mime: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size < 256) return false;
    const head = readFileSync(filePath).subarray(0, 8);
    if (mime.includes("spreadsheetml") || mime.includes("wordprocessingml")) {
      return head[0] === 0x50 && head[1] === 0x4b;
    }
    if (mime === "application/pdf") return head.toString("ascii", 0, 4) === "%PDF";
    return true;
  } catch {
    return false;
  }
}
