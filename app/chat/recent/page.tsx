import ChatPage from "@/app/chat/chat-page";
import { readPublicClaudeSettings } from "@/lib/settings/claude-settings";

export default async function RecentChatPage({
  searchParams,
}: {
  searchParams?: Promise<{ id?: string }>;
}) {
  const params = await searchParams;
  const initialConversationId = params?.id ? Number(params.id) : null;
  const settings = await readPublicClaudeSettings().catch(() => null);

  const conversationId = Number.isFinite(initialConversationId) ? initialConversationId : null;
  return <ChatPage key={`chat:recent:${conversationId ?? "missing"}`} mode="recent" initialConversationId={conversationId} roleMode={settings?.roleMode ?? "daily"} />;
}
