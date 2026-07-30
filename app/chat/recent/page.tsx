import ChatPage from "@/app/chat/chat-page";
import { readPublicAgentSettings } from "@/lib/settings/agent-settings";

export default async function RecentChatPage({
  searchParams,
}: {
  searchParams?: Promise<{ id?: string }>;
}) {
  const params = await searchParams;
  const initialConversationId = params?.id ? Number(params.id) : null;
  const settings = await readPublicAgentSettings().catch(() => null);

  const conversationId = Number.isFinite(initialConversationId) ? initialConversationId : null;
  return <ChatPage key={`chat:recent:${conversationId ?? "missing"}`} mode="recent" initialConversationId={conversationId} roleMode={settings?.roleMode ?? "daily"} />;
}
