import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { getPythonPath, getBundledPluginRoot } from "../lib/runtime/paths.ts";
import { getSkillSdkConfig } from "../lib/agent/skills-store.ts";
import { ALLOWED_TOOLS, BUILTIN_TOOLS } from "../lib/agent/tools/registry.ts";

// 自写 xlsx skill + Pi 加载配置。行为测试优先:真实跑 recalc.py。
export const skillXlsxTestPromise = (async () => {
  const pluginRoot = getBundledPluginRoot();
  const skillDir = path.join(pluginRoot, "skills", "xlsx");
  const recalcScript = path.join(skillDir, "scripts", "recalc.py");
  const python = getPythonPath();

  // ── AC-X1: skill 结构合法 ──────────────────────────────────────────
  const skillMd = readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
  assert.match(skillMd, /^---[\s\S]*?\nname:\s*xlsx\b/m, "AC-X1 FAIL: SKILL.md frontmatter 应含 name: xlsx");
  assert.match(skillMd, /\ndescription:\s*\S/, "AC-X1 FAIL: SKILL.md 应有 description");
  assert.ok(existsSync(recalcScript), "AC-X1 FAIL: 应存在 scripts/recalc.py");
  assert.ok(!/没有LibreOffice\s*就跳过/.test(skillMd), "AC-X1 FAIL: SKILL 不得再写「没有 LibreOffice 就跳过」");
  assert.ok(!/没有 LibreOffice 就跳过/.test(skillMd), "AC-X1 FAIL: SKILL 不得再写跳过重算引导");
  // Forbid instructing the agent to run pip; mentioning "不要 pip" as a prohibition is ok.
  assert.ok(!/^\s*[-*].*pip install/im.test(skillMd), "AC-X1 FAIL: SKILL 不得引导 pip install");
  assert.ok(/Spreadsheet Runtime|产品.*Runtime|recalc_unavailable/.test(skillMd), "AC-X1 FAIL: SKILL 应指向产品 Runtime");

  // ── AC-X2: Pi 加载配置正确(内置 skill root + 支持工具)──────────────
  const cfg = await getSkillSdkConfig();
  // 内置 plugin 必注册且路径指向 agent-skills(用户技能 plugin 视机器状态可有可无)。
  assert.ok(cfg.plugins.length >= 1, "AC-X2 FAIL: 应至少注册内置本地 plugin");
  assert.equal(cfg.plugins[0].type, "local");
  assert.equal(cfg.plugins[0].path, pluginRoot, "AC-X2 FAIL: 首个 plugin 路径应指向内置 agent-skills");
  // skills 现为动态:干净态 'all',有用户技能/停用时为 plugin 限定名白名单数组。两者皆合法。
  assert.ok(cfg.skills === "all" || Array.isArray(cfg.skills), "AC-X2 FAIL: skills 应为 'all' 或白名单数组");
  assert.ok(BUILTIN_TOOLS.includes("Bash") && BUILTIN_TOOLS.includes("Write"), "AC-X2 FAIL: 内置工具定义需含 Bash/Write 供 skill 使用");
  assert.ok(!ALLOWED_TOOLS.includes("Bash") && !ALLOWED_TOOLS.includes("Write"), "AC-X2 FAIL: Bash/Write 不得被 SDK 自动放行");

  // ── AC-X3: recalc.py 缺文件时给结构化 JSON,不崩 ───────────────────
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-skill-xlsx-"));
  try {
    if (!existsSync(python)) {
      console.log("skill-xlsx: python 运行时缺失,跳过行为执行(结构检查已通过)⚠");
      return;
    }
    const out = execFileSync(python, [recalcScript, path.join(dir, "nope.xlsx")], { encoding: "utf-8" });
    const errReport = JSON.parse(out) as { error?: string };
    assert.ok(errReport.error && /不存在|does not exist/.test(errReport.error), "AC-X4 FAIL: 缺文件应给结构化错误");
    // Pi ResourceLoader 的真实发现与 ambient 隔离由 tests/pi/structure.mts 覆盖。

    console.log("skill-xlsx: all checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
