import { NextResponse } from "next/server";
import { getFileWorkspaceStore } from "@/lib/file-workspace";

export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    const { versionId } = await params;
    const store = await getFileWorkspaceStore();
    const version = store.getVersion(versionId);
    if (!version.blobId) throw new Error("version not materialized");
    const bytes = store.readVersion(version.versionId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": version.mediaType,
        "content-length": String(bytes.byteLength),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(version.name)}`,
        "cache-control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
