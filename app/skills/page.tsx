import { SkillsManager } from "@/app/skills/skills-manager";

export const dynamic = "force-dynamic";

// 技能主页(卡片首页):入口=主导航「技能」一级项。卡片点进 /skills/[name] 详情二级页读 SKILL.md/编辑文件。
export default function SkillsPage() {
  return <SkillsManager />;
}
