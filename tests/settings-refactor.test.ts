/**
 * 设置页重构第一批(F5 容器/状态语言统一 + F6 保存心智统一)的源码契约测试:
 * - F5:SettingsCard 已删除,关于页改用 SettingsSection;model 页不再用 Badge/手拼 grid;
 *   profile 页 select 用 settingsSelectClass、本地 fieldLabel 已删;环境页无 ✅/⚠ emoji。
 * - F6:共享 SaveStatusText 组件被 profile / skill-center / memory 使用;
 *   记忆页去手动保存按钮改防抖自动存,超 64KB 暂停落盘且有显式红色提示,
 *   字节计数仅在超过 80% 时显示。
 *
 * 运行方式:FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/settings-refactor.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

export const settingsRefactorTestPromise = (async () => {
  // ── F5-1: SettingsCard 组件已删除,关于页改用 SettingsSection ─────────────
  const settingsUi = src("app/config/settings-ui.tsx");
  assert.ok(!settingsUi.includes("SettingsCard"), "F5-1 FAIL: settings-ui.tsx 应已删除 SettingsCard");
  const about = src("app/config/about/about-settings.tsx");
  assert.ok(!about.includes("SettingsCard"), "F5-1 FAIL: about-settings.tsx 不应再用 SettingsCard");
  assert.ok(about.includes("SettingsSection"), "F5-1 FAIL: about-settings.tsx 应改用 SettingsSection");

  // ── F5-2: model 页改用 SettingsRow/SettingsField,Badge 换文字状态 ────────
  const model = src("app/config/model/model-settings.tsx");
  assert.ok(!model.includes("Badge"), "F5-2 FAIL: model-settings.tsx 不应再用 Badge");
  assert.ok(model.includes("SettingsField") && model.includes("SettingsRow"), "F5-2 FAIL: model 页应用 SettingsRow/SettingsField");
  assert.ok(!model.includes("grid grid-cols-2"), "F5-2 FAIL: model 页不应再手拼 grid");
  assert.ok(model.includes("已配置 ✓") && model.includes("未配置"), "F5-2 FAIL: API Key 状态应为统一文字表达");

  // ── F5-3: profile 页用 settingsSelectClass + SettingsField,本地 fieldLabel 已删 ──
  const profile = src("app/config/profile/profile-settings.tsx");
  assert.ok(profile.includes("settingsSelectClass"), "F5-3 FAIL: profile 页 select 应用 settingsSelectClass");
  assert.ok(!profile.includes("fieldLabel"), "F5-3 FAIL: profile 页本地 fieldLabel 应已删除");
  assert.ok(profile.includes("SettingsField"), "F5-3 FAIL: profile 页应改用 SettingsField");

  // ── F5-4: 环境页状态不再用 emoji,统一文字 ────────────────────────────────
  const env = src("app/config/environment/environment-settings.tsx");
  assert.ok(!env.includes("✅") && !env.includes("⚠"), "F5-4 FAIL: 环境页不应再用 ✅/⚠ emoji");
  assert.ok(env.includes("已就绪 ✓"), "F5-4 FAIL: 环境页就绪状态应为统一文字表达");

  // ── F6-1: 共享保存状态组件,三处消费 ─────────────────────────────────────
  assert.ok(settingsUi.includes("SaveStatusText"), "F6-1 FAIL: settings-ui.tsx 应导出共享 SaveStatusText");
  for (const rel of ["app/config/profile/profile-settings.tsx", "app/config/skill-center.tsx", "app/config/memory/memory-settings.tsx"]) {
    assert.ok(src(rel).includes("SaveStatusText"), `F6-1 FAIL: ${rel} 应使用共享 SaveStatusText`);
  }

  // ── F6-2: 记忆页——去手动按钮、防抖自动存、超限暂停落盘且显式提示 ─────────
  const memory = src("app/config/memory/memory-settings.tsx");
  assert.ok(!memory.includes('from "@/components/ui/button"'), "F6-2 FAIL: 记忆页应已去掉手动保存按钮");
  assert.ok(memory.includes("setTimeout") && memory.includes("600"), "F6-2 FAIL: 记忆页应为防抖自动保存");
  assert.ok(/>\s*MAX_BYTES\)\s*return/.test(memory), "F6-2 FAIL: 超过 64KB 时应暂停落盘(不发 PUT)");
  assert.ok(memory.includes("自动保存已暂停"), "F6-2 FAIL: 超限时应显式告知已暂停保存(不可静默不存)");
  assert.ok(memory.includes("MAX_BYTES * 0.8"), "F6-2 FAIL: 字节计数应仅在超过 80% 时显示");

  console.log("settings-refactor: F5 容器/状态语言统一 + F6 保存心智统一 源码契约 ✓");
})();
