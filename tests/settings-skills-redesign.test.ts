import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { injectSkillHint } from "../lib/agent/skill-hint.ts";
import { CONFIG_TABS, LEGACY_CONFIG_TAB_REDIRECTS } from "../app/config/tabs.ts";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

export const settingsSkillsRedesignTestPromise = (async () => {
  const capabilityNames = [
    "business-analysis", "contract-extract", "finance-analysis", "kingdee-draft",
    "payroll-calc", "reimbursement-check", "rnd-deduction-check", "tax-incentive",
  ];
  const allBundledNames = [...capabilityNames, "xlsx", "pdf", "docx", "pptx"];

  for (const name of allBundledNames) {
    const skill = read(`agent-skills/skills/${name}/SKILL.md`);
    assert.match(skill, /^requires:\s*.+$/m, `${name} 应声明 requires`);
  }

  // 技能目录已从设置弹窗搬到主导航,直接指向独立的 /skills 编辑器页面。
  assert.ok(!read("app/config/skill-center.tsx").includes("<SkillsManager"), "设置弹窗不应内嵌 SkillsManager");
  assert.ok(read("app/shared/app-nav.tsx").includes('href="/skills"'), "主导航应有指向 /skills 的技能入口");

  const hinted = injectSkillHint([{ role: "user", content: "计算本月工资" }], ["payroll-calc"]);
  assert.match(hinted[0].content, /优先使用技能:payroll-calc/, "已钉技能发送后应注入 skill hint");
  assert.ok(read("app/chat/new/page.tsx").includes("initialSkill"), "聊天入口应读取并初始化技能");
  assert.ok(read("app/chat/chat-page.tsx").includes("initialSkill ? [initialSkill] : []"), "聊天输入框应复用现有 referencedSkills 状态");

  assert.deepEqual(
    CONFIG_TABS.map((tab) => tab.key),
    ["general", "appearance", "personalization", "model", "shortcuts", "about"],
    "设置应拆分为 6 个 tab"
  );
  assert.deepEqual(LEGACY_CONFIG_TAB_REDIRECTS, {
    understanding: "personalization",
    memory: "personalization",
    profile: "personalization",
    usage: "model",
  }, "旧 tab key 应完整映射");
  assert.ok(read("app/config/skill-center.tsx").includes('placeholder="搜索设置..."'), "设置侧栏应保留搜索框");

  console.log("settings-skills-redesign checks passed ✓");
})();
