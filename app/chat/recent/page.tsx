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

  return <ChatPage mode="recent" initialConversationId={Number.isFinite(initialConversationId) ? initialConversationId : null} roleMode={settings?.roleMode ?? "daily"} />;
}
