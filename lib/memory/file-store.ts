import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { getMemoryPath } from "@/lib/runtime/paths";

const MAX_BYTES = 64 * 1024; // 64 KB

export async function readMemoryMarkdown(filePath = getMemoryPath()): Promise<string> {
  if (!existsSync(filePath)) return "";
  try {
    const text = await readFile(filePath, "utf-8");
    if (text.length > MAX_BYTES) {
      console.warn(`[memory] memory.md is ${text.length} bytes, truncating to ${MAX_BYTES}`);
      return text.slice(0, MAX_BYTES);
    }
    return text;
  } catch (err) {
    console.warn("[memory] failed to read memory.md", err);
    return "";
  }
}

/** 原子写：tmp + rename，保证读方永远只看到旧内容或新内容。 */
async function atomicWrite(filePath: string, text: string): Promise<void> {
  mkdirSync(filePath.substring(0, filePath.lastIndexOf("/")), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, text, "utf-8");
  await rename(tmpPath, filePath);
}

/** 进程内串行写队列，防止并发 PUT 互相覆盖。 */
let writeQueue: Promise<void> = Promise.resolve();

export async function writeMemoryMarkdown(text: string, filePath = getMemoryPath()): Promise<void> {
  const task = writeQueue.catch(() => undefined).then(() => atomicWrite(filePath, text));
  writeQueue = task;
  return task;
}

/**
 * 在 memory.md 中找到指定标题节（如 `## 工作约定`）并追加一行。
 * 节不存在时自动在末尾创建。并发安全：经串行队列。
 */
export async function appendToMemorySection(
  sectionTitle: string,
  line: string,
  filePath = getMemoryPath()
): Promise<void> {
  const task = writeQueue.catch(() => undefined).then(async () => {
    const current = await readMemoryMarkdown(filePath);
    const updated = insertIntoSection(current, sectionTitle, line);
    await atomicWrite(filePath, updated);
  });
  writeQueue = task;
  return task;
}

/** 纯函数：在 markdown 文本中找到节并追加行，节不存在则创建。 */
function insertIntoSection(content: string, sectionTitle: string, line: string): string {
  const sectionLine = sectionTitle.startsWith("##") ? sectionTitle : `## ${sectionTitle}`;
  // 匹配同级或更高级标题（## 或 #）作为节结束标志
  const sectionRegex = new RegExp(
    `(${escapeRegex(sectionLine)}[\\s\\S]*?)(\n##? |$)`,
    "m"
  );

  // 尝试找到已有节
  const sectionMatch = sectionRegex.exec(content);
  if (sectionMatch) {
    // 在该节末尾追加（在下一个同级标题前，或文档末尾）
    const sectionStart = sectionMatch.index;
    const sectionEnd = sectionStart + sectionMatch[1].length;
    const before = content.slice(0, sectionEnd).trimEnd();
    const after = content.slice(sectionEnd);
    return `${before}\n${line}${after}`;
  }

  // 节不存在，追加到末尾
  const trimmed = content.trimEnd();
  return trimmed
    ? `${trimmed}\n\n${sectionLine}\n${line}`
    : `${sectionLine}\n${line}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从约定行里抽出"约定文本":去掉 `- [date] ` 前缀、合并空白。 */
function conventionText(line: string): string {
  return line
    .replace(/^\s*-\s*(?:\[\d{4}-\d{2}-\d{2}\]\s*)?/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 归一化文本用于匹配:剥首部 # 标记、合并空白、trim。 */
function normalizeForMatch(s: string): string {
  return s.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
}

/** 纯函数:对某节的正文行做编辑(传入节内行、返回新行);节不存在时原样返回。 */
function editSection(content: string, sectionTitle: string, edit: (lines: string[]) => string[]): string {
  const head = (sectionTitle.startsWith("##") ? sectionTitle : `## ${sectionTitle}`).trim();
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === head);
  if (start === -1) return content;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  }
  const body = edit(lines.slice(start + 1, end));
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join("\n");
}

/** 约定文本是否命中 match(归一化后相等,或长度≥4 时互为子串)。 */
function conventionMatches(line: string, normalizedMatch: string): boolean {
  if (!line.trim().startsWith("-")) return false;
  const ct = normalizeForMatch(conventionText(line));
  if (!ct) return false;
  return ct === normalizedMatch
    || (Math.min(ct.length, normalizedMatch.length) >= 4 && (ct.includes(normalizedMatch) || normalizedMatch.includes(ct)));
}

/**
 * 修订某节的条目约定:可删(removeMatch,按约定文本归一化匹配)可加(addLine,先去重同文本)。
 * 删+加在同一次读改写里完成(经串行队列,并发安全)。返回实际删/加了什么,供调用方如实复述,
 * 不再"只会追加"导致矛盾条目累积(见红线 3/4)。
 */
export async function reviseMemorySection(
  sectionTitle: string,
  opts: { addLine?: string; removeMatch?: string },
  filePath = getMemoryPath()
): Promise<{ removed: string[]; added: string | null }> {
  const task = writeQueue.catch(() => undefined).then(async () => {
    let content = await readMemoryMarkdown(filePath);
    const removed: string[] = [];

    const m = normalizeForMatch(opts.removeMatch ?? "");
    if (m) {
      content = editSection(content, sectionTitle, (rows) =>
        rows.filter((row) => {
          const hit = conventionMatches(row, m);
          if (hit) removed.push(conventionText(row));
          return !hit;
        })
      );
    }

    let added: string | null = null;
    if (opts.addLine) {
      const addCt = normalizeForMatch(conventionText(opts.addLine));
      // 去重:同约定文本已存在就先删掉旧的,避免重复累积
      content = editSection(content, sectionTitle, (rows) =>
        rows.filter((row) => !(row.trim().startsWith("-") && normalizeForMatch(conventionText(row)) === addCt))
      );
      content = insertIntoSection(content, sectionTitle, opts.addLine);
      added = conventionText(opts.addLine);
    }

    await atomicWrite(filePath, content);
    return { removed, added };
  });
  writeQueue = task.then(() => undefined, () => undefined);
  return task;
}
