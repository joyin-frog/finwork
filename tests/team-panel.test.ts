/**
 * team-panel.test.ts — CV-3/RR-3 先行失败测试 A
 *
 * 覆盖：
 * 契约 1 — conversationId 贯通：runSubagent opts 加 conversationId，透传 recordDispatchStart
 * 契约 2 — listRoleDispatchSummary 返回值加 lastSummary 字段
 * 契约 3 — blockedDispatchToAttentionItem 纯函数（gate 供给源转换）
 * 契约 4 — team-panel.tsx 源码断言（生长时刻、低拟人、fa-toned 圆形图标、localStorage）
 * 契约 5 — team-growth-hint.tsx 源码断言（dashed 边、「长出来」、聚焦派活入口）
 * 契约 6 — types.ts 加 team 字段；route.ts 从 ROLE_REGISTRY 取 name/charter（源码断言）
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/team-panel.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(PROJECT_ROOT, rel));
}

export const teamPanelTestPromise = (async () => {
  // ─── 契约 1：conversationId 贯通行为测试 ───────────────────────────────────
  // runSubagent opts 增加 conversationId，透传至 recordDispatchStart
  // 手法参照 subagent-dispatches.test.ts T5
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-teampanel-c1-"));
    const dbPath = path.join(dir, "c1.db");
    const settingsPath = path.join(dir, "settings.json");
    const secretFilePath = path.join(dir, "secret");

    const savedEnv = {
      DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
      SETTINGS_PATH: process.env.FINANCE_AGENT_SETTINGS_PATH,
      SECRET_BACKEND: process.env.FINANCE_AGENT_SECRET_BACKEND,
      SECRET_FILE: process.env.FINANCE_AGENT_SECRET_FILE,
    };

    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    process.env.FINANCE_AGENT_SETTINGS_PATH = settingsPath;
    process.env.FINANCE_AGENT_SECRET_BACKEND = "file";
    process.env.FINANCE_AGENT_SECRET_FILE = secretFilePath;

    try {
      const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
      _resetSecretCache();

      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      const { runSubagent } = await import("../lib/agent/subagent-runner.ts");
      const parentOutputDir = path.join(dir, "out");

      // 无 API key 路径，但 conversationId 应被传递到 dispatch 行
      const r1 = await runSubagent(
        { roleId: "analyst", instructions: "做点分析", label: "C1-analyst" },
        { parentOutputDir, conversationId: "42" }
      );
      assert.equal(r1.success, false, "C1 FAIL: 无 key 时 runSubagent 应返回 success:false");

      // 查库：落行的 conversation_id 应为 "42"
      {
        const verifyDb = new DatabaseSync(dbPath, { open: true });
        const row = verifyDb
          .prepare(
            "SELECT conversation_id FROM subagent_dispatches WHERE role_id='analyst' ORDER BY id DESC LIMIT 1"
          )
          .get() as Record<string, unknown> | undefined;
        verifyDb.close();
        assert.ok(row, "C1 FAIL: 应有 analyst 的 dispatch 行");
        assert.equal(
          row!.conversation_id,
          "42",
          `C1 FAIL: conversation_id 应为 "42"，实际: ${row!.conversation_id}`
        );
      }

      console.log("team-panel C1: conversationId 贯通 ✓");
    } finally {
      const restoreEnv = (val: string | undefined, key: string) => {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      };
      restoreEnv(savedEnv.DB_PATH, "FINANCE_AGENT_DB_PATH");
      restoreEnv(savedEnv.SETTINGS_PATH, "FINANCE_AGENT_SETTINGS_PATH");
      restoreEnv(savedEnv.SECRET_BACKEND, "FINANCE_AGENT_SECRET_BACKEND");
      restoreEnv(savedEnv.SECRET_FILE, "FINANCE_AGENT_SECRET_FILE");
      try {
        const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
        _resetSecretCache();
      } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─── 契约 2：listRoleDispatchSummary 加 lastSummary 字段 ──────────────────
  {
    const dbPath = path.join(tmpdir(), `fa-teampanel-c2-${process.pid}-${Date.now()}.db`);
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const { recordDispatchStart, recordDispatchEnd, listRoleDispatchSummary } =
        await import("../lib/db/dispatch-store.ts");

      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // 插两条 analyst（不同 summary，最新的 lastSummary 应被返回）
      const id1 = recordDispatchStart({ roleId: "analyst", label: "分析 1" });
      recordDispatchEnd(id1, { status: "success", summary: "第一次分析完成", blockedReasons: [] });

      // 短暂等待确保 started_at 有不同顺序（或直接用 ended_at）
      const id2 = recordDispatchStart({ roleId: "analyst", label: "分析 2" });
      recordDispatchEnd(id2, {
        status: "success",
        summary: "最近分析结论：毛利率下降 2 个百分点",
        blockedReasons: [],
      });

      const summary = listRoleDispatchSummary();
      const analystRow = summary.find((r) => r.roleId === "analyst");

      assert.ok(analystRow, "C2 FAIL: listRoleDispatchSummary 应含 analyst 行");

      // 关键断言：lastSummary 字段必须存在（契约 2 核心）
      assert.ok(
        "lastSummary" in analystRow!,
        "C2 FAIL: listRoleDispatchSummary 的行应含 lastSummary 字段（契约 2 新增）"
      );

      // lastSummary 应为最近一条 dispatch 的 summary
      assert.ok(
        typeof analystRow!.lastSummary === "string" ||
          analystRow!.lastSummary === null,
        `C2 FAIL: lastSummary 应为 string|null，实际类型: ${typeof analystRow!.lastSummary}`
      );

      // 由于 id2 是最新插入的，其 summary 应被返回（lastSummary 取最近一条）
      assert.ok(
        analystRow!.lastSummary !== null &&
          (analystRow!.lastSummary as string).includes("毛利率"),
        `C2 FAIL: lastSummary 应为最近一条（含"毛利率"），实际: ${analystRow!.lastSummary}`
      );

      console.log("team-panel C2: listRoleDispatchSummary.lastSummary ✓");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      try {
        const { DatabaseSync: DS } = await import("node:sqlite");
        const v = new DS(dbPath, { open: true });
        v.close();
        rmSync(dbPath, { force: true });
      } catch { /* ignore */ }
    }
  }

  // ─── 契约 3：blockedDispatchToAttentionItem 纯函数（表驱动，两种分支） ──────
  {
    // 动态导入：实现不存在时此处抛 → 测试红
    const { blockedDispatchToAttentionItem } = await import(
      "../lib/domain/attention.ts"
    );

    // 分支 A：conversationId 存在 → action.href = /chat/recent?id=42
    const rowWithConv = {
      id: 1,
      roleId: "analyst",
      label: "经营分析",
      summary: "毛利率下降 2 个百分点\n第二行内容",
      blockedReason: "export_kingdee_draft",
      conversationId: "42",
      endedAt: "2026-07-02T10:00:00",
    };

    const itemA = blockedDispatchToAttentionItem(rowWithConv, "经营分析师");

    assert.equal(itemA.source, "gate", "C3 FAIL: source 应为 gate");
    assert.equal(itemA.sourceLabel, "停在确认门", "C3 FAIL: sourceLabel 应为「停在确认门」");
    assert.equal(itemA.roleId, "analyst", "C3 FAIL: roleId 应透传");
    assert.equal(itemA.severity, "normal", "C3 FAIL: severity 应为 normal");
    assert.ok(
      itemA.title.includes("经营分析师"),
      `C3 FAIL: title 应含角色名「经营分析师」，实际: ${itemA.title}`
    );
    // title 应含 summary 首行
    assert.ok(
      itemA.title.includes("毛利率下降 2 个百分点"),
      `C3 FAIL: title 应含 summary 首行，实际: ${itemA.title}`
    );
    assert.equal(itemA.occurredAt, "2026-07-02T10:00:00", "C3 FAIL: occurredAt 应等于 endedAt");
    assert.ok(Array.isArray(itemA.actions) && itemA.actions.length >= 1, "C3 FAIL: actions 应非空");
    assert.ok(
      itemA.actions[0].href.includes("/chat/recent?id=42"),
      `C3 FAIL: conversationId 存在时 action.href 应含 /chat/recent?id=42，实际: ${itemA.actions[0].href}`
    );
    assert.equal(itemA.actions[0].label, "回到原对话", "C3 FAIL: 有 conversationId 时 label 应为「回到原对话」");

    // 分支 B：conversationId 为 null → action.href = /chat/new?prompt=... 含角色名与 summary
    const rowNoConv = {
      id: 2,
      roleId: "bookkeeper",
      label: "凭证草稿",
      summary: "已生成 3 张凭证草稿，待人确认\n其他信息",
      blockedReason: "export_kingdee_draft",
      conversationId: null,
      endedAt: "2026-07-01T14:00:00",
    };

    const itemB = blockedDispatchToAttentionItem(rowNoConv, "记账专员");

    assert.equal(itemB.source, "gate", "C3 FAIL (B): source 应为 gate");
    assert.equal(itemB.roleId, "bookkeeper", "C3 FAIL (B): roleId 应透传");
    assert.ok(
      itemB.title.includes("记账专员"),
      `C3 FAIL (B): title 应含角色名「记账专员」，实际: ${itemB.title}`
    );
    assert.ok(
      itemB.title.includes("已生成 3 张凭证草稿"),
      `C3 FAIL (B): title 应含 summary 首行，实际: ${itemB.title}`
    );
    assert.ok(
      itemB.actions[0].href.startsWith("/chat/new?prompt="),
      `C3 FAIL (B): 无 conversationId 时 action.href 应为 /chat/new?prompt=...，实际: ${itemB.actions[0].href}`
    );
    assert.equal(itemB.actions[0].label, "继续处理", "C3 FAIL (B): 无 conversationId 时 label 应为「继续处理」");
    // prompt 应含角色名与 summary（URL encoded 检查含解码后内容）
    const decodedPromptB = decodeURIComponent(itemB.actions[0].href.split("?prompt=")[1] ?? "");
    assert.ok(
      decodedPromptB.includes("记账专员") || decodedPromptB.includes("bookkeeper"),
      `C3 FAIL (B): /chat/new prompt 应含角色名，解码后: ${decodedPromptB}`
    );
    assert.ok(
      decodedPromptB.includes("已生成 3 张凭证草稿"),
      `C3 FAIL (B): /chat/new prompt 应含 summary 首行，解码后: ${decodedPromptB}`
    );

    console.log("team-panel C3: blockedDispatchToAttentionItem 表驱动 ✓");
  }

  // ─── 契约 3 补充：route.ts 源码引用 listBlockedDispatches 与转换函数 ────────
  {
    const routeSrc = src("app/api/cockpit/summary/route.ts");

    assert.ok(
      routeSrc.includes("listBlockedDispatches"),
      "C3-route FAIL: route.ts 应引用 listBlockedDispatches（gate 供给源）"
    );
    assert.ok(
      routeSrc.includes("blockedDispatchToAttentionItem"),
      "C3-route FAIL: route.ts 应引用 blockedDispatchToAttentionItem 转换函数"
    );

    console.log("team-panel C3-route: route.ts gate 供给源引用 ✓");
  }

  // ─── 契约 4：team-panel.tsx 源码断言 ─────────────────────────────────────
  {
    assert.ok(
      exists("app/cockpit/team-panel.tsx"),
      "C4 FAIL: app/cockpit/team-panel.tsx 应存在"
    );

    const tpSrc = src("app/cockpit/team-panel.tsx");

    // props 含 team 数组
    assert.ok(
      tpSrc.includes("team"),
      "C4 FAIL: team-panel.tsx 应接受 team prop"
    );

    // team 为空时返回 null（§5.2 空态）
    assert.ok(
      tpSrc.includes("return null") || tpSrc.includes("return null;"),
      "C4 FAIL: team-panel.tsx 应在 team 为空时返回 null"
    );

    // fa-toned 圆形图标（角色 tone）
    assert.ok(
      tpSrc.includes("fa-toned"),
      "C4 FAIL: team-panel.tsx 应含 fa-toned（角色 tone 圆形图标）"
    );

    // 「N 次 · 相对时间」样式的 dispatchCount 显示
    assert.ok(
      tpSrc.includes("dispatchCount") || tpSrc.includes("次"),
      "C4 FAIL: team-panel.tsx 应展示 dispatchCount（「N 次」）"
    );

    // title 提示 lastSummary
    assert.ok(
      tpSrc.includes("lastSummary"),
      "C4 FAIL: team-panel.tsx 应将 lastSummary 作为 title/tooltip"
    );

    // 生长时刻：localStorage key cockpit.seenRoleIds
    assert.ok(
      tpSrc.includes("cockpit.seenRoleIds"),
      "C4 FAIL: team-panel.tsx 应引用 localStorage key「cockpit.seenRoleIds」（生长时刻）"
    );

    // 入场动画 class（有 localStorage 检测到新角色时应用）
    assert.ok(
      tpSrc.includes("localStorage"),
      "C4 FAIL: team-panel.tsx 应用 localStorage 记录已见角色"
    );

    // 动画 CSS 包在 prefers-reduced-motion:no-preference 内
    assert.ok(
      tpSrc.includes("prefers-reduced-motion") ||
        // 可能在 globals.css 中定义，但 panel 源码须引用该 class
        tpSrc.includes("motion") ||
        tpSrc.includes("animation"),
      "C4 FAIL: team-panel.tsx 应含入场动画并考虑 prefers-reduced-motion"
    );

    // 低拟人红线：不得出现头像图片/emoji
    // avatar / avatar-img / <img src 类似的头像 / emoji 特征
    assert.ok(
      !tpSrc.includes("avatar") || !tpSrc.match(/avatar.*(img|image|photo)/i),
      "C4 FAIL: team-panel.tsx 不应含头像图片（低拟人红线）"
    );

    console.log("team-panel C4: team-panel.tsx 源码断言 ✓");
  }

  // ─── 契约 5：team-growth-hint.tsx 源码断言 ───────────────────────────────
  {
    assert.ok(
      exists("app/cockpit/team-growth-hint.tsx"),
      "C5 FAIL: app/cockpit/team-growth-hint.tsx 应存在"
    );

    const ghSrc = src("app/cockpit/team-growth-hint.tsx");

    // dashed 细边
    assert.ok(
      ghSrc.includes("dashed") || ghSrc.includes("border-dashed"),
      "C5 FAIL: team-growth-hint.tsx 应含 dashed 边（CSS class 或 border-style）"
    );

    // 文案含「长出来」
    assert.ok(
      ghSrc.includes("长出来"),
      "C5 FAIL: team-growth-hint.tsx 文案应含「长出来」"
    );

    // 按钮聚焦派活入口（聚焦 dispatch-input 或 scrollIntoView，或 focus()）
    assert.ok(
      ghSrc.includes("focus") ||
        ghSrc.includes("dispatch") ||
        ghSrc.includes("DispatchInput"),
      "C5 FAIL: team-growth-hint.tsx 按钮应聚焦派活入口"
    );

    console.log("team-panel C5: team-growth-hint.tsx 源码断言 ✓");
  }

  // ─── 契约 6：types.ts 含 team 字段；route.ts 从 ROLE_REGISTRY 取 name/charter ───
  {
    const typesSrc = src("app/cockpit/types.ts");

    assert.ok(
      typesSrc.includes("team"),
      "C6 FAIL: CockpitSummary types.ts 应含 team 字段（§5.1）"
    );

    // team 元素的 shape：roleId, name, charter, dispatchCount, lastAt, lastSummary
    for (const field of ["roleId", "name", "charter", "dispatchCount", "lastAt", "lastSummary"]) {
      assert.ok(
        typesSrc.includes(field),
        `C6 FAIL: types.ts 应含 team 元素字段 "${field}"`
      );
    }

    // route.ts 应从 ROLE_REGISTRY 取 name/charter（服务端可 import lib/agent）
    const routeSrc = src("app/api/cockpit/summary/route.ts");

    assert.ok(
      routeSrc.includes("ROLE_REGISTRY"),
      "C6 FAIL: route.ts 应 import ROLE_REGISTRY（取 name/charter 的单一事实源）"
    );

    // route.ts 返回的 data 中有 team
    const routeLines = routeSrc.split("\n").filter(
      (l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")
    );
    const hasTeamInData = routeLines.some((l) => /team\s*:/.test(l));
    assert.ok(
      hasTeamInData,
      "C6 FAIL: route.ts 返回的 data 对象应含 team 字段"
    );

    // route.ts 不应从 role-ui.ts 取 name（契约要求：name/charter 来自注册表，不来自 role-ui）
    // 宽松断言：ROLE_LABELS 不应出现在 route.ts（那是前端 role-ui 的 client-safe 副本）
    assert.ok(
      !routeSrc.includes("ROLE_LABELS"),
      "C6 FAIL: route.ts 不应从 ROLE_LABELS (role-ui.ts) 取 name，应从 ROLE_REGISTRY 取"
    );

    console.log("team-panel C6: types.ts + route.ts team 字段 ✓");
  }

  console.log("team-panel: all C1–C6 ✓");
})();
