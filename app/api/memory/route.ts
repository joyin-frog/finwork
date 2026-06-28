import { NextResponse } from "next/server";
import { readMemoryMarkdown, writeMemoryMarkdown } from "@/lib/memory/file-store";
import { ensureConventionsMigrated } from "@/lib/memory/migrate-conventions";
import { getMemoryPath } from "@/lib/runtime/paths";
import { existsSync, statSync } from "node:fs";

const MAX_BYTES = 64 * 1024;

export async function GET() {
  try {
    await ensureConventionsMigrated();
    const content = await readMemoryMarkdown();
    const filePath = getMemoryPath();
    const updatedAt = existsSync(filePath)
      ? new Date(statSync(filePath).mtimeMs).toISOString()
      : null;
    return NextResponse.json({ ok: true, data: { content, updatedAt } });
  } catch (error) {
    console.error("[memory] GET error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "读取失败" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).content !== "string") {
    return NextResponse.json({ ok: false, error: "content 字段必须为字符串" }, { status: 400 });
  }

  const content = (body as { content: string }).content;
  if (content.length > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `内容超过 64KB 上限(${content.length} 字节)` },
      { status: 400 }
    );
  }

  try {
    await writeMemoryMarkdown(content);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[memory] PUT error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "写入失败" },
      { status: 500 }
    );
  }
}
