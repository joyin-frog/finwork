import assert from "node:assert/strict";
import path from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { getBundledPluginRoot, getProjectRoot } from "../lib/runtime/paths.ts";
import { getSkillPluginConfig } from "../lib/agent/skill-plugin.ts";

// SDK 原生加载的集成测试:动态读内置 plugin 目录,断言 SDK 恰好发现这些 skill、且不渗入 ambient。
// 加新 skill(pdf/docx/pptx…)后无需改本测试。仅走 SDK 控制通道(supportedCommands),不发消息给 LLM。
export const skillPluginTestPromise = (async () => {
  const skillsDir = path.join(getBundledPluginRoot(), "skills");
  const bundledSkills = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
  assert.ok(bundledSkills.length >= 1, "AC-P1 FAIL: 内置 plugin 至少应有 1 个 skill");

  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const q = sdk.query({
    prompt: "noop",
    options: {
      cwd: getProjectRoot(),
      tools: { type: "preset", preset: "claude_code" },
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-noop-test" },
      ...(await getSkillPluginConfig()),
    },
  });
  try {
    const names = (await q.supportedCommands()).map((c: { name: string }) => c.name);

    // AC-P2: 每个内置 skill 恰好被发现一次(隔离下无 ambient 重复)
    for (const skill of bundledSkills) {
      const count = names.filter((n) => n === skill).length;
      assert.equal(count, 1, `AC-P2 FAIL: 内置 skill '${skill}' 应被恰好发现 1 次(实得 ${count})`);
    }

    // AC-P3: 隔离生效——不在内置 plugin 里的 ambient skill 不应渗入
    const ambientSuspects = ["docx", "pptx", "skill-creator", "write-a-skill", "frontend-design"];
    for (const amb of ambientSuspects) {
      if (!bundledSkills.includes(amb)) {
        assert.ok(!names.includes(amb), `AC-P3 FAIL: ambient skill '${amb}' 渗入了(settingSources 隔离失效)`);
      }
    }

    console.log(`skill-plugin: SDK 发现内置 skills [${bundledSkills.join(", ")}],隔离生效 ✓`);
  } finally {
    try { await q.interrupt(); } catch { /* noop */ }
  }
})();
