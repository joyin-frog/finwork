/**
 * agent-board.test.ts
 *
 * 1. 纯函数：partitionRoles 各状态归组 + 排序
 * 2. 源码契约（readFileSync）：
 *    - 抽屉 import/使用 usePreviewResize
 *    - 文件产物用 FilePreviewPage
 *    - 「去确认」含 /chat/recent?id=
 *    - 等你拍板与 cockpit 同源（同一 domain 函数）
 *    - 卡片/抽屉不含身份证/卡号字段
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/agent-board.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { partitionRoles, type RosterItem } from "../lib/domain/agent-board.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

export const agentBoardTestPromise = (async () => {
  // ─── §1 纯函数测试 ──────────────────────────────────────────────────────────

  function makeItem(overrides: Partial<RosterItem>): RosterItem {
    return {
      roleId: "bookkeeper",
      name: "记账专员",
      domain: "核算",
      charter: "凭证",
      dataScope: [],
      skills: [],
      available: true,
      userDisabled: false,
      dispatchCount: 0,
      lastAt: null,
      ...overrides,
    };
  }

  // B1: running 角色进 active 组
  {
    const items: RosterItem[] = [
      makeItem({ roleId: "r1", status: "running" }),
      makeItem({ roleId: "r2" }),
    ];
    const { active, rest } = partitionRoles(items);
    assert.equal(active.length, 1, "B1 FAIL: running 角色应在 active 组");
    assert.equal(active[0].roleId, "r1", "B1 FAIL: running 角色 id 不对");
    assert.equal(rest.length, 1, "B1 FAIL: idle 角色应在 rest 组");
    assert.equal(rest[0].roleId, "r2", "B1 FAIL: idle 角色 id 不对");
  }
  console.log("B1: running → active ✓");

  // B2: blocked 角色进 active 组
  {
    const items: RosterItem[] = [
      makeItem({ roleId: "r1", blockedReason: "待审批金额超限" }),
      makeItem({ roleId: "r2" }),
    ];
    const { active, rest } = partitionRoles(items);
    assert.equal(active.length, 1, "B2 FAIL: blocked 角色应在 active 组");
    assert.equal(active[0].roleId, "r1", "B2 FAIL: blocked 角色 id 不对");
    assert.equal(rest.length, 1, "B2 FAIL: idle 角色应在 rest 组");
  }
  console.log("B2: blocked → active ✓");

  // B3: available:false 角色置 rest 末尾
  {
    const items: RosterItem[] = [
      makeItem({ roleId: "r1", available: false }),
      makeItem({ roleId: "r2" }),
      makeItem({ roleId: "r3" }),
    ];
    const { active, rest } = partitionRoles(items);
    assert.equal(active.length, 0, "B3 FAIL: 无 active");
    assert.equal(rest.length, 3, "B3 FAIL: 3 条在 rest");
    // available:false 排尾
    assert.equal(rest[rest.length - 1].roleId, "r1", "B3 FAIL: available:false 应置 rest 末尾");
  }
  console.log("B3: available:false → rest 末尾 ✓");

  // B4: userDisabled 角色也置 rest 末尾
  {
    const items: RosterItem[] = [
      makeItem({ roleId: "r1", userDisabled: true }),
      makeItem({ roleId: "r2" }),
    ];
    const { active, rest } = partitionRoles(items);
    assert.equal(rest[rest.length - 1].roleId, "r1", "B4 FAIL: userDisabled 应置 rest 末尾");
  }
  console.log("B4: userDisabled → rest 末尾 ✓");

  // B5: active 组内 running 在 blocked 前
  {
    const items: RosterItem[] = [
      makeItem({ roleId: "blocked", blockedReason: "待审批" }),
      makeItem({ roleId: "running", status: "running" }),
    ];
    const { active } = partitionRoles(items);
    assert.equal(active.length, 2, "B5 FAIL: active 组应有 2 条");
    assert.equal(active[0].roleId, "running", "B5 FAIL: running 应排在 blocked 前");
    assert.equal(active[1].roleId, "blocked", "B5 FAIL: blocked 应排在 running 后");
  }
  console.log("B5: active 组内 running 先于 blocked ✓");

  // B6: 空数组
  {
    const { active, rest } = partitionRoles([]);
    assert.equal(active.length, 0, "B6 FAIL: 空时 active 为空");
    assert.equal(rest.length, 0, "B6 FAIL: 空时 rest 为空");
  }
  console.log("B6: 空数组 ✓");

  // B7: isActive 标记正确
  {
    const items: RosterItem[] = [
      makeItem({ roleId: "r1", status: "running" }),
      makeItem({ roleId: "r2" }),
    ];
    const { active, rest } = partitionRoles(items);
    assert.equal(active[0].isActive, true, "B7 FAIL: running 卡的 isActive 应为 true");
    assert.equal(rest[0].isActive, false, "B7 FAIL: idle 卡的 isActive 应为 false");
  }
  console.log("B7: isActive 标记 ✓");

  // ─── §2 源码契约 ────────────────────────────────────────────────────────────

  const drawerSrc = src("app/agents/agent-detail-drawer.tsx");
  const pageSrc = src("app/agents/page.tsx");
  const attentionPanelSrc = src("app/agents/attention-panel.tsx");
  const routeSrc = src("app/api/agents/route.ts");
  const cockpitRouteSrc = src("app/api/cockpit/summary/route.ts");

  // C1: 抽屉 import 并使用 usePreviewResize
  {
    assert.ok(
      drawerSrc.includes("usePreviewResize") || pageSrc.includes("usePreviewResize"),
      "C1 FAIL: usePreviewResize 未被引用（抽屉或页面）"
    );
    assert.ok(
      pageSrc.includes("usePreviewResize"),
      "C1b FAIL: page.tsx 应 import usePreviewResize"
    );
    assert.ok(
      pageSrc.includes("beginResize") && pageSrc.includes("previewW") && pageSrc.includes("maximized"),
      "C1c FAIL: page.tsx 应使用 beginResize/previewW/maximized"
    );
  }
  console.log("C1: usePreviewResize 使用 ✓");

  // C2: listMinW >= 400 (spec 评审 P2)
  {
    // page.tsx 传入 usePreviewResize 的第一个参数应 >= 400
    const match = pageSrc.match(/usePreviewResize\((\d+)/);
    assert.ok(match, "C2 FAIL: 找不到 usePreviewResize 调用");
    const listMinW = parseInt(match![1], 10);
    assert.ok(listMinW >= 400, `C2 FAIL: listMinW=${listMinW} < 400，参照 spec 要求 ≥400`);
  }
  console.log("C2: listMinW >= 400 ✓");

  // C3: maximized 时左侧列不参与布局，但列表 DOM 必须保持挂载以保留滚动/非受控状态。
  {
    const shellSrc = src("app/shared/resizable-preview-panel.tsx");
    assert.ok(
      shellSrc.includes('maximized && "hidden"') && !shellSrc.includes("{!maximized &&"),
      "C3 FAIL: 共享预览壳 maximized 时左列应隐藏但不能卸载"
    );
  }
  console.log("C3: maximized → hidden 保持挂载（壳）✓");

  // C4: 文件产物用 FilePreviewPage
  {
    assert.ok(
      drawerSrc.includes("FilePreviewPage"),
      "C4 FAIL: agent-detail-drawer.tsx 应引用 FilePreviewPage"
    );
  }
  console.log("C4: FilePreviewPage 引用 ✓");

  // C5: 「去确认」含 /chat/recent?id=
  {
    const hasChatRecent =
      drawerSrc.includes("/chat/recent?id=") ||
      pageSrc.includes("/chat/recent?id=") ||
      attentionPanelSrc.includes("/chat/recent?id=");
    assert.ok(hasChatRecent, "C5 FAIL: 「去确认」跳转应含 /chat/recent?id=");
  }
  console.log("C5: /chat/recent?id= 跳转 ✓");

  // C6: 等你拍板与 cockpit 同源（两个 route 都调用同一批 domain 函数）
  {
    const domainFns = ["deriveAttentionItems", "blockedDispatchToAttentionItem", "sortAttentionItems"];
    for (const fn of domainFns) {
      assert.ok(
        routeSrc.includes(fn),
        `C6 FAIL: /api/agents route.ts 应调用 ${fn}（同源要求）`
      );
      assert.ok(
        cockpitRouteSrc.includes(fn),
        `C6b FAIL: /api/cockpit/summary route.ts 应调用 ${fn}（同源校验）`
      );
    }
  }
  console.log("C6: 等你拍板与 cockpit 同源（domain 函数一致）✓");

  // C7: 脱敏——卡片/抽屉/路由无身份证/卡号字段
  {
    const sensitiveTerms = ["idNumber", "id_number", "身份证号", "bankCard", "bank_card", "卡号"];
    for (const term of sensitiveTerms) {
      assert.ok(
        !drawerSrc.includes(term),
        `C7 FAIL: agent-detail-drawer.tsx 含敏感字段 "${term}"`
      );
      // page.tsx and card are rendering components, they should not touch these fields either
      assert.ok(
        !pageSrc.includes(term),
        `C7b FAIL: page.tsx 含敏感字段 "${term}"`
      );
    }
  }
  console.log("C7: 脱敏检查 ✓");

  // C8: 抽屉/页不做智能体间连线（无 flowchart/dagre/连线等字样）
  {
    const noConnectionTerms = ["dagre", "flowchart", "node-connection", "连线"];
    for (const term of noConnectionTerms) {
      assert.ok(
        !drawerSrc.includes(term),
        `C8 FAIL: 抽屉含连线相关字样 "${term}"`
      );
    }
  }
  console.log("C8: 无连线 ✓");

  // C9: agents route 必含 status/blockedReason/lastSummary
  {
    assert.ok(routeSrc.includes("status"), "C9 FAIL: /api/agents 响应缺 status 字段");
    assert.ok(routeSrc.includes("blockedReason"), "C9 FAIL: /api/agents 响应缺 blockedReason 字段");
    assert.ok(routeSrc.includes("lastSummary"), "C9 FAIL: /api/agents 响应缺 lastSummary 字段");
  }
  console.log("C9: route 含 status/blockedReason/lastSummary ✓");

  // C10: dispatch-store 含 listRoleLatestStatus
  {
    const dispatchStoreSrc = src("lib/db/dispatch-store.ts");
    assert.ok(
      dispatchStoreSrc.includes("listRoleLatestStatus"),
      "C10 FAIL: dispatch-store.ts 缺 listRoleLatestStatus"
    );
  }
  console.log("C10: dispatch-store listRoleLatestStatus ✓");

  // C11: 回归——blocked 查询必须按「近期窗口」过滤，而非 ended_at IS NULL。
  //   根因：recordDispatchEnd 写 blocked_reason 时必同时写 ended_at，故 blocked 派发永远是「已结束」的；
  //   用 ended_at IS NULL 会把 blocked 判为空(角色永不显示「待拍板」)；用近期窗口(与 listBlockedDispatches
  //   /「等你拍板」同源)才对：近期停在门前的算待拍板，陈旧的不污染分组。
  {
    const dispatchStoreSrc = src("lib/db/dispatch-store.ts");
    const fnStart = dispatchStoreSrc.indexOf("function listRoleLatestStatus");
    assert.ok(fnStart >= 0, "C11 FAIL: 找不到 listRoleLatestStatus 函数");
    const fnSrc = dispatchStoreSrc.slice(fnStart);
    const bi = fnSrc.indexOf("blocked_reason IS NOT NULL");
    assert.ok(bi >= 0, "C11 FAIL: listRoleLatestStatus 内找不到 blocked 查询");
    const region = fnSrc.slice(bi, bi + 220);
    assert.ok(
      !region.includes("ended_at IS NULL"),
      "C11 FAIL: blocked 查询不应用 ended_at IS NULL（blocked 派发必已结束，会匹配为空、永不显示待拍板）"
    );
    assert.ok(
      /ended_at\s*>=\s*datetime\('now'/.test(region),
      "C11 FAIL: blocked 查询应按近期窗口过滤（ended_at >= datetime('now', '-N days')，与 listBlockedDispatches 同源）"
    );
  }
  console.log("C11: blocked 查询按近期窗口过滤 ✓");

  console.log("\n所有 agent-board 测试通过 ✓");
})();
