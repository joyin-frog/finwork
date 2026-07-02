/**
 * cockpit-team-expand.test.ts — v3-P2 切片先行失败测试
 *
 * 覆盖契约 5/6/7 的源码断言：
 * - T1  app/agents/page.tsx：含 toggle 接口调用、含「已停用」文案
 * - T2  app/cockpit/team-panel.tsx：行内展开（fetch /api/agents/dispatches?roleId=&limit=5）+
 *       blocked 行「待确认」样式 + 行尾「派活」次动作（CustomEvent cockpit:prefill-dispatch）
 * - T3  app/cockpit/dispatch-input.tsx：监听 cockpit:prefill-dispatch，设值并聚焦
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/cockpit-team-expand.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(PROJECT_ROOT, rel));
}

export const cockpitTeamExpandTestPromise = (async () => {

  // ─── T1：app/agents/page.tsx — toggle 接口调用 + 「已停用」文案 ────────────────
  {
    assert.ok(
      exists("app/agents/page.tsx"),
      "T1 FAIL: app/agents/page.tsx 应存在"
    );

    const pageSrc = src("app/agents/page.tsx");

    // 1a：调用 /api/agents/toggle（POST 启停接口）
    assert.ok(
      pageSrc.includes("/api/agents/toggle"),
      "T1 FAIL: app/agents/page.tsx 应调用 /api/agents/toggle（启停接口）"
    );

    // 1b：含 POST 方法调用（fetch 的 method: "POST" 或等价写法）
    assert.ok(
      pageSrc.includes("POST") || pageSrc.includes("method"),
      "T1 FAIL: app/agents/page.tsx 调用 toggle 接口时应使用 POST 方法"
    );

    // 1c：「已停用」文案（userDisabled 角色的标签）
    assert.ok(
      pageSrc.includes("已停用"),
      "T1 FAIL: app/agents/page.tsx 应含「已停用」文案（userDisabled 角色行的标签）"
    );

    // 1d：「停用」或「启用」控件文案（切换操作按钮）
    assert.ok(
      pageSrc.includes("停用") || pageSrc.includes("启用"),
      "T1 FAIL: app/agents/page.tsx 应含「停用」/「启用」控件文案"
    );

    // 1e：userDisabled 状态判断（来自 API）
    assert.ok(
      pageSrc.includes("userDisabled"),
      "T1 FAIL: app/agents/page.tsx 应处理 userDisabled 字段（决定标签与按钮）"
    );

    // 1f：已停用角色无派活按钮——
    // 从实现契约：「userDisabled 的行显示「已停用」标签、无派活按钮」
    // 源码断言：派活按钮受 userDisabled 条件控制（!isDisabled 或 !userDisabled 之类）
    assert.ok(
      pageSrc.includes("userDisabled") &&
      (pageSrc.includes("!agent.userDisabled") ||
       pageSrc.includes("!userDisabled") ||
       pageSrc.includes("isDisabled") ||
       pageSrc.includes("!isDisabled")),
      "T1 FAIL: app/agents/page.tsx 的「派活」按钮应受 userDisabled 条件控制（已停用时不显示）"
    );

    // 1g：刷新（toggle 成功后重新 fetch 花名册）
    assert.ok(
      pageSrc.includes("fetchRoster") || pageSrc.includes("fetch(\"/api/agents\")") || pageSrc.includes("fetch('/api/agents')"),
      "T1 FAIL: app/agents/page.tsx toggle 后应刷新花名册（调用 fetchRoster 或重新 fetch /api/agents）"
    );

    console.log("cockpit-team-expand T1: agents/page.tsx toggle 接口 + 已停用文案 ✓");
  }

  // ─── T2：app/cockpit/team-panel.tsx — inline 展开 + blocked 样式 + 派活次动作 ──
  {
    assert.ok(
      exists("app/cockpit/team-panel.tsx"),
      "T2 FAIL: app/cockpit/team-panel.tsx 应存在"
    );

    const tpSrc = src("app/cockpit/team-panel.tsx");

    // 2a：fetch /api/agents/dispatches（按需取最近 5 条）
    assert.ok(
      tpSrc.includes("/api/agents/dispatches"),
      "T2 FAIL: app/cockpit/team-panel.tsx 应 fetch /api/agents/dispatches（行内展开数据）"
    );

    // 2b：roleId 作为 query 参数
    assert.ok(
      tpSrc.includes("roleId"),
      "T2 FAIL: app/cockpit/team-panel.tsx 的 fetch 应传 roleId 参数"
    );

    // 2c：limit=5（最近 5 条）
    assert.ok(
      tpSrc.includes("limit=5") || tpSrc.includes("limit: 5") || tpSrc.includes("&limit=5"),
      "T2 FAIL: app/cockpit/team-panel.tsx 应取最近 5 条（limit=5）"
    );

    // 2d：blocked 行有「待确认」样式——文案或 blockedReason 字段处理
    // 契约：「blocked 行带「待确认」样式」
    assert.ok(
      tpSrc.includes("待确认") ||
      tpSrc.includes("blockedReason") ||
      tpSrc.includes("blocked_reason") ||
      tpSrc.includes("blocked"),
      "T2 FAIL: app/cockpit/team-panel.tsx 应有 blocked 行「待确认」样式（文案或 blockedReason 处理）"
    );

    // 2e：行尾「派活」次动作——通过 CustomEvent("cockpit:prefill-dispatch") 预填派活入口
    assert.ok(
      tpSrc.includes("cockpit:prefill-dispatch"),
      "T2 FAIL: app/cockpit/team-panel.tsx 的「派活」次动作应 dispatch CustomEvent(\"cockpit:prefill-dispatch\")"
    );

    // 2f：dispatchEvent 或 CustomEvent（实际派发事件）
    assert.ok(
      tpSrc.includes("dispatchEvent") || tpSrc.includes("CustomEvent"),
      "T2 FAIL: app/cockpit/team-panel.tsx 应含 dispatchEvent(new CustomEvent(...)) 调用"
    );

    // 2g：事件 detail 含 text
    assert.ok(
      tpSrc.includes("detail") && tpSrc.includes("text"),
      "T2 FAIL: app/cockpit/team-panel.tsx CustomEvent detail 应含 text 字段（预填文本）"
    );

    // 2h：行点击展开（onClick 或展开状态）
    assert.ok(
      tpSrc.includes("onClick") || tpSrc.includes("expanded") || tpSrc.includes("setExpanded") || tpSrc.includes("open"),
      "T2 FAIL: app/cockpit/team-panel.tsx 行点击应能 inline 展开（含展开状态管理）"
    );

    // 2i：每行链接原对话（conversationId → /chat/recent?id=...）
    assert.ok(
      tpSrc.includes("conversationId") || tpSrc.includes("conversation_id") || tpSrc.includes("/chat/recent"),
      "T2 FAIL: app/cockpit/team-panel.tsx 展开条目应链接原对话（conversationId）"
    );

    console.log("cockpit-team-expand T2: team-panel.tsx inline 展开 + blocked + 派活事件 ✓");
  }

  // ─── T3：app/cockpit/dispatch-input.tsx — 监听 cockpit:prefill-dispatch ─────────
  {
    assert.ok(
      exists("app/cockpit/dispatch-input.tsx"),
      "T3 FAIL: app/cockpit/dispatch-input.tsx 应存在"
    );

    const diSrc = src("app/cockpit/dispatch-input.tsx");

    // 3a：addEventListener（监听 CustomEvent）
    assert.ok(
      diSrc.includes("addEventListener"),
      "T3 FAIL: app/cockpit/dispatch-input.tsx 应含 addEventListener（监听预填事件）"
    );

    // 3b：事件名 "cockpit:prefill-dispatch"
    assert.ok(
      diSrc.includes("cockpit:prefill-dispatch"),
      "T3 FAIL: app/cockpit/dispatch-input.tsx 应监听事件 \"cockpit:prefill-dispatch\""
    );

    // 3c：设值（setText 或等价的 state 更新）
    assert.ok(
      diSrc.includes("setText") || diSrc.includes("setValue") || diSrc.includes("onChange"),
      "T3 FAIL: app/cockpit/dispatch-input.tsx 收到预填事件后应更新输入值（setText 或 setValue）"
    );

    // 3d：聚焦（focus()）
    assert.ok(
      diSrc.includes("focus"),
      "T3 FAIL: app/cockpit/dispatch-input.tsx 收到预填事件后应聚焦输入框（focus()）"
    );

    // 3e：removeEventListener（cleanup，避免内存泄漏）
    assert.ok(
      diSrc.includes("removeEventListener"),
      "T3 FAIL: app/cockpit/dispatch-input.tsx 应在 cleanup 时 removeEventListener"
    );

    // 3f：id="dispatch-input-field" 依然保留（不破坏现有 id）
    assert.ok(
      diSrc.includes('id="dispatch-input-field"') || diSrc.includes("id={'dispatch-input-field'}") || diSrc.includes("dispatch-input-field"),
      "T3 FAIL: app/cockpit/dispatch-input.tsx 应保留 id=\"dispatch-input-field\""
    );

    // 3g：useEffect（事件监听需在 effect 中注册）
    assert.ok(
      diSrc.includes("useEffect"),
      "T3 FAIL: app/cockpit/dispatch-input.tsx 应用 useEffect 注册事件监听"
    );

    // 3h：事件 detail.text（读取预填文本）
    assert.ok(
      diSrc.includes("detail") || diSrc.includes(".text"),
      "T3 FAIL: app/cockpit/dispatch-input.tsx 应从事件 detail.text 取预填文本"
    );

    console.log("cockpit-team-expand T3: dispatch-input.tsx 监听预填事件 ✓");
  }

  console.log("cockpit-team-expand: all T1–T3 done（上面任何 FAIL 即为红 → 等待实现者实现后才绿）");
})();
