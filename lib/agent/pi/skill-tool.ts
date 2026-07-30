import { readFile } from "node:fs/promises";
import type { ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod/v4";
import type { TSchema } from "@earendil-works/pi-ai";

export function formatFinworkSkillListing(loader: ResourceLoader): string {
  const skills = loader.getSkills().skills.filter((skill) => !skill.disableModelInvocation);
  if (skills.length === 0) return "";
  return [
    "## 可用 Skills",
    "任务命中下列描述时，先调用 `Skill` 加载完整流程；未加载前不要凭 listing 猜步骤。",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

export function createPiSkillTool(loader: ResourceLoader): ToolDefinition | null {
  const skills = loader.getSkills().skills.filter((skill) => !skill.disableModelInvocation);
  if (skills.length === 0) return null;
  const names = skills.map((skill) => skill.name);
  const schema = z.object({
    skill: z.enum(names as [string, ...string[]]).describe("要加载的 Skill 名称"),
  });
  return {
    name: "Skill",
    label: "加载 Skill",
    description: "加载当前任务匹配的 Finwork Skill 完整流程、输入边界和完成证据。每个 Skill 每轮最多加载一次。",
    parameters: z.toJSONSchema(schema, {
      target: "draft-7",
      unrepresentable: "any",
    }) as TSchema,
    async execute(_toolCallId, rawArgs) {
      const { skill: skillName } = await schema.parseAsync(rawArgs);
      const skill = skills.find((candidate) => candidate.name === skillName);
      if (!skill) throw new Error(`Skill 不可用：${skillName}`);
      const markdown = await readFile(skill.filePath, "utf8");
      const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      return {
        content: [{
          type: "text",
          text: [
            `<skill name="${escapeXml(skill.name)}">`,
            `references/scripts 的相对路径基于：${skill.baseDir}`,
            body,
            "</skill>",
          ].join("\n"),
        }],
        details: { skill: skill.name },
      };
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
