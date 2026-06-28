import { existsSync } from "node:fs";
import path from "node:path";

export function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").replace(/\.\./g, "_").replace(/^\.+/, "_").trim() || "untitled";
}

export function uniqueFilePath(dir: string, fileName: string): string {
  const safeName = sanitizeFileName(fileName);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext) || "untitled";
  let candidate = path.join(dir, `${base}${ext}`);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${base} ${index}${ext}`);
    index += 1;
  }
  return candidate;
}
