import ChatPage from "@/app/chat/chat-page";
import { readPublicAgentSettings } from "@/lib/settings/agent-settings";

export default async function RecentChatPage({
  searchParams,
}: {
  searchParams?: Promise<{ id?: string; mock?: string }>;
}) {
  const params = await searchParams;
  const initialConversationId = params?.id ? Number(params.id) : null;
  const settings = await readPublicAgentSettings().catch(() => null);

  const conversationId = Number.isFinite(initialConversationId) ? initialConversationId : null;
  const mockMode = params?.mock === "all";
  return <ChatPage key={`chat:recent:${mockMode ? "mock-all" : conversationId ?? "missing"}`} mode="recent" initialConversationId={conversationId} roleMode={settings?.roleMode ?? "daily"} mockMode={mockMode} />;
}
