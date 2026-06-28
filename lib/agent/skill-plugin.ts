import { getBundledPluginRoot } from "@/lib/runtime/paths";

/**
 * SDK 原生 skill 加载配置。
 *
 * 把内置 plugin 目录(agent-skills/)交给 SDK 的渐进式加载:listing 只占 name+description,
 * 正文/scripts 经 Skill 工具按需加载——取代手写 lib/skills 的全量注入。
 *
 * - settingSources: [] 隔离 ambient skill(用户 ~/.claude、~/.agents 下的 skill 不应渗进本 app),
 *   保证分发到任意客户机时只加载我们内置的 plugin,行为确定。
 * - skills: 'all' 在隔离下 = 内置 plugin 里有什么就加载什么(逐个 skill 写完即生效,无需维护名单)。
 */
export function getSkillPluginConfig(): {
  plugins: { type: "local"; path: string }[];
  skills: "all";
  settingSources: [];
} {
  return {
    plugins: [{ type: "local", path: getBundledPluginRoot() }],
    skills: "all",
    settingSources: [],
  };
}
