import ChatPage from "@/app/chat/chat-page";
import { getChatQuickPrompts } from "@/lib/domain/tax-calendar";
import { readPublicClaudeSettings } from "@/lib/settings/claude-settings";
import { getSkill, isValidSkillName } from "@/lib/agent/skills-store";
import { getRoleDefinition } from "@/lib/agent/roles/registry";

export default async function NewChatPage({ searchParams }: { searchParams: Promise<{ prompt?: string; skill?: string; role?: string }> }) {
  const params = await searchParams;
  // Next 已对 searchParams 解码;再 decode 会让含 % 的文本抛 URIError
  const initialSkill = params.skill && isValidSkillName(params.skill) ? await getSkill(params.skill) : null;
  const initialDraft = params.prompt || (initialSkill ? `/${initialSkill.name}${initialSkill.starter ? ` ${initialSkill.starter}` : ""}` : undefined);
  // 专员会话（E 刀）：role 参数校验后传入;未知/未启用角色忽略（回落主管会话——否则 UI 宣称的
  // 角色边界与服务端实际回落的主管权限不一致）,服务端创建会话时再校验一次
  const roleDef = params.role ? getRoleDefinition(params.role) : undefined;
  const specialistRole = roleDef?.available ? roleDef : undefined;
  const settings = await readPublicClaudeSettings().catch(() => null);
  return (
    <ChatPage
      key={specialistRole ? `chat:new:${specialistRole.id}` : "chat:new"}
      mode="new"
      quickPrompts={specialistRole ? undefined : getChatQuickPrompts(new Date())}
      initialDraft={initialDraft}
      initialSkill={initialSkill ? { name: initialSkill.name, description: initialSkill.description } : undefined}
      initialRole={specialistRole ? { id: specialistRole.id, name: specialistRole.name } : undefined}
      roleMode={settings?.roleMode ?? "daily"}
    />
  );
}
