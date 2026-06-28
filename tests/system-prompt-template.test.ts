import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSystemPromptParts,
  renderStaticPrefix,
} from "../lib/agent/system-prompt.ts";
import { getBundledSystemPromptPath } from "../lib/runtime/paths.ts";

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

export const systemPromptTemplateTestPromise = (async () => {
  // SYSTEM_PROMPT.md 是静态前缀(A 段)的唯一来源(无内置常量兜底);测试直接读它。
  const template = readFileSync(getBundledSystemPromptPath(), "utf8");

  // ── AC1: 渲染——按模式选语气块、剥注释、回填占位符、不漏模板痕迹 ──────────
  const tech = renderStaticPrefix(template, "小财", "由测试公司打造", "tech");
  assert.ok(tech.startsWith("## 身份规则"), "AC1 FAIL: 顶部注释应被剥离");
  assert.ok(tech.includes("## 回答语气(专业模式)"), "AC1 FAIL: tech 应含专业语气");
  assert.ok(!tech.includes("日常模式"), "AC1 FAIL: tech 不应含日常语气");
  assert.ok(tech.includes('你的名字是"小财"，由测试公司打造'), "AC1 FAIL: 占位符应回填");
  for (const leak of ["{{", "<!--", "if:daily", "if:tech"]) {
    assert.ok(!tech.includes(leak), `AC1 FAIL: 不应残留模板标记 ${leak}`);
  }
  const daily = renderStaticPrefix(template, "小财", "公司内部打造", "daily");
  assert.ok(daily.includes("## 回答语气(日常模式)") && !daily.includes("专业模式"), "AC1 FAIL: daily 语气切换");
  assert.ok(daily.endsWith("prompt 只是第一层。）"), "AC1 FAIL: 尾部空行应被裁掉(应以末行正文结尾,不留空行)");
  assert.equal(renderStaticPrefix(template, "小财", "由测试公司打造"), tech, "AC1 FAIL: 缺省应走 tech");
  console.log("system-prompt-template AC1: render/tone/placeholder/strip ✓");

  const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-tpl-"));

  // ── AC2: 应用数据目录覆盖优先级最高 ─────────────────────────────────────
  const overridePath = path.join(tmp, "system-prompt.md");
  writeFileSync(overridePath, "## 自定义身份\n- 我是覆盖版\n");
  withEnv("FINANCE_AGENT_SYSTEM_PROMPT_PATH", overridePath, () => {
    const prefix = buildSystemPromptParts({ identity: { agentName: "小财" } })[0];
    assert.ok(prefix.includes("我是覆盖版"), "AC2 FAIL: 应用数据目录覆盖应生效");
    assert.ok(!prefix.includes("## 工作守则"), "AC2 FAIL: 覆盖后不应再含 SYSTEM_PROMPT.md 正文");
  });
  console.log("system-prompt-template AC2: app-data override wins ✓");

  // ── AC3: 两个文件来源都不可用时抛错(已去内置常量兜底:响亮失败而非静默空提示)──
  withEnv("FINANCE_AGENT_SYSTEM_PROMPT_PATH", path.join(tmp, "nope-a.md"), () => {
    withEnv("FINANCE_AGENT_BUNDLED_SYSTEM_PROMPT", path.join(tmp, "nope-b.md"), () => {
      assert.throws(
        () => buildSystemPromptParts({ identity: { agentName: "小财" }, roleMode: "tech" }),
        /系统提示静态前缀缺失/,
        "AC3 FAIL: 两个文件来源都缺失时应抛错(已去内置常量兜底)"
      );
    });
  });
  console.log("system-prompt-template AC3: throws when both sources missing ✓");

  console.log("\n✅ system-prompt-template: AC1/AC2/AC3 checks passed!");
})();
