import type { ResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * Skill 清单注入（L4 起改为 pi 原生形态）。
 *
 * 此前这里还有一个自建的 `Skill` 工具：入参是技能名枚举，内部 `readFile` 正文。
 * 它存在的唯一原因是 `noTools: "builtin"` 关掉了 `read`，而 pi 的技能机制依赖 `read`。
 * L4 打开只读内置工具后它就多余了，且它有个实打实的缺陷：
 *
 * 它把 `baseDir` 告诉模型、让模型去看 `references/`、`scripts/`，
 * **但模型没有任何工具读得到那些文件**（读闸只放行会话目录）。仓库里有 216 个
 * 非 SKILL.md 的技能文件、5 个 SKILL.md 明确引用它们——渐进披露一直是断的。
 *
 * 现在：清单直接给出 SKILL.md 的绝对路径，模型用 `read` 读正文，
 * 再按正文里的相对路径继续 `read` 其引用文件。读闸放行技能根目录（只读）。
 */
export function formatFinworkSkillListing(loader: ResourceLoader): string {
  const skills = loader.getSkills().skills.filter((skill) => !skill.disableModelInvocation);
  if (skills.length === 0) return "";
  return [
    "## 可用 Skills",
    "任务命中下列描述时，先用 `read` 读该 Skill 的 SKILL.md 加载完整流程；未加载前不要凭 listing 猜步骤。",
    "SKILL.md 里引用的 references/、scripts/ 等相对路径，基于该文件所在目录，同样用 `read` 读取。",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <path>${escapeXml(skill.filePath)}</path>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
