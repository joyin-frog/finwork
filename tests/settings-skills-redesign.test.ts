import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { injectSkillHint } from "../lib/agent/skill-hint.ts";
import { CONFIG_TABS, LEGACY_CONFIG_TAB_REDIRECTS } from "../app/config/tabs.ts";
import { isTelemetryDebugVisible } from "../app/config/environment/telemetry-settings.tsx";

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

  const catalog = read("app/config/skill-catalog.tsx");
  for (const name of capabilityNames) assert.ok(catalog.includes(`"${name}"`), `目录应包含 ${name}`);
  assert.ok(catalog.includes("/chat/new?skill="), "开始按钮应通过 URL 参数进入新聊天");
  assert.ok(!read("app/config/skill-center.tsx").includes("<SkillsManager"), "设置技能 tab 不应再内嵌 SkillsManager");

  const hinted = injectSkillHint([{ role: "user", content: "计算本月工资" }], ["payroll-calc"]);
  assert.match(hinted[0].content, /优先使用技能:payroll-calc/, "已钉技能发送后应注入 skill hint");
  assert.ok(read("app/chat/new/page.tsx").includes("initialSkill"), "聊天入口应读取并初始化技能");
  assert.ok(read("app/chat/chat-page.tsx").includes("initialSkill ? [initialSkill] : []"), "聊天输入框应复用现有 referencedSkills 状态");

  assert.deepEqual(CONFIG_TABS.map((tab) => tab.key), ["general", "model", "skills", "understanding", "about"], "设置应收敛为 5 个 tab");
  assert.deepEqual(LEGACY_CONFIG_TAB_REDIRECTS, {
    appearance: "general",
    memory: "understanding",
    profile: "understanding",
    usage: "about",
  }, "旧 tab key 应完整映射");
  assert.equal(isTelemetryDebugVisible("development"), true);
  assert.equal(isTelemetryDebugVisible("production"), false, "dev 外不得显示遥测调试区");
  assert.ok(!read("app/config/skill-center.tsx").includes('placeholder="搜索"'), "设置侧栏应删除搜索框");

  console.log("settings-skills-redesign checks passed ✓");
})();
