/**
 * cockpit-ticker.test.ts — D1 切片先行失败测试（契约 3 + 4 + 5）
 *
 * 覆盖：
 * - B1  dispatch-input.tsx 已不存在（退役）
 * - B2  app/cockpit/page.tsx 不再 import/引用 DispatchInput
 * - B3  app/cockpit/role-activity-ticker.tsx 存在
 * - B4  ticker 三条克制规则源码断言：
 *         B4a  轮换不横滚——不含 marquee / translateX 循环动画
 *         B4b  无活动不装忙——无近期派发时渲染 getCockpitSuggestions 一句话
 *         B4c  每条可点进原会话——conversationId 有则 Link /chat/recent?id=
 * - B5  lib/db/dispatch-store.ts 新增 listRecentDispatchActivity（行为测试）：
 *         全角色按 started_at 降序；limit 参数有效；返回字段完整
 * - B6  GET /api/agents/activity 路由接线断言：
 *         文件存在、调用 listRecentDispatchActivity、返回 json({ ok: true, data: ... })
 * - B7  team-panel.tsx 的「派活」次动作改为 CustomEvent("chat-float:open", ...)
 * - B8  team-growth-hint.tsx 的「先派一个活」改为 CustomEvent("chat-float:open", ...)
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/cockpit-ticker.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(ROOT, rel));
}

export const cockpitTickerTestPromise = (async () => {

  // ─── B1: dispatch-input.tsx 退役——不应存在 ────────────────────────────────
  {
    assert.equal(
      exists("app/cockpit/dispatch-input.tsx"),
      false,
      "B1 FAIL: app/cockpit/dispatch-input.tsx 应已删除（D1 切片派活入口退役）"
    );
  }

  // ─── B2: page.tsx 不再引用 DispatchInput ──────────────────────────────────
  {
    assert.ok(
      exists("app/cockpit/page.tsx"),
      "B2 prereq: app/cockpit/page.tsx 应存在"
    );

    const pageSrc = src("app/cockpit/page.tsx");

    assert.ok(
      !pageSrc.includes("DispatchInput"),
      "B2 FAIL: app/cockpit/page.tsx 不应再 import 或使用 DispatchInput（派活入口已退役）"
    );

    assert.ok(
      !pageSrc.includes("dispatch-input"),
      "B2 FAIL: app/cockpit/page.tsx 不应 import dispatch-input 模块（派活入口已退役）"
    );
  }

  // ─── B3: role-activity-ticker.tsx 存在 ────────────────────────────────────
  {
    assert.ok(
      exists("app/cockpit/role-activity-ticker.tsx"),
      "B3 FAIL: app/cockpit/role-activity-ticker.tsx 应存在（接替 dispatch-input 位置的动态条组件）"
    );
  }

  const tickerSrc = src("app/cockpit/role-activity-ticker.tsx");

  // ─── B4a: 轮换不横滚——不含 marquee / translateX 循环动画 ──────────────────
  {
    assert.ok(
      !tickerSrc.includes("marquee"),
      "B4a FAIL: role-activity-ticker.tsx 不应含 marquee（三条克制规则第一条：轮换不横滚）"
    );

    // translateX 循环动画的惯用写法：animation 或 @keyframes 搭配 translateX
    // 允许 translateX 出现在非循环动画场景，但禁止 marquee 式横滚
    const hasScrollLoop =
      /translateX\s*\(/.test(tickerSrc) &&
      (/animate-marquee/.test(tickerSrc) || /scrolling/.test(tickerSrc) || /scroll-smooth.*translateX/.test(tickerSrc));

    assert.ok(
      !hasScrollLoop,
      "B4a FAIL: role-activity-ticker.tsx 不应含 marquee 式 translateX 横滚动画（用定时器+淡入切换替代）"
    );

    // 应使用定时器（setTimeout/setInterval）或过渡（opacity/fade）实现轮换
    assert.ok(
      tickerSrc.includes("setTimeout") || tickerSrc.includes("setInterval") || tickerSrc.includes("opacity") || tickerSrc.includes("fade") || tickerSrc.includes("transition"),
      "B4a FAIL: role-activity-ticker.tsx 应用定时器+淡入方式轮换（非横滚），含 setTimeout/setInterval/opacity/transition 之一"
    );
  }

  // ─── B4b: 无活动不装忙——无近期派发时渲染 getCockpitSuggestions 一句话 ────
  {
    assert.ok(
      tickerSrc.includes("getCockpitSuggestions"),
      "B4b FAIL: role-activity-ticker.tsx 应引用 getCockpitSuggestions（无活动时渲染日历上下文一句话，不装忙）"
    );

    // 空态/无活动的条件判断
    assert.ok(
      tickerSrc.includes("length === 0") ||
      tickerSrc.includes("length == 0") ||
      tickerSrc.includes("!items") ||
      tickerSrc.includes("items.length") ||
      tickerSrc.includes("activities.length") ||
      tickerSrc.includes("rows.length"),
      "B4b FAIL: role-activity-ticker.tsx 应有无活动时的空态判断（无近期派发时不编造动态）"
    );
  }

  // ─── B4c: 每条可点进原会话——conversationId 有则 Link /chat/recent?id= ────
  {
    assert.ok(
      tickerSrc.includes("conversationId") || tickerSrc.includes("conversation_id"),
      "B4c FAIL: role-activity-ticker.tsx 应处理 conversationId 字段（每条可追溯到原会话）"
    );

    assert.ok(
      tickerSrc.includes("/chat/recent"),
      "B4c FAIL: role-activity-ticker.tsx 应链接到 /chat/recent?id=（conversationId 有时可点进原会话）"
    );

    // Link 组件（Next.js）或 href
    assert.ok(
      tickerSrc.includes("Link") || tickerSrc.includes("href"),
      "B4c FAIL: role-activity-ticker.tsx 应使用 Link 或 href 实现每条可点进原会话"
    );
  }

  // ─── B5: listRecentDispatchActivity 行为测试（临时 DB） ────────────────────
  {
    const dbDir = mkdtempSync(path.join(tmpdir(), "fa-ticker-b5-"));
    const dbPath = path.join(dbDir, "test.db");
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    let cleanupErr: unknown = null;
    try {
      // 动态 import（保证用测试时的 DB_PATH 环境变量）
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);

      // 确认 subagent_dispatches 表存在
      const tableRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_dispatches'")
        .get();
      assert.ok(tableRow, "B5 prereq: subagent_dispatches 表应存在");

      // 插入多角色多条记录（不同 started_at 以控制排序）
      db.prepare(
        `INSERT INTO subagent_dispatches (role_id, label, summary, status, conversation_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("bookkeeper", "记账任务A", "对账完成", "success", "conv-001", "2026-07-02 09:00:00");

      db.prepare(
        `INSERT INTO subagent_dispatches (role_id, label, summary, status, conversation_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("payroll", "薪酬任务B", "试算草稿", "success", "conv-002", "2026-07-02 10:00:00");

      db.prepare(
        `INSERT INTO subagent_dispatches (role_id, label, summary, status, conversation_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("tax", "税务任务C", "申报检查", "running", "conv-003", "2026-07-02 11:00:00");

      db.prepare(
        `INSERT INTO subagent_dispatches (role_id, label, summary, status, conversation_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("bookkeeper", "记账任务D", "发票核对", "success", null, "2026-07-02 08:00:00");

      // 现在 import 并测试 listRecentDispatchActivity
      const dispatchStore = await import("../lib/db/dispatch-store.ts");

      assert.ok(
        typeof (dispatchStore as Record<string, unknown>).listRecentDispatchActivity === "function",
        "B5 FAIL: lib/db/dispatch-store.ts 应导出 listRecentDispatchActivity 函数"
      );

      const { listRecentDispatchActivity } = dispatchStore as {
        listRecentDispatchActivity: (limit?: number) => Array<{
          id: number;
          roleId: string;
          label: string | null;
          summary: string | null;
          status: string;
          conversationId: string | null;
          startedAt: string | null;
          endedAt: string | null;
        }>;
      };

      // B5a: 全角色按 started_at 降序
      const all = listRecentDispatchActivity(10);

      assert.ok(
        Array.isArray(all),
        "B5a FAIL: listRecentDispatchActivity 应返回数组"
      );

      assert.ok(
        all.length >= 4,
        `B5a FAIL: 插入了 4 条，listRecentDispatchActivity(10) 应返回 >= 4 条，实际 ${all.length} 条`
      );

      // 验证降序：started_at 后插的排前面
      // 任务C(11:00) > 任务B(10:00) > 任务A(09:00) > 任务D(08:00)
      const firstRoleId = all[0].roleId;
      assert.equal(
        firstRoleId,
        "tax",
        `B5a FAIL: 全角色按 started_at 降序，第一条应为 started_at 最新的 tax（11:00），实际 roleId=${firstRoleId}`
      );

      const secondRoleId = all[1].roleId;
      assert.equal(
        secondRoleId,
        "payroll",
        `B5a FAIL: 第二条应为 payroll（10:00），实际 roleId=${secondRoleId}`
      );

      // B5b: limit 参数有效
      const limited = listRecentDispatchActivity(2);
      assert.equal(
        limited.length,
        2,
        `B5b FAIL: listRecentDispatchActivity(2) 应只返回 2 条，实际 ${limited.length} 条`
      );

      // B5c: 返回字段完整
      const firstRow = all[0];
      const requiredFields = ["id", "roleId", "label", "summary", "status", "conversationId", "startedAt", "endedAt"];
      for (const field of requiredFields) {
        assert.ok(
          field in firstRow,
          `B5c FAIL: listRecentDispatchActivity 返回行缺少字段 ${field}`
        );
      }

      // B5d: conversationId 为 null 时正常处理（任务D 无 conversation_id）
      const taskD = all.find((r) => r.label === "记账任务D");
      assert.ok(taskD !== undefined, "B5d prereq: 应能找到任务D");
      assert.equal(
        taskD.conversationId,
        null,
        "B5d FAIL: 无 conversation_id 的行，listRecentDispatchActivity 应返回 conversationId: null"
      );

      console.log("cockpit-ticker B5: listRecentDispatchActivity 行为测试 ✓");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      try {
        rmSync(dbDir, { recursive: true });
      } catch (e) {
        cleanupErr = e;
      }
    }
    if (cleanupErr) console.warn("B5 cleanup warn:", cleanupErr);
  }

  // ─── B6: GET /api/agents/activity 路由接线断言 ────────────────────────────
  {
    assert.ok(
      exists("app/api/agents/activity/route.ts"),
      "B6 FAIL: app/api/agents/activity/route.ts 应存在（动态条数据接口）"
    );

    const routeSrc = src("app/api/agents/activity/route.ts");

    // 调用 listRecentDispatchActivity
    assert.ok(
      routeSrc.includes("listRecentDispatchActivity"),
      "B6 FAIL: activity/route.ts 应调用 listRecentDispatchActivity（dispatch-store 新函数）"
    );

    // 返回 json 响应
    assert.ok(
      routeSrc.includes("ok") && (routeSrc.includes("NextResponse") || routeSrc.includes("Response") || routeSrc.includes("json")),
      "B6 FAIL: activity/route.ts 应返回 JSON 响应（含 ok 字段）"
    );

    // 导出 GET handler
    assert.ok(
      routeSrc.includes("export") && (routeSrc.includes("GET") || routeSrc.includes("function GET")),
      "B6 FAIL: activity/route.ts 应导出 GET handler"
    );
  }

  // ─── B7: team-panel.tsx 的「派活」改为 chat-float:open ────────────────────
  {
    assert.ok(
      exists("app/cockpit/team-panel.tsx"),
      "B7 prereq: app/cockpit/team-panel.tsx 应存在"
    );

    const tpSrc = src("app/cockpit/team-panel.tsx");

    // 应改为 chat-float:open 事件
    assert.ok(
      tpSrc.includes("chat-float:open"),
      "B7 FAIL: app/cockpit/team-panel.tsx 的「派活」次动作应改为 CustomEvent(\"chat-float:open\")"
    );

    // 不应再用旧事件名 cockpit:prefill-dispatch
    assert.ok(
      !tpSrc.includes("cockpit:prefill-dispatch"),
      "B7 FAIL: app/cockpit/team-panel.tsx 不应再使用旧事件名 cockpit:prefill-dispatch（已退役）"
    );
  }

  // ─── B8: team-growth-hint.tsx 的「先派一个活」改为 chat-float:open ─────────
  {
    assert.ok(
      exists("app/cockpit/team-growth-hint.tsx"),
      "B8 prereq: app/cockpit/team-growth-hint.tsx 应存在"
    );

    const ghSrc = src("app/cockpit/team-growth-hint.tsx");

    // 应改为 chat-float:open 事件（不再 focus dispatch-input-field DOM 元素）
    assert.ok(
      ghSrc.includes("chat-float:open") ||
      ghSrc.includes("dispatchEvent") ||
      ghSrc.includes("CustomEvent"),
      "B8 FAIL: app/cockpit/team-growth-hint.tsx 的「先派一个活」应改为派发 CustomEvent(\"chat-float:open\")"
    );

    // 且明确用 chat-float:open 事件名
    assert.ok(
      ghSrc.includes("chat-float:open"),
      "B8 FAIL: app/cockpit/team-growth-hint.tsx 应使用事件名 chat-float:open（统一预填入口）"
    );

    // 不应再直接操作 dispatch-input-field DOM 元素（该元素对应的组件已退役）
    assert.ok(
      !ghSrc.includes("dispatch-input-field"),
      "B8 FAIL: app/cockpit/team-growth-hint.tsx 不应再直接 focus dispatch-input-field（DispatchInput 已退役）"
    );
  }

  console.log("cockpit-ticker: all B1–B8 checks passed ✓（红 = 实现还未落地；绿 = 实现完成）");
})();
