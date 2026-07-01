import { isValidSkillName } from "@/lib/agent/skills-store";

/** 单条消息里最多注入的技能数(防滥用/超长 prompt)。 */
const MAX_SKILLS = 8;

/**
 * 把用户引用的技能作为"优先使用这些技能"的提示,注入到最后一条 user 消息。
 * - 只校验过合法技能名、限量 MAX_SKILLS;非法名丢弃。
 * - 返回新数组(不原地修改入参);无有效技能或无 user 消息时原样返回(同引用)。
 * - 注意只改发给 agent 的副本,调用方的已落库原文不受影响。
 */
export function injectSkillHint<T extends { role: string; content: string }>(
  messages: T[],
  skillNames: string[],
): T[] {
  const valid = skillNames.filter((n) => typeof n === "string" && isValidSkillName(n)).slice(0, MAX_SKILLS);
  if (valid.length === 0) return messages;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;

  const hint = `\n\n[系统提示] 用户为本条消息指定优先使用技能:${valid.join("、")}。如适用,请通过 Skill 工具加载对应技能并遵循其说明。`;
  return messages.map((m, i) => (i === lastUserIdx ? { ...m, content: m.content + hint } : m));
}
