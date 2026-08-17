import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { authorizedByDesktop } from "@/lib/file-workspace/desktop-auth";
import { getFileWorkspaceStore } from "@/lib/file-workspace";

const MAX_BYTES = 200 * 1024 * 1024;

export async function POST(request: Request) {
  if (!await authorizedByDesktop(request)) {
    return NextResponse.json({ ok: false, error: "本地文件只能从 Finwork 系统选择器导入" }, { status: 403 });
  }
  try {
    const body = await request.json() as { path?: string };
    if (!body.path || !path.isAbsolute(body.path)) throw new Error("文件路径无效");
    const source = await realpath(body.path);
    const info = await stat(source);
    if (!info.isFile()) throw new Error("选择的项目不是普通文件");
    if (info.size > MAX_BYTES) throw new Error("文件超过 200MB，请授权所在文件夹后按需读取");
    const store = await getFileWorkspaceStore();
    const asset = store.ingestManagedBuffer({
      name: path.basename(source),
      mediaType: guessMediaType(source),
      content: await readFile(source),
    });
    return NextResponse.json({ ok: true, data: { asset } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function guessMediaType(fileName: string): string {
  const media: Record<string, string> = {
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  return media[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}
