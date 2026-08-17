import { NextResponse } from "next/server";
import { getFileWorkspaceStore } from "@/lib/file-workspace";

export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const { assetId } = await params;
    const store = await getFileWorkspaceStore();
    const current = store.getAsset(assetId);
    const asset = current.blobId ? current : store.snapshotAsset(assetId);
    const bytes = store.readVersion(asset.versionId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": asset.mediaType,
        "content-length": String(bytes.byteLength),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
