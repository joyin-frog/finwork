import path from "node:path";
import type {
  InlineExtension,
  ResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildStaticSystemPrompt, type SystemPromptContext } from "@/lib/agent/system-prompt";
import { getSkillSdkConfig } from "@/lib/agent/skills-store";
import { formatFinworkSkillListing } from "@/lib/agent/pi/skill-tool";

/**
 * Finwork-owned Pi resource loader.
 *
 * Ambient Pi resources are disabled. Only Finwork's bundled/user skill roots
 * and the existing system-prompt SSOT enter the product session.
 */
/**
 * 技能根目录（内置 + 用户插件）。与 loader 的 `additionalSkillPaths` 同一份映射，
 * 供 L4 的读闸放行——技能正文与其 `references/`、`scripts/` 都在这些目录下。
 */
export async function resolveFinworkSkillRoots(): Promise<string[]> {
  const skillConfig = await getSkillSdkConfig();
  return skillConfig.plugins.map((plugin) => path.join(plugin.path, "skills"));
}

export async function createFinworkPiResourceLoader(options: {
  cwd: string;
  agentDir: string;
  promptContext?: SystemPromptContext;
  systemPrompt?: string;
  skillNames?: string[];
  settingsManager?: SettingsManager;
  /** Finwork 自有内联扩展。`noExtensions` 只压制磁盘发现，不影响这里。 */
  extensionFactories?: InlineExtension[];
}): Promise<ResourceLoader> {
  const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
  const skillConfig = await getSkillSdkConfig();
  const enabled =
    skillConfig.skills === "all"
      ? null
      : new Set(skillConfig.skills.map((name) => name.split(":").at(-1) ?? name));
  const roleSkills = options.skillNames ? new Set(options.skillNames) : null;
  if (!options.systemPrompt && !options.promptContext) {
    throw new Error("Pi resource loader requires systemPrompt or promptContext");
  }
  // L3a：这里只放静态前缀（可缓存）。动态段由 extension 的 `before_agent_start` 每回合追加，
  // 拼出的最终提示词与改动前逐字一致。角色会话传入的是完整自定义提示词，本就没有动态段。
  const systemPrompt =
    options.systemPrompt ?? buildStaticSystemPrompt(options.promptContext!);
  const loader: ResourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    noExtensions: true,
    extensionFactories: options.extensionFactories,
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    systemPromptOverride: (base) => {
      const listing = formatFinworkSkillListing(loader);
      return [base, listing].filter(Boolean).join("\n\n");
    },
    additionalSkillPaths: skillConfig.plugins.map((plugin) => path.join(plugin.path, "skills")),
    skillsOverride: (base) => ({
      skills: base.skills.filter(
        (skill) =>
          (!enabled || enabled.has(skill.name)) &&
          (!roleSkills || roleSkills.has(skill.name)),
      ),
      diagnostics: base.diagnostics,
    }),
  });
  await loader.reload();
  return loader;
}
