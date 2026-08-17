import { NextResponse } from "next/server";
import { authorizedByDesktop } from "@/lib/file-workspace/desktop-auth";
import { getFileWorkspaceStore } from "@/lib/file-workspace";

export async function GET(request: Request, { params }: { params: Promise<{ rootId: string }> }) {
  if (!await authorizedByDesktop(request)) {
    return NextResponse.json({ ok: false, error: "仅 Finwork 桌面端可以解析本地文件夹" }, { status: 403 });
  }
  try {
    const { rootId } = await params;
    const root = (await getFileWorkspaceStore()).getRoot(rootId);
    return NextResponse.json({ ok: true, data: { path: root.path } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}
