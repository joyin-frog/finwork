import { NextResponse } from "next/server";
import { getFileWorkspaceStore } from "@/lib/file-workspace";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const store = await getFileWorkspaceStore();
    const files = store.listAssets({
      q: url.searchParams.get("q") ?? undefined,
      rootId: url.searchParams.get("rootId") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 500),
    });
    return NextResponse.json({ ok: true, data: { files } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
