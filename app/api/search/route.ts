import { NextRequest, NextResponse } from "next/server";
import { searchFilesByTitle, searchConversations, recentConversationsForSearch } from "@/lib/db/sqlite";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  // 空查询:默认展示最近对话(供全局搜索打开即见)
  if (q.length < 1) {
    return NextResponse.json({ ok: true, data: { files: [], conversations: recentConversationsForSearch() } });
  }
  return NextResponse.json({
    ok: true,
    // 独立「对话文件」页已移除;全局搜索只展示仍有落点的知识库文档。
    data: { files: searchFilesByTitle(q).filter((file) => file.kind === "knowledge"), conversations: searchConversations(q) },
  });
}
