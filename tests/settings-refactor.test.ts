/**
 * 设置页重构第一批(F5 容器/状态语言统一 + F6 保存心智统一)的源码契约测试:
 * - F5:SettingsCard 已删除,关于页改用 SettingsSection;model 页不再用 Badge/手拼 grid;
 *   profile 页 select 用统一 Select 组件、本地 fieldLabel 已删;环境页无 ✅/⚠ emoji。
 * - F6:自动保存状态按页面密度收敛;profile / memory 不再为状态单独占一行;
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

  // ── F5-2: model 页用共享设置原语(SettingsRow),不手拼 Badge/grid ────────
  // 注:后续迭代按用户要求把 model 页统一成 SettingsRow(标签左/控件右),
  // 并移除了「已配置✓/未配置」状态行(用户认为无需展示),故这里只校验仍用共享原语、不手拼布局。
  const model = src("app/config/model/model-settings.tsx");
  assert.ok(!model.includes("Badge"), "F5-2 FAIL: model-settings.tsx 不应再用 Badge");
  assert.ok(model.includes("SettingsRow"), "F5-2 FAIL: model 页应用共享的 SettingsRow 原语");
  assert.ok(!model.includes("grid grid-cols-2"), "F5-2 FAIL: model 页不应再手拼 grid");

  // ── F5-3: profile 页用共享 Select + SettingsRow,不再手写原生 select 样式 ──
  const profile = src("app/config/profile/profile-settings.tsx");
  assert.ok(!profile.includes("fieldLabel"), "F5-3 FAIL: profile 页本地 fieldLabel 应已删除");
  assert.ok(profile.includes("SettingsRow"), "F5-3 FAIL: profile 页应用共享的 SettingsRow 原语");
  assert.ok(
    profile.includes("SelectTrigger") && profile.includes("SelectContent") && profile.includes("SelectGroup") && profile.includes("SelectItem"),
    "F5-3 FAIL: 纳税人类型应使用项目已有的 shadcn Select 完整组合",
  );
  assert.ok(!profile.includes("<select") && !profile.includes("settingsSelectClass"), "F5-3 FAIL: profile 页不应继续使用原生 select 或手写 select class");

  // ── F5-4: 环境页状态不再用 emoji,统一文字 ────────────────────────────────
  const env = src("app/config/environment/environment-settings.tsx");
  assert.ok(!env.includes("✅") && !env.includes("⚠"), "F5-4 FAIL: 环境页不应再用 ✅/⚠ emoji");
  assert.ok(env.includes("已就绪 ✓"), "F5-4 FAIL: 环境页就绪状态应为统一文字表达");

  // ── F6-1: 共享保存状态组件保留给需要显式状态的设置项 ────────────────────
  assert.ok(settingsUi.includes("SaveStatusText"), "F6-1 FAIL: settings-ui.tsx 应导出共享 SaveStatusText");
  assert.ok(src("app/config/skill-center.tsx").includes("SaveStatusText"), "F6-1 FAIL: skill-center 应继续使用共享 SaveStatusText");

  // ── F6-2: 记忆页——去手动按钮、防抖自动存、超限暂停落盘且显式提示 ─────────
  const memory = src("app/config/memory/memory-settings.tsx");
  assert.ok(!memory.includes('from "@/components/ui/button"'), "F6-2 FAIL: 记忆页应已去掉手动保存按钮");
  assert.ok(memory.includes("setTimeout") && memory.includes("600"), "F6-2 FAIL: 记忆页应为防抖自动保存");
  assert.ok(
    />\s*MAX_BYTES\)\s*\{\s*pendingRef\.current = null;[^]*?return;/.test(memory),
    "F6-2 FAIL: 超过 64KB 时应暂停落盘(不发 PUT,也不留待卸载补发)",
  );
  assert.ok(memory.includes("自动保存已暂停"), "F6-2 FAIL: 超限时应显式告知已暂停保存(不可静默不存)");
  assert.ok(memory.includes("MAX_BYTES * 0.8"), "F6-2 FAIL: 字节计数应仅在超过 80% 时显示");
  assert.ok(memory.includes("keepalive: true"), "F6-2 FAIL: 卸载时应补发防抖窗口内未落盘的编辑(不可静默丢弃)");
  assert.ok(!memory.includes("SaveStatusText"), "F6-2 FAIL: 记忆区不应再为保存状态预留独立行");
  assert.ok(!memory.includes("上次更新"), "F6-2 FAIL: 记忆区不应显示上次更新时间状态行");
  assert.ok(
    memory.includes("border-0") && memory.includes("bg-transparent") && memory.includes("focus-visible:ring-0"),
    "F6-2 FAIL: 记忆文本域应去掉内框，只保留 SettingsSection 外框",
  );

  // ── F6-3: 公司画像不再用一整行展示更新时间/保存状态 ─────────────────────
  assert.ok(!profile.includes("SaveStatusText"), "F6-3 FAIL: 公司画像不应再渲染保存状态行");
  assert.ok(!profile.includes("上次更新"), "F6-3 FAIL: 公司画像不应再渲染上次更新时间行");
  assert.ok(profile.includes('toast.error("公司画像保存失败")'), "F6-3 FAIL: 删除状态行后保存失败仍应有可见提示");

  // ── F7: 设置页卡片边界收敛 ──────────────────────────────────────────────
  const shortcuts = src("app/config/shortcuts/shortcuts-settings.tsx");
  assert.ok(
    shortcuts.includes('className="-mx-4 flex flex-col"') && shortcuts.includes("px-4 py-2 border-b"),
    "F7-1 FAIL: 快捷键分隔线应延伸至卡片两侧，内容内边距放到行上",
  );
  assert.ok(
    about.includes('className="flex flex-col gap-3"') && !about.includes('</div>\n        <UpdaterBody />'),
    "F7-2 FAIL: 版本号与更新入口应共用一个内容项，Web 下不得留下空状态行",
  );
  const usageSettings = src("app/config/usage/usage-settings.tsx");
  const usageRing = src("app/chat/usage-ring.tsx");
  assert.ok(
    usageSettings.includes('className="flex w-full flex-col"') && !usageSettings.includes("max-w-md"),
    "F7-3 FAIL: 模型页用量内容应占满卡片可用宽度",
  );
  assert.ok(
    usageSettings.includes("<UsageDetail usage={usage} separated />")
      && usageRing.includes('"-mx-4 border-t border-border px-4 pt-3"'),
    "F7-3 FAIL: 两档额度之间应有延伸到卡片边缘的全宽分隔线",
  );

  console.log("settings-refactor: F5 容器/状态语言统一 + F6 保存心智统一 源码契约 ✓");
})();
