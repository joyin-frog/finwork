/**
 * cockpit-recent-work.test.ts — CV-2 切片
 *
 * 覆盖：
 * - T1  listRecentWorkItems 行为测试（临时库：插 chat_conversations/chat_messages/subagent_dispatches，
 *       断言 roleIds 关联正确、排序按 updated_at 降序、limit 生效）
 * - T2  recent-work-card.tsx 源码契约（文件存在、空态文案、状态点标识、ROLE_UI 引用、整行链接模式）
 * - T3  period-badge.tsx 源码契约（文件存在、平峰 null 特征、优先级顺序、公共阈值函数引用）
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/cockpit-recent-work.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export const cockpitRecentWorkTestPromise = (async () => {
  // ──────────────────────────────────────────────────────────────────────────
  // T1: listRecentWorkItems 行为测试（临时库）
  // ──────────────────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-recent-work-t1-"));
    const dbPath = path.join(dir, "t1.db");
    const savedDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // 插入 3 条会话（updated_at 降序应为 conv3 > conv2 > conv1）
      const rawDb = new DatabaseSync(dbPath, { open: true });
      rawDb.exec(`
        INSERT INTO chat_conversations (id, title, updated_at) VALUES
          (1, '发票核对任务', '2026-06-01 10:00:00'),
          (2, '工资计算任务', '2026-06-02 11:00:00'),
          (3, '税务申报任务', '2026-06-03 12:00:00')
      `);

      // 插入 chat_messages 供状态推导（至少有消息说明非空会话）
      rawDb.exec(`
        INSERT INTO chat_messages (conversation_id, role, content) VALUES
          (1, 'user', '帮我核对发票'),
          (1, 'assistant', '好的'),
          (2, 'user', '帮我算工资'),
          (2, 'assistant', '已完成'),
          (3, 'user', '帮我报税')
      `);

      // 插入 subagent_dispatches：
      //  - conv 1 绑定角色 bookkeeper
      //  - conv 2 绑定角色 payroll-officer + analyst（两个角色）
      //  - conv 3 无 dispatch（roleIds 应为空数组）
      rawDb.exec(`
        INSERT INTO subagent_dispatches (role_id, conversation_id, status) VALUES
          ('bookkeeper', '1', 'success'),
          ('payroll-officer', '2', 'success'),
          ('analyst', '2', 'success')
      `);
      rawDb.close();

      // 动态 import（测试应先行失败，函数尚不存在）
      const mod = await import("../lib/db/sqlite.ts");
      assert.ok(
        typeof (mod as Record<string, unknown>)["listRecentWorkItems"] === "function",
        "T1 FAIL: lib/db/sqlite.ts 应导出 listRecentWorkItems 函数"
      );

      // @ts-expect-error — 函数尚未实现，先行失败
      const { listRecentWorkItems } = mod as { listRecentWorkItems: (limit?: number) => Array<{
        conversationId: number;
        title: string;
        status: "running" | "done" | "error";
        roleIds: string[];
        updatedAt: string;
      }> };

      const items = listRecentWorkItems(8);
      assert.ok(Array.isArray(items), "T1 FAIL: listRecentWorkItems 应返回数组");

      // 排序：updated_at 降序（conv3 排第一）
      assert.ok(items.length >= 3, `T1 FAIL: 应有 >= 3 条，实际 ${items.length}`);
      assert.equal(items[0].conversationId, 3, `T1 FAIL: 第一条应为 conv3（最新），实际 ${items[0].conversationId}`);
      assert.equal(items[1].conversationId, 2, `T1 FAIL: 第二条应为 conv2，实际 ${items[1].conversationId}`);
      assert.equal(items[2].conversationId, 1, `T1 FAIL: 第三条应为 conv1，实际 ${items[2].conversationId}`);

      // roleIds 关联：conv1 → ['bookkeeper']
      const conv1 = items.find((i) => i.conversationId === 1);
      assert.ok(conv1, "T1 FAIL: 应有 conv1 的记录");
      assert.ok(
        Array.isArray(conv1!.roleIds) && conv1!.roleIds.includes("bookkeeper"),
        `T1 FAIL: conv1 的 roleIds 应含 bookkeeper，实际 ${JSON.stringify(conv1!.roleIds)}`
      );

      // roleIds 关联：conv2 → 含 payroll-officer 和 analyst
      const conv2 = items.find((i) => i.conversationId === 2);
      assert.ok(conv2, "T1 FAIL: 应有 conv2 的记录");
      assert.ok(
        Array.isArray(conv2!.roleIds) &&
          conv2!.roleIds.includes("payroll-officer") &&
          conv2!.roleIds.includes("analyst"),
        `T1 FAIL: conv2 的 roleIds 应含 payroll-officer 和 analyst，实际 ${JSON.stringify(conv2!.roleIds)}`
      );

      // roleIds 关联：conv3 → 空数组（无 dispatch 记录）
      const conv3 = items.find((i) => i.conversationId === 3);
      assert.ok(conv3, "T1 FAIL: 应有 conv3 的记录");
      assert.ok(
        Array.isArray(conv3!.roleIds) && conv3!.roleIds.length === 0,
        `T1 FAIL: conv3 的 roleIds 应为空数组，实际 ${JSON.stringify(conv3!.roleIds)}`
      );

      // limit 生效：limit=2 只返回 2 条
      const limited = listRecentWorkItems(2);
      assert.equal(limited.length, 2, `T1 FAIL: limit=2 时应返回 2 条，实际 ${limited.length}`);
      // 仍是按 updated_at 降序（最新的 2 条）
      assert.equal(limited[0].conversationId, 3, "T1 FAIL: limit=2 时第一条应为 conv3");
      assert.equal(limited[1].conversationId, 2, "T1 FAIL: limit=2 时第二条应为 conv2");

      // 每条有 status 字段（'running'|'done'|'error'）
      for (const item of items) {
        assert.ok(
          ["running", "done", "error"].includes(item.status),
          `T1 FAIL: status 应为 running/done/error，实际 ${item.status} (conv=${item.conversationId})`
        );
        assert.ok(typeof item.title === "string" && item.title.length > 0, "T1 FAIL: title 应为非空字符串");
        assert.ok(typeof item.updatedAt === "string", "T1 FAIL: updatedAt 应为字符串");
      }

      console.log("cockpit-recent-work T1: listRecentWorkItems 行为 ✓");
    } finally {
      if (savedDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // T2: recent-work-card.tsx 源码契约断言
  // ──────────────────────────────────────────────────────────────────────────
  {
    const filePath = "app/cockpit/recent-work-card.tsx";
    assert.ok(
      existsSync(filePath),
      "T2 FAIL: app/cockpit/recent-work-card.tsx 应存在"
    );

    const src = await readFile(filePath, "utf-8");

    // 空态文案
    assert.ok(
      src.includes("还没有工作记录"),
      "T2 FAIL: recent-work-card.tsx 应含空态文案「还没有工作记录」"
    );

    // 状态点：running / done / error 三种语义（宽松断言：含这三个单词）
    assert.ok(src.includes("running"), "T2 FAIL: recent-work-card.tsx 应处理 running 状态");
    assert.ok(src.includes("done"), "T2 FAIL: recent-work-card.tsx 应处理 done 状态");
    assert.ok(src.includes("error"), "T2 FAIL: recent-work-card.tsx 应处理 error 状态");

    // 角色 chip 用 ROLE_UI（从 lib/domain/role-ui 导入）
    assert.ok(
      src.includes("ROLE_UI") || src.includes("role-ui"),
      "T2 FAIL: recent-work-card.tsx 应 import/引用 ROLE_UI（来自 lib/domain/role-ui）"
    );

    // 整行链接模式：/chat/recent?id=
    assert.ok(
      src.includes("/chat/recent?id=") || src.includes("chat/recent"),
      "T2 FAIL: recent-work-card.tsx 应包含整行链接 /chat/recent?id= 模式"
    );

    // 上限 8 条（用数字 8 或常量限制）
    assert.ok(
      src.includes("8") || src.includes("limit"),
      "T2 FAIL: recent-work-card.tsx 应体现 ≤8 条限制"
    );

    console.log("cockpit-recent-work T2: recent-work-card.tsx 源码契约 ✓");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // T3: period-badge.tsx 源码契约断言
  // ──────────────────────────────────────────────────────────────────────────
  {
    const filePath = "app/cockpit/period-badge.tsx";
    assert.ok(
      existsSync(filePath),
      "T3 FAIL: app/cockpit/period-badge.tsx 应存在"
    );

    const src = await readFile(filePath, "utf-8");

    // 平峰不渲染：windows 为空时返回 null 的代码特征
    // 实现可能用 if (!windows?.length) return null; 或 windows.length === 0 等
    assert.ok(
      src.includes("return null") || src.includes("return null;"),
      "T3 FAIL: period-badge.tsx 应有 return null（平峰不渲染）"
    );

    // CalendarContext 来源：从 tax-calendar 导入
    assert.ok(
      src.includes("tax-calendar") || src.includes("CalendarContext") || src.includes("windows"),
      "T3 FAIL: period-badge.tsx 应引用 CalendarContext 或 windows"
    );

    // 优先级顺序：filing 优先于 payroll_prep 优先于 closing
    // 检查三个 windowId 在源码中出现的顺序
    const filingIdx = src.indexOf("filing") !== -1 ? src.indexOf("filing") : src.indexOf("tax_filing");
    const payrollIdx = src.indexOf("payroll_prep");
    const closingIdx = src.indexOf("closing");
    assert.ok(filingIdx !== -1, "T3 FAIL: period-badge.tsx 应处理 filing/tax_filing 窗口");
    assert.ok(payrollIdx !== -1, "T3 FAIL: period-badge.tsx 应处理 payroll_prep 窗口");
    assert.ok(closingIdx !== -1, "T3 FAIL: period-badge.tsx 应处理 closing 窗口");
    assert.ok(
      filingIdx < payrollIdx && payrollIdx < closingIdx,
      `T3 FAIL: 优先级应为 filing(${filingIdx}) < payroll_prep(${payrollIdx}) < closing(${closingIdx})`
    );

    // 公共阈值函数引用：不复制阈值字面量两份，而是 import 一个公共函数
    // 检测特征：import 了某个函数（alarm/warn/notice 判断函数）而非直接写 daysLeft <= 3 || daysLeft <= 7
    // 宽松断言：不同时出现两份 3 和 7（若只写了一份就说明是抽了公共函数），
    // 或者 import 了类似 getToneForDaysLeft / periodTone / filingTone 的函数
    const hasSharedFn =
      src.includes("getTone") ||
      src.includes("filingTone") ||
      src.includes("periodTone") ||
      src.includes("daysLeftTone") ||
      src.includes("toneForDays") ||
      src.includes("import") && (
        src.includes("tax-calendar") ||
        src.includes("period-tone") ||
        src.includes("tone-for")
      );
    // 另一个合法特征：函数导入的是某个 util 而非在本文件重新定义阈值
    const rawThresholdCount =
      (src.match(/<=\s*3/g) ?? []).length +
      (src.match(/<=\s*7/g) ?? []).length;
    // 若共享函数存在 OR 阈值字面量只出现一次（说明没有复制）则通过
    assert.ok(
      hasSharedFn || rawThresholdCount <= 2,
      "T3 FAIL: period-badge.tsx 应引用公共阈值函数而非复制 daysLeft 阈值字面量两份（spec §4.2）"
    );

    // 报税期文案含「报税期」和「剩余天数」类字样
    assert.ok(
      src.includes("报税期") || src.includes("filing"),
      "T3 FAIL: period-badge.tsx 应含报税期标签或 filing 处理"
    );

    // payroll_prep → 算薪窗口文案，closing → 月末结账文案
    assert.ok(
      src.includes("算薪") || src.includes("payroll_prep"),
      "T3 FAIL: period-badge.tsx 应含算薪窗口标签"
    );
    assert.ok(
      src.includes("结账") || src.includes("closing"),
      "T3 FAIL: period-badge.tsx 应含月末结账标签"
    );

    // client 组件声明
    assert.ok(
      src.includes('"use client"') || src.includes("'use client'"),
      "T3 FAIL: period-badge.tsx 应为 client 组件（含 'use client'）"
    );

    console.log("cockpit-recent-work T3: period-badge.tsx 源码契约 ✓");
  }

  console.log("cockpit-recent-work: all T1–T3 passed ✓");
})();
