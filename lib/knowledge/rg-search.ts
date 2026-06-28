import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { getKnowledgeTextDir } from "@/lib/knowledge/storage";
import { getRgPath } from "@/lib/knowledge/rg-binary";
import { listActiveKnowledgeDocuments, markKnowledgeHits } from "@/lib/db/sqlite";

type RgJsonEvent =
  | { type: "begin"; data: { path: { text: string } } }
  | { type: "match"; data: { path: { text: string }; lines: { text: string }; line_number: number; submatches: Array<{ start: number; end: number }> } }
  | { type: "context"; data: { path: { text: string }; lines: { text: string }; line_number: number } }
  | { type: "end"; data: { path: { text: string } } }
  | { type: "summary"; data: unknown };

export interface SearchMatch {
  lineNo: number;
  line: string;
  before: string[];
  after: string[];
  ranges: Array<[number, number]>;
}

export interface SearchFile {
  docId: number;
  title: string;
  fileName: string;
  category: string;
  hitCount: number;
  matches: SearchMatch[];
  /** 查询命中了文档标题/文件名(正文 rg 不搜文件名,由 mergeTitleAndRank 补齐) */
  titleHit?: boolean;
}

type DocMeta = { id: number; title: string; fileName: string; category: string };

export interface SearchResult {
  ok: true;
  data: {
    files: SearchFile[];
    totalFiles: number;
    truncated: boolean;
    elapsedMs: number;
  };
}

export interface SearchError {
  ok: false;
  error: string;
}

export type RgSearchOutput = SearchResult | SearchError;

const MATCH_LIMIT_PER_FILE = 10;

function buildDocMap(): Map<string, { id: number; title: string; fileName: string; category: string }> {
  const map = new Map<string, { id: number; title: string; fileName: string; category: string }>();
  try {
    const docs = listActiveKnowledgeDocuments();
    for (const d of docs) {
      map.set(d.content_hash, { id: d.id, title: d.title, fileName: d.file_name, category: d.category });
    }
  } catch {
    // db not initialized
  }
  return map;
}

export async function searchKnowledge(opts: {
  query: string;
  topK?: number;
}): Promise<RgSearchOutput> {
  const { query, topK = 20 } = opts;
  const textDir = getKnowledgeTextDir();

  if (!existsSync(textDir)) {
    return { ok: true, data: { files: [], totalFiles: 0, truncated: false, elapsedMs: 0 } };
  }

  const start = Date.now();

  // 财务用户的关键词搜索固定按字面量匹配(--fixed-strings),不暴露正则;
  // agent 的正则/多步需求由 query_knowledge 承接。
  const args: string[] = ["--json", "-n", "-C", "5", "-i", "--fixed-strings"];

  const parts = query.split(" OR ");
  if (parts.length > 1) {
    for (const p of parts) {
      args.push("-e", p.trim());
    }
  } else {
    args.push(query);
  }

  args.push(textDir);

  const result = await runRg(args);
  const elapsedMs = Date.now() - start;

  if (result.error) {
    return { ok: false, error: result.error };
  }

  const docMap = buildDocMap();
  const fileMap = new Map<string, SearchFile>();

  ingestRgEvents(result.events, docMap, fileMap);

  // P3 召回兜底:精确短语 0 命中时,用「空白分词 + CJK 2-gram」OR 重试(只在 0 命中触发,
  // 精确命中路径不变、不损精度)。让"招待费上限"也能召回含"招待费"的文档。
  if (fileMap.size === 0 && !query.includes(" OR ")) {
    const fbTerms = buildFallbackTerms(query);
    if (fbTerms.length > 0) {
      const fbArgs = ["--json", "-n", "-C", "5", "-i", "--fixed-strings"];
      for (const t of fbTerms) fbArgs.push("-e", t);
      fbArgs.push(textDir);
      const fbResult = await runRg(fbArgs);
      if (!fbResult.error) ingestRgEvents(fbResult.events, docMap, fileMap);
    }
  }

  // 标题/文件名命中补齐 + 分层排序(标题命中优先 → 正文命中)
  const { files: returned, totalFiles, truncated } = mergeTitleAndRank(fileMap, docMap, query, topK);

  // 命中埋点:UI 搜索与 agent 搜索都经此函数,在此统一记录使用信号(空结果不计)
  if (returned.length > 0) {
    try {
      markKnowledgeHits(returned.map((f) => f.docId));
    } catch {
      // 埋点失败不影响检索结果
    }
  }

  return {
    ok: true,
    data: {
      files: returned,
      totalFiles,
      truncated,
      elapsedMs,
    },
  };
}

/**
 * 把"标题/文件名命中"并入正文命中,并分层排序。
 * 正文 rg 只搜文件内容,搜不到文件名;此处补齐:标题命中的文档即使正文零命中也召回,
 * 并排在正文命中之前(标题命中是强相关信号)。纯函数,便于单测。
 */
export function mergeTitleAndRank(
  fileMap: Map<string, SearchFile>,
  docMap: Map<string, DocMeta>,
  query: string,
  topK: number
): { files: SearchFile[]; totalFiles: number; truncated: boolean } {
  const terms = parseQueryTerms(query);
  for (const [hash, doc] of docMap) {
    const hit = terms.some((t) => doc.title.toLowerCase().includes(t) || doc.fileName.toLowerCase().includes(t));
    if (!hit) continue;
    const existing = fileMap.get(hash);
    if (existing) {
      existing.titleHit = true;
    } else {
      fileMap.set(hash, { docId: doc.id, title: doc.title, fileName: doc.fileName, category: doc.category, hitCount: 0, matches: [], titleHit: true });
    }
  }

  const all = Array.from(fileMap.values()).sort((a, b) => {
    const at = a.titleHit ? 1 : 0;
    const bt = b.titleHit ? 1 : 0;
    if (at !== bt) return bt - at; // 标题命中优先
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount; // 再按正文命中数
    return a.title.localeCompare(b.title);
  });

  return {
    files: all.slice(0, topK),
    totalFiles: all.length,
    truncated: all.some((f) => f.hitCount > MATCH_LIMIT_PER_FILE),
  };
}

/** 解析查询词:支持 "A OR B",否则整串作为单个字面量;统一小写、去空。 */
function parseQueryTerms(query: string): string[] {
  return (query.includes(" OR ") ? query.split(" OR ") : [query]).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/** 把 rg 的 match/context 事件收集进 fileMap(命中计数 + 上下文);primary 与兜底召回共用。 */
function ingestRgEvents(events: RgJsonEvent[], docMap: Map<string, DocMeta>, fileMap: Map<string, SearchFile>): void {
  for (const ev of events) {
    if (ev.type !== "match") continue;
    const hash = path.basename(ev.data.path.text, ".txt");
    const doc = docMap.get(hash);
    if (!doc) continue;
    let sf = fileMap.get(hash);
    if (!sf) {
      sf = { docId: doc.id, title: doc.title, fileName: doc.fileName, category: doc.category, hitCount: 0, matches: [] };
      fileMap.set(hash, sf);
    }
    sf.hitCount++;
    if (sf.matches.length < MATCH_LIMIT_PER_FILE) {
      // rg 的 submatch start/end 是 UTF-8「字节」偏移;前端按 JS 字符下标 slice/高亮,
      // 中文行(1 字=3 字节)直接用会滑到后面的字符上(高亮到数字)。这里换算成字符偏移。
      const lineText = ev.data.lines.text;
      const lineBuf = Buffer.from(lineText, "utf8");
      const byteToChar = (byteOff: number) => lineBuf.subarray(0, byteOff).toString("utf8").length;
      sf.matches.push({
        lineNo: ev.data.line_number,
        line: lineText,
        before: [],
        after: [],
        ranges: ev.data.submatches.map((sm) => [byteToChar(sm.start), byteToChar(sm.end)] as [number, number]),
      });
    }
  }
  for (const ev of events) {
    if (ev.type !== "context") continue;
    const hash = path.basename(ev.data.path.text, ".txt");
    const sf = fileMap.get(hash);
    if (!sf) continue;
    for (const m of sf.matches) {
      const dist = ev.data.line_number - m.lineNo;
      if (dist >= -5 && dist < 0) m.before.push(ev.data.lines.text);
      else if (dist > 0 && dist <= 5) m.after.push(ev.data.lines.text);
    }
  }
}

/** 0 命中兜底词:空白/标点分词(≥2 字)+ 连续 CJK 串的 2-gram;上限 12,避免命令过长。 */
function buildFallbackTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const t of query.split(/[\s,，。;；、:：]+/)) {
    const s = t.trim();
    if (s.length >= 2) terms.add(s);
  }
  for (const run of query.match(/[一-龥]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms].slice(0, 12);
}

function runRg(args: string[]): Promise<{ events: RgJsonEvent[]; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(getRgPath(), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const events: RgJsonEvent[] = [];
    let buf = "";
    let errorBuf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as RgJsonEvent);
        } catch {
          // skip malformed JSON lines
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errorBuf += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        resolve({ events });
      } else {
        if (errorBuf.includes("command not found") || errorBuf.includes("ENOENT")) {
          resolve({ events: [], error: "rg not installed" });
        } else {
          resolve({ events: [], error: errorBuf.trim() || `rg exited with code ${code}` });
        }
      }
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ events: [], error: "rg not installed" });
      } else {
        resolve({ events: [], error: err.message });
      }
    });
  });
}
