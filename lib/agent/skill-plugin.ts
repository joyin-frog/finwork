import { getSkillSdkConfig } from "@/lib/agent/skills-store";

/**
 * SDK 原生 skill 加载配置。
 *
 * 把内置 plugin 目录(agent-skills/)+ 用户可写 plugin(user-skills/)交给 SDK 的渐进式加载:
 * listing 只占 name+description,正文/scripts 经 Skill 工具按需加载。
 *
 * - settingSources: [] 隔离 ambient skill(用户 ~/.claude、~/.agents 下的 skill 不应渗进本 app),
 *   保证分发到任意客户机时只加载我们的 plugin,行为确定。
 * - plugins/skills 由 skills-store 计算:干净态= [内置] + 'all'(行为同改造前);
 *   有用户技能/停用时= [内置,用户] + plugin 限定名白名单(详见 getSkillSdkConfig)。
 */
export async function getSkillPluginConfig(): Promise<{
  plugins: { type: "local"; path: string }[];
  skills: string[] | "all";
  settingSources: [];
}> {
  const { plugins, skills } = await getSkillSdkConfig();
  return { plugins, skills, settingSources: [] };
}
