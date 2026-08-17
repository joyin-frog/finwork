import { NextResponse } from "next/server";
import { getFileWorkspaceStore } from "@/lib/file-workspace";

const MAX_BYTES = 50 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    if (!files.length) return NextResponse.json({ ok: false, error: "没有文件" }, { status: 400 });
    const store = await getFileWorkspaceStore();
    const batchId = crypto.randomUUID();
    const assets = [];
    for (const file of files) {
      if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: `${file.name} 超过 50MB；请改为授权所在文件夹` }, { status: 413 });
      assets.push(store.ingestManagedBuffer({
        name: file.name,
        mediaType: file.type || "application/octet-stream",
        content: new Uint8Array(await file.arrayBuffer()),
        batchId,
      }));
    }
    return NextResponse.json({ ok: true, data: { assets } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
