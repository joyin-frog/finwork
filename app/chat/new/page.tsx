import ChatPage from "@/app/chat/chat-page";
import { getChatQuickPrompts } from "@/lib/domain/tax-calendar";
import { readPublicAgentSettings } from "@/lib/settings/agent-settings";
import { getSkill, isValidSkillName } from "@/lib/agent/skills-store";
import { getRoleDefinition } from "@/lib/agent/roles/registry";
import { getDisabledRoleIds } from "@/lib/agent/roles/availability";

export default async function NewChatPage({ searchParams }: { searchParams: Promise<{ prompt?: string; skill?: string; role?: string; mock?: string }> }) {
  const params = await searchParams;
  // Next 已对 searchParams 解码;再 decode 会让含 % 的文本抛 URIError
  const initialSkill = params.skill && isValidSkillName(params.skill) ? await getSkill(params.skill) : null;
  const initialDraft = params.prompt || (initialSkill ? `/${initialSkill.name}${initialSkill.starter ? ` ${initialSkill.starter}` : ""}` : undefined);
  // 专员会话（E 刀）：未知/未启用/已停用均不进专员 UI（与服务端 fail-closed 一致，避免头宣称专员、实际主管）
  const roleDef = params.role ? getRoleDefinition(params.role) : undefined;
  const disabled = new Set(getDisabledRoleIds());
  const specialistRole = roleDef?.available && !disabled.has(roleDef.id) ? roleDef : undefined;
  const settings = await readPublicAgentSettings().catch(() => null);
  const mockMode = params.mock === "all";
  return (
    <ChatPage
      key={specialistRole ? `chat:new:${specialistRole.id}` : "chat:new"}
      mode="new"
      quickPrompts={specialistRole ? undefined : getChatQuickPrompts(new Date())}
      initialDraft={initialDraft}
      initialSkill={initialSkill ? { name: initialSkill.name, description: initialSkill.description } : undefined}
      initialRole={specialistRole ? { id: specialistRole.id, name: specialistRole.name } : undefined}
      roleMode={settings?.roleMode ?? "daily"}
      mockMode={mockMode}
    />
  );
}
