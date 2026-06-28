import { existsSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { getKnowledgeDocumentById } from "@/lib/db/sqlite";
import { buildSpreadsheetMirror } from "@/lib/knowledge/parsers";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * 表格行级映射:对原始 .xlsx 重跑同源的 buildSpreadsheetMirror,返回 lineMeta
 * (镜像第 i 行 → { sheet, row } 或 null)。供"搜索命中行 → 跳到原表对应行"。
 * 非表格 / 文件丢失 / 解析失败 → data.lineMeta = null(前端据此降级:只开文件、不跳)。
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const docId = Number(id);
  if (!Number.isFinite(docId) || docId < 1) {
    return NextResponse.json({ error: "无效的文档 ID" }, { status: 400 });
  }

  const doc = getKnowledgeDocumentById(docId);
  if (!doc) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }

  const isXlsx = doc.mime_type === XLSX_MIME || (doc.file_name ?? "").toLowerCase().endsWith(".xlsx");
  if (!isXlsx) {
    return NextResponse.json({ ok: true, data: { lineMeta: null } });
  }

  const filePath = doc.storage_path;
  if (!filePath || !existsSync(filePath)) {
    return NextResponse.json({ ok: true, data: { lineMeta: null } });
  }

  try {
    const { lineMeta } = await buildSpreadsheetMirror(filePath);
    return NextResponse.json({ ok: true, data: { lineMeta } });
  } catch {
    // 解析失败不报错——降级为"无映射",前端只打开文件、不跳行
    return NextResponse.json({ ok: true, data: { lineMeta: null } });
  }
}
