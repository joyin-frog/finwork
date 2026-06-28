import ChatPage from "@/app/chat/chat-page";
import { getChatQuickPrompts } from "@/lib/domain/tax-calendar";
import { readPublicClaudeSettings } from "@/lib/settings/claude-settings";

export default async function NewChatPage({ searchParams }: { searchParams: Promise<{ prompt?: string }> }) {
  const params = await searchParams;
  // Next 已对 searchParams 解码;再 decode 会让含 % 的文本抛 URIError
  const initialDraft = params.prompt || undefined;
  const settings = await readPublicClaudeSettings().catch(() => null);
  return <ChatPage mode="new" quickPrompts={getChatQuickPrompts(new Date())} initialDraft={initialDraft} roleMode={settings?.roleMode ?? "daily"} />;
}
