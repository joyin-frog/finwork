import { NextResponse } from "next/server";
import { getFileWorkspaceStore } from "@/lib/file-workspace";
import { authorizedByDesktop } from "@/lib/file-workspace/desktop-auth";
import type { WorkspaceRootRef } from "@/lib/file-workspace/types";

export async function GET() {
  try {
    const store = await getFileWorkspaceStore();
    return NextResponse.json({ ok: true, data: { roots: store.listRoots().map(publicRoot) } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!await authorizedByDesktop(request)) {
      return NextResponse.json({ ok: false, error: "文件夹授权只能从 Finwork 桌面选择器发起" }, { status: 403 });
    }
    const body = await request.json() as {
      path?: string;
      permission?: "read" | "read_write";
      writePolicy?: "output_subdir" | "confirm_replace";
      outputSubdir?: string;
      maxFiles?: number;
    };
    if (!body.path) return NextResponse.json({ ok: false, error: "缺少文件夹路径" }, { status: 400 });
    const store = await getFileWorkspaceStore();
    const root = store.registerRoot({
      path: body.path,
      permission: body.permission,
      writePolicy: body.writePolicy,
      outputSubdir: body.outputSubdir,
    });
    const index = store.indexRoot(root.rootId, { maxFiles: body.maxFiles });
    return NextResponse.json({ ok: true, data: { root: publicRoot(root), index } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function publicRoot(root: WorkspaceRootRef) {
  return {
    rootId: root.rootId,
    name: root.name,
    permission: root.permission,
    writePolicy: root.writePolicy,
    outputSubdir: root.outputSubdir,
  };
}
