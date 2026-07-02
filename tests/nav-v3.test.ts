/**
 * nav-v3.test.ts — v3-P0 先行失败测试
 *
 * 覆盖契约 5-7（spec-cockpit-v3.md §4 导航）：
 * 契约 5 — app/shared/app-nav.tsx：新增「智能体」项 href="/agents"（位于总览之后）；
 *           「技能」项移除（导航项区域不含 href="/skills"）；新对话/总览/资料/设置保留
 * 契约 6 — /skills 路由保留但重定向：app/skills/page.tsx 源码含 redirect("/config")
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

  // ── 契约 5c: 「技能」项移除（导航项 Link 区域不含 href="/skills"）─────────
  {
    const navSrc = src("app/shared/app-nav.tsx");
    // 检查 href="/skills" 的 Link 不存在
    assert.ok(
      !navSrc.includes('href="/skills"'),
      "C5c FAIL: app-nav.tsx 不应含 href=\"/skills\" 导航项（「技能」项已移除）"
    );
  }

  // ── 契约 5d: 保留项核验——新对话/总览/资料 ─────────────────────────────────
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
    // 资料（/files）
    assert.ok(
      navSrc.includes('href="/files"'),
      "C5d FAIL: app-nav.tsx 应保留「资料」导航项 href=\"/files\""
    );
    // 设置（/config）
    assert.ok(
      navSrc.includes('href="/config"'),
      "C5d FAIL: app-nav.tsx 应保留设置入口 href=\"/config\""
    );
  }

  // ── 契约 6: app/skills/page.tsx 含 redirect("/config") ────────────────────
  {
    assert.ok(
      exists("app/skills/page.tsx"),
      "C6 FAIL: app/skills/page.tsx 应保留（/skills 路由不删除，只重定向）"
    );
    const skillsPageSrc = src("app/skills/page.tsx");
    // 裁决修订二(2026-07-02):导航降权与阅读空间分离——/skills 恢复为独立全屏页(渲染 SkillsManager),
    // 但不回导航(C5 仍守卫导航无 /skills 项);设置技能 tab 保留并提供「全屏打开」跳板
    assert.ok(
      skillsPageSrc.includes("SkillsManager"),
      "C6 FAIL: app/skills/page.tsx 应渲染 SkillsManager（独立全屏技能页）"
    );
    const skillCenterSrc = src("app/config/skill-center.tsx");
    assert.ok(
      skillCenterSrc.includes('href="/skills"') && skillCenterSrc.includes("全屏打开"),
      "C6 FAIL: 设置技能 tab 应含「全屏打开」跳板链接到 /skills"
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
