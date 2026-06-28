import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getProjectRoot, getPythonPath } from "@/lib/runtime/paths";

export async function parseDocument(filePath: string, mimeType: string): Promise<string> {
  if (mimeType === "text/plain" || mimeType === "text/markdown" || mimeType.startsWith("text/")) {
    return readFileSync(filePath, "utf-8");
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel"
  ) {
    // 旧版二进制 .xls 不再支持(exceljs 仅读 .xlsx);提示用户另存,避免回退到有已知漏洞的解析库。
    if (mimeType === "application/vnd.ms-excel" || filePath.toLowerCase().endsWith(".xls")) {
      throw new Error("暂不支持旧版 .xls 格式入库，请用 Excel/WPS 打开后『另存为 .xlsx』再上传。");
    }
    return parseXlsxDocument(filePath);
  }

  // PDF / PPT(.pptx)走 python worker 抽文本(worker 按扩展名分发)
  if (
    mimeType === "application/pdf" ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return extractViaWorker(filePath);
  }

  if (mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp") {
    return parseImageDocument(filePath);
  }

  throw new Error(`不支持的文件类型：${mimeType}`);
}

async function parseXlsxDocument(filePath: string): Promise<string> {
  return (await buildSpreadsheetMirror(filePath)).text;
}

/** 表格行级元信息:镜像第 i 行来自哪个工作表的第几行(exceljs rowNumber,1 基);
 *  `## 工作表名` 标题行为 null。与 text.split("\n") 严格对齐——靠"1 数据行 = 1 镜像行"
 *  不变量(单元格值里的换行已被 formatCellValue 压平),否则行号会错位。 */
export type SpreadsheetLineMeta = { sheet: string; row: number } | null;

/**
 * 单一真相:同一遍同时产出「文本镜像」(供 ripgrep 检索)与「逐行 → (工作表,行号) 映射」
 * (供"搜索命中 → 跳到原表对应行")。两者必须由本函数一并生成,严禁两处各写一遍——
 * 否则镜像口径一改、映射就指错行。入库只取 .text;预览侧用 .lineMeta 把命中行号映射回原表行。
 */
export async function buildSpreadsheetMirror(
  filePath: string
): Promise<{ text: string; lineMeta: SpreadsheetLineMeta[] }> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const parts: string[] = [];
  const lineMeta: SpreadsheetLineMeta[] = [];
  wb.eachSheet((ws) => {
    parts.push(`## ${ws.name}`);
    lineMeta.push(null);
    const headerCells = (ws.getRow(1).values as unknown[]) ?? [];
    const headers = headerCells.slice(1).map((h) => formatCellValue(h)); // exceljs values 从下标 1 开始
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cells = (row.values as unknown[]) ?? [];
      const line = headers
        .map((header, i) => {
          const value = formatCellValue(cells[i + 1]);
          return value !== "" ? `${header}: ${value}` : "";
        })
        .filter(Boolean)
        .join("，");
      if (line) {
        parts.push(line);
        lineMeta.push({ sheet: ws.name, row: rowNumber });
      }
    });
  });
  return { text: parts.join("\n"), lineMeta };
}

/** PDF 行级元信息:镜像第 i 行属于第几页;`--- Page N ---` 标记行与空行为 null。 */
export type PdfLineMeta = { page: number } | null;

/**
 * 从 PDF 文本镜像解析"逐行 → 页码"映射(供"搜索命中 → 跳到原文那一页")。
 * 镜像由 worker extract_pdf 产出,页与页间以 `--- Page N ---` 标记分隔(见 workers/finance_worker.py)。
 * 直接解析存好的镜像文本(即检索所依据的文本),无需重跑 worker,行号天然对齐;对老 PDF 同样生效。
 */
export function buildPdfPageMap(mirrorText: string): PdfLineMeta[] {
  const pageMarker = /^--- Page (\d+) ---$/;
  let page = 0;
  return mirrorText.split("\n").map((line) => {
    const m = line.match(pageMarker);
    if (m) { page = Number(m[1]); return null; } // 标记行本身不归属任何页
    if (line.trim() === "") return null;          // 页间空行
    return page > 0 ? { page } : null;
  });
}

/** 取可读单元格文本,并把换行压成空格——保证"1 数据行 = 1 镜像行"(lineMeta 对齐的前提)。 */
function formatCellValue(value: unknown): string {
  return rawCellValue(value).replace(/[\r\n]+/g, " ");
}

/** exceljs 单元格值可能是富文本/公式/超链接/日期对象,统一取可读文本 */
function rawCellValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const v = value as { result?: unknown; text?: unknown; richText?: Array<{ text?: string }>; hyperlink?: string };
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text ?? "").join("");
    if (v.result != null) return String(v.result);
    if (v.text != null) return String(v.text);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (v.hyperlink) return String(v.hyperlink);
    return "";
  }
  return String(value);
}

async function extractViaWorker(filePath: string): Promise<string> {
  const output = execFileSync(
    getPythonPath(),
    [path.join(getProjectRoot(), "workers/finance_worker.py"), "extract-text", filePath],
    { encoding: "utf-8" }
  );
  return output.trim();
}

function parseImageDocument(filePath: string): string {
  try {
    const output = execFileSync(
      getPythonPath(),
      [path.join(getProjectRoot(), "workers/finance_worker.py"), "ocr-image", filePath],
      { encoding: "utf-8" }
    );
    return output.trim();
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string; message?: string };
    const stderr = e.stderr ?? "";
    const hint = stderr.trim() || e.message || "未知错误";
    throw new Error(`图片识别失败：${hint}`);
  }
}
