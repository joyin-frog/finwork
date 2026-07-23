import { readFileSync } from "node:fs";
import path from "node:path";

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".html": "text/html",
};

/** OOXML / ZIP 容器魔数 */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b]); // PK
/** OLE Compound Document（.xls/.doc） */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
/** PDF */
const PDF_MAGIC = Buffer.from("%PDF");

export function mimeFromExtension(fileName: string): string {
  return EXT_MIME[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

export type MimeProbe = {
  declaredMime: string;
  contentKind: "zip" | "ole" | "pdf" | "text" | "unknown";
  consistent: boolean;
};

/**
 * 内容签名 vs 扩展名一致性（防 MIME 伪装）。
 * 不声称完整 MIME sniff；只拦明显欺骗。
 */
export function probeMimeConsistency(filePath: string, fileName?: string): MimeProbe {
  const name = fileName ?? path.basename(filePath);
  const declaredMime = mimeFromExtension(name);
  const head = readFileSync(filePath).subarray(0, 16);
  let contentKind: MimeProbe["contentKind"] = "unknown";
  if (head.subarray(0, 2).equals(ZIP_MAGIC)) contentKind = "zip";
  else if (head.subarray(0, 4).equals(OLE_MAGIC)) contentKind = "ole";
  else if (head.subarray(0, 4).equals(PDF_MAGIC)) contentKind = "pdf";
  else if (isLikelyText(head)) contentKind = "text";

  const ext = path.extname(name).toLowerCase();
  let consistent = true;
  if ([".xlsx", ".xlsm", ".docx"].includes(ext)) {
    consistent = contentKind === "zip";
  } else if (ext === ".xls" || ext === ".doc") {
    consistent = contentKind === "ole";
  } else if (ext === ".pdf") {
    consistent = contentKind === "pdf";
  } else if ([".csv", ".txt", ".md", ".json", ".html"].includes(ext)) {
    // 允许 unknown（小文件）或 text
    consistent = contentKind === "text" || contentKind === "unknown";
  }
  return { declaredMime, contentKind, consistent };
}

function isLikelyText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let weird = 0;
  for (const b of buf) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) weird += 1;
  }
  return weird / buf.length < 0.15;
}

export const ALLOWED_DELIVERABLE_MIMES = new Set(Object.values(EXT_MIME));
