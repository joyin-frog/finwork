import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { getPythonPath, getBundledPluginRoot } from "../lib/runtime/paths.ts";
import { getSkillPluginConfig } from "../lib/agent/skill-plugin.ts";
import { ALLOWED_TOOLS } from "../lib/agent/tools/registry.ts";

// 自写 xlsx skill(SDK 原生 plugin)+ 加载配置。行为测试优先:真实跑 recalc.py。
export const skillXlsxTestPromise = (async () => {
  const pluginRoot = getBundledPluginRoot();
  const skillDir = path.join(pluginRoot, "skills", "xlsx");
  const recalcScript = path.join(skillDir, "scripts", "recalc.py");
  const python = getPythonPath();

  // ── AC-X1: plugin 结构合法 ─────────────────────────────────────────
  const pluginJson = JSON.parse(readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf-8"));
  assert.equal(typeof pluginJson.name, "string", "AC-X1 FAIL: plugin.json 应有 name");
  const skillMd = readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
  assert.match(skillMd, /^---[\s\S]*?\nname:\s*xlsx\b/m, "AC-X1 FAIL: SKILL.md frontmatter 应含 name: xlsx");
  assert.match(skillMd, /\ndescription:\s*\S/, "AC-X1 FAIL: SKILL.md 应有 description");
  assert.ok(existsSync(recalcScript), "AC-X1 FAIL: 应存在 scripts/recalc.py");

  // ── AC-X2: SDK 加载配置正确(内置 plugin + 隔离 ambient + 支持工具)──
  const cfg = getSkillPluginConfig();
  assert.equal(cfg.plugins.length, 1, "AC-X2 FAIL: 应注册一个本地 plugin");
  assert.equal(cfg.plugins[0].type, "local");
  assert.equal(cfg.plugins[0].path, pluginRoot, "AC-X2 FAIL: plugin 路径应指向内置 agent-skills");
  assert.equal(cfg.skills, "all", "AC-X2 FAIL: 隔离下 skills 应为 'all'(内置 plugin 有啥加载啥)");
  assert.deepEqual(cfg.settingSources, [], "AC-X2 FAIL: 应隔离 ambient skill(settingSources: [])");
  assert.ok(ALLOWED_TOOLS.includes("Bash") && ALLOWED_TOOLS.includes("Write"), "AC-X2 FAIL: 静态工具全集需含 Bash/Write 供 skill 脚本");

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
    // 注:SDK 真实发现 / ambient 隔离的集成测试统一在 skill-plugin.test.ts(动态读 plugin 目录,加 skill 无需改断言)。

    console.log("skill-xlsx: all checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
