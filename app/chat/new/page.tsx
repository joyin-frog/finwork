import ChatPage from "@/app/chat/chat-page";
import { getChatQuickPrompts } from "@/lib/domain/tax-calendar";
import { readPublicClaudeSettings } from "@/lib/settings/claude-settings";
import { getSkill, isValidSkillName } from "@/lib/agent/skills-store";

export default async function NewChatPage({ searchParams }: { searchParams: Promise<{ prompt?: string; skill?: string }> }) {
  const params = await searchParams;
  // Next 已对 searchParams 解码;再 decode 会让含 % 的文本抛 URIError
  const initialSkill = params.skill && isValidSkillName(params.skill) ? await getSkill(params.skill) : null;
  const initialDraft = params.prompt || (initialSkill ? `/${initialSkill.name}${initialSkill.starter ? ` ${initialSkill.starter}` : ""}` : undefined);
  const settings = await readPublicClaudeSettings().catch(() => null);
  return <ChatPage key="chat:new" mode="new" quickPrompts={getChatQuickPrompts(new Date())} initialDraft={initialDraft} initialSkill={initialSkill ? { name: initialSkill.name, description: initialSkill.description } : undefined} roleMode={settings?.roleMode ?? "daily"} />;
}
