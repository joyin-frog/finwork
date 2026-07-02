import { SkillsManager } from "@/app/skills/skills-manager";

export const dynamic = "force-dynamic";

// 独立全屏技能页:不在导航(v3 降权决定不变),入口=设置技能 tab 的「全屏打开」与深链。
// 弹窗里读 SKILL.md 憋屈(~620px),全屏页解决阅读空间,导航照旧干净。
export default function SkillsPage() {
  return <SkillsManager />;
}
