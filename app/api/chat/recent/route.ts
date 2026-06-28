import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  countChatConversations,
  deleteChatConversation,
  getChatConversation,
  listRecentChatConversations,
  listRecentConversationSummaries,
  migrateKeptAttachmentsBeforeConversationDelete,
  setConversationPinned,
  updateChatConversationTitle
} from "@/lib/db/sqlite";
import { syncGeneratedAttachments } from "@/lib/chat/generated-files";
import { getConversationFilesDir, getAppDataDir } from "@/lib/runtime/paths";

function getLibraryDir() {
  return path.join(getAppDataDir(), "files", "library");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const idParam = url.searchParams.get("id");

  // Single-conversation lookup: GET /api/chat/recent?id=N
  if (idParam && !mode) {
    const id = Number(idParam);
    if (!id) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    const conversation = getChatConversation(id);
    if (!conversation) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    syncGeneratedAttachments(id);
    return NextResponse.json({ ok: true, data: { conversation } });
  }

  const total = countChatConversations();

  if (mode === "summaries") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 50);
    const offset = Number(url.searchParams.get("offset")) || 0;
    const summaries = listRecentConversationSummaries(limit, offset);
    return NextResponse.json({
      ok: true,
      data: { summaries, total, hasMore: offset + limit < total }
    });
  }

  const expanded = url.searchParams.get("expanded") === "true";
  const limit = expanded ? Math.max(total, 10) : 10;
  let conversations = listRecentChatConversations(limit);
  let needsRefresh = false;
  for (const conversation of conversations) {
    needsRefresh = syncGeneratedAttachments(conversation.id) > 0 || needsRefresh;
  }
  if (needsRefresh) conversations = listRecentChatConversations(limit);

  return NextResponse.json({
    ok: true,
    data: {
      conversations,
      total,
      hasMore: total > 10 && !expanded
    }
  });
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { id: number; action: string; title?: string; pinned?: boolean };

    if (body.action === "rename" && body.title?.trim()) {
      updateChatConversationTitle(body.id, body.title.trim());
      return NextResponse.json({ ok: true });
    }

    if (body.action === "pin") {
      setConversationPinned(body.id, body.pinned ?? false);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    if (!id) return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });

    // 生命周期解耦(spec C):删对话前,先把 kept=1 的附件迁到库目录。
    // 迁移失败则报错,不继续删除(保护用户文件)。
    try {
      migrateKeptAttachmentsBeforeConversationDelete(
        id,
        getConversationFilesDir,
        getLibraryDir()
      );
    } catch (migrateError) {
      return NextResponse.json(
        { ok: false, error: `保留文件迁移失败,对话未删除: ${migrateError instanceof Error ? migrateError.message : String(migrateError)}` },
        { status: 500 }
      );
    }

    deleteChatConversation(id);

    // Clean up on-disk files (已保留文件已迁出,只删未保留的)
    try {
      await fs.rm(getConversationFilesDir(id), { recursive: true, force: true });
    } catch { /* directory may not exist */ }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
