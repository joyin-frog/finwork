import path from "node:path";
import type {
  ResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildSystemPromptParts, type SystemPromptContext } from "@/lib/agent/system-prompt";
import { getSkillSdkConfig } from "@/lib/agent/skills-store";
import { formatFinworkSkillListing } from "@/lib/agent/pi/skill-tool";

/**
 * Finwork-owned Pi resource loader.
 *
 * Ambient Pi resources are disabled. Only Finwork's bundled/user skill roots
 * and the existing system-prompt SSOT enter the product session.
 */
export async function createFinworkPiResourceLoader(options: {
  cwd: string;
  agentDir: string;
  promptContext?: SystemPromptContext;
  systemPrompt?: string;
  skillNames?: string[];
  settingsManager?: SettingsManager;
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
  const systemPrompt =
    options.systemPrompt ??
    buildSystemPromptParts(options.promptContext!).join("\n\n");
  const loader: ResourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    noExtensions: true,
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
