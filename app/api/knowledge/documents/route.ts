import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listKnowledgeDocuments, getKnowledgeDocumentByHash, insertAuditLog } from "@/lib/db/sqlite";
import { ingestDocument } from "@/lib/knowledge/pipeline";
import { computeFileHash, writeUploadedFile } from "@/lib/knowledge/storage";
import type { KnowledgeCategory } from "@/lib/knowledge/types";

export async function GET(req: NextRequest) {
  const category = req.nextUrl.searchParams.get("category") ?? "all";
  const docs = listKnowledgeDocuments(category !== "all" ? category : undefined);
  return NextResponse.json({ ok: true, data: { documents: docs } });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const title = formData.get("title") as string | null;
    const rawCategory = formData.get("category");
    const category = typeof rawCategory === "string" && rawCategory
      ? rawCategory as KnowledgeCategory
      : undefined;

    if (!file) return NextResponse.json({ ok: false, error: "缺少文件" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = computeFileHash(buffer);

    // ─── 内容哈希判重(A 功能) ───────────────────────────────────────────────
    const overwrite = formData.get("overwrite") === "true";
    const existing = getKnowledgeDocumentByHash(hash);

    if (existing && !overwrite) {
      // 已存在同 hash → 不入库,返回存在信号供前端弹框
      return NextResponse.json({
        ok: true,
        exists: true,
        existingId: existing.id,
        existingTitle: existing.title,
      });
    }

    const ext = path.extname(file.name);
    const storagePath = writeUploadedFile(hash, buffer, ext);

    // also write to tmp for parsing (parsers need a file path)
    const tmpDir = mkdtempSync(path.join(tmpdir(), "knowledge-upload-"));
    const tmpPath = path.join(tmpDir, path.basename(file.name) || "upload.bin");
    writeFileSync(tmpPath, buffer);

    let result;
    try {
      result = await ingestDocument({
        filePath: tmpPath,
        title: title || file.name,
        fileName: file.name,
        mimeType: file.type || "text/plain",
        category,
        sizeBytes: file.size,
        storagePath,
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // 落审计:覆盖更新时记录(红线 8)
    if (existing && overwrite) {
      insertAuditLog("knowledge_overwrite", {
        existingId: existing.id,
        existingTitle: existing.title,
        newTitle: title || file.name,
        contentHash: hash,
        at: new Date().toISOString(),
      });
    }

    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
