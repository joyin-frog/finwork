/**
 * nav-v3.test.ts — 导航契约测试（随导航演进更新）
 *
 * 覆盖契约 5-7（导航结构）。注:cockpit-v3 曾把「技能」移出导航、让 /skills 重定向到 /config、
 * 并保留设置内的 skill-catalog 能力目录;后续迭代按用户要求把「技能」升为一级导航项(独立卡片页,
 * /skills 渲染 SkillsManager 不再重定向)、删除 skill-catalog.tsx、并把「资料」改名「知识库」指向
 * /knowledge。本测试已同步到当前契约:
 * 契约 5 — app/shared/app-nav.tsx：「智能体」href="/agents"(总览之后)；「技能」href="/skills" 为一级项；
 *           新对话/总览/知识库(/knowledge)/技能(/skills)/设置 保留
 * 契约 6 — app/skills/page.tsx 渲染 SkillsManager(卡片首页,不再重定向);skill-catalog.tsx 已删除
 * 契约 7 — app/shared/app-shell.tsx：active 映射含 "/agents"
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/nav-v3.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(ROOT, rel));
}

export const navV3TestPromise = (async () => {
  // ── 契约 5a: app-nav.tsx 含「智能体」项 href="/agents" ─────────────────────
  {
    const navSrc = src("app/shared/app-nav.tsx");
    assert.ok(
      navSrc.includes('href="/agents"'),
      "C5a FAIL: app-nav.tsx 应含「智能体」导航项 href=\"/agents\""
    );
    assert.ok(
      navSrc.includes("智能体"),
      "C5a FAIL: app-nav.tsx 应含「智能体」文案"
    );
  }

  // ── 契约 5b: 「智能体」项位于总览之后（indexOf 顺序断言）───────────────────
  {
    const navSrc = src("app/shared/app-nav.tsx");
    // 用 href 锚点做顺序判断（比文案更稳定）
    const cockpitHrefIdx = navSrc.indexOf('href="/cockpit"');
    const agentsHrefIdx = navSrc.indexOf('href="/agents"');
    assert.ok(
      cockpitHrefIdx !== -1,
      "C5b FAIL: app-nav.tsx 应含 href=\"/cockpit\"（总览项）"
    );
    assert.ok(
      agentsHrefIdx !== -1,
      "C5b FAIL: app-nav.tsx 应含 href=\"/agents\"（智能体项）"
    );
    assert.ok(
      cockpitHrefIdx < agentsHrefIdx,
      `C5b FAIL: 「总览」href（pos ${cockpitHrefIdx}）应先于「智能体」href（pos ${agentsHrefIdx}）——智能体应在总览之后`
    );
  }

  // ── 契约 5c: 「技能」为一级导航项（导航区含 href="/skills"）─────────────────
  {
    const navSrc = src("app/shared/app-nav.tsx");
    assert.ok(
      navSrc.includes('href="/skills"'),
      "C5c FAIL: app-nav.tsx 应含 href=\"/skills\" 导航项（「技能」已升为一级项）"
    );
    assert.ok(
      navSrc.includes("技能"),
      "C5c FAIL: app-nav.tsx 应含「技能」文案"
    );
  }

  // ── 契约 5d: 保留项核验——新对话/总览/知识库(/knowledge)/技能/设置 ───────────
  {
    const navSrc = src("app/shared/app-nav.tsx");
    assert.ok(
      navSrc.includes('href="/chat/new"'),
      "C5d FAIL: app-nav.tsx 应保留「新对话」导航项 href=\"/chat/new\""
    );
    assert.ok(
      navSrc.includes('href="/cockpit"'),
      "C5d FAIL: app-nav.tsx 应保留「总览」导航项 href=\"/cockpit\""
    );
    // 「资料」已改名「知识库」并指向 /knowledge
    assert.ok(
      navSrc.includes('href="/knowledge"') && navSrc.includes("知识库"),
      "C5d FAIL: app-nav.tsx 应含「知识库」导航项 href=\"/knowledge\"（原「资料」已改名并改指 /knowledge）"
    );
    // 设置（/config）
    assert.ok(
      navSrc.includes('href="/config"'),
      "C5d FAIL: app-nav.tsx 应保留设置入口 href=\"/config\""
    );
  }

  // ── 契约 6: /skills 渲染 SkillsManager 卡片首页（不再重定向）;skill-catalog 已删 ──
  {
    assert.ok(
      exists("app/skills/page.tsx"),
      "C6 FAIL: app/skills/page.tsx 应存在（/skills 卡片首页）"
    );
    const skillsPageSrc = src("app/skills/page.tsx");
    assert.ok(
      skillsPageSrc.includes("SkillsManager"),
      "C6 FAIL: app/skills/page.tsx 应渲染 SkillsManager（技能卡片首页）"
    );
    assert.ok(
      !skillsPageSrc.includes('redirect('),
      "C6 FAIL: /skills 不应再重定向（已是真实卡片页）"
    );
    // 旧的设置内技能能力目录 skill-catalog.tsx 已删除（技能改由 /skills 一级页承接）
    assert.ok(
      !exists("app/config/skill-catalog.tsx"),
      "C6 FAIL: app/config/skill-catalog.tsx 应已删除（技能能力已迁到 /skills）"
    );
  }

  // ── 契约 7: app-shell.tsx active 映射含 "/agents" ──────────────────────────
  {
    const shellSrc = src("app/shared/app-shell.tsx");
    // active 类型定义或映射应含 agents
    assert.ok(
      shellSrc.includes('"agents"') || shellSrc.includes("'agents'"),
      "C7 FAIL: app-shell.tsx active 映射应含 \"agents\" 值"
    );
    // /agents 路径判断应存在（pathname.startsWith 或类似）
    assert.ok(
      shellSrc.includes("/agents"),
      "C7 FAIL: app-shell.tsx 应含 /agents 路径判断（active 映射）"
    );
  }

  console.log("nav-v3: all C5–C7 checks passed ✓");
})();
