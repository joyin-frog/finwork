/**
 * agents-space.test.ts — v3-P1 切片先行失败测试
 *
 * 覆盖：
 * - T1  store 行为：listDispatchesByRole 排序/limit/offset/字段
 * - T2  GET /api/agents 源码契约（接线、字段、单一事实源守卫）
 * - T3  GET /api/agents/dispatches 源码契约（接线 listDispatchesByRole）
 * - T4  app/agents/page.tsx 源码契约（fetch、弱化态文案、派活、数据权限、技能分组、台账区、单一事实源守卫）
 * - T5  app/cockpit/team-panel.tsx「查看全部 →」链接
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/agents-space.test.ts
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

export const agentsSpaceTestPromise = (async () => {

  // ─── T1：store 行为 — listDispatchesByRole 排序/limit/offset/字段 ────────────
  {
    const dbPath = path.join(tmpdir(), `fa-agents-t1-${process.pid}-${Date.now()}.db`);
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const { recordDispatchStart, recordDispatchEnd, listDispatchesByRole } =
        await import("../lib/db/dispatch-store.ts");

      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // 插入 bookkeeper 的 5 条记录（不同时间；实际使用 id 顺序验证降序）
      const ids: number[] = [];
      for (let i = 1; i <= 5; i++) {
        const id = recordDispatchStart({
          roleId: "bookkeeper",
          label: `凭证任务 ${i}`,
          conversationId: `conv-${i}`,
        });
        recordDispatchEnd(id, {
          status: i % 2 === 0 ? "success" : "failed",
          summary: `任务 ${i} 摘要`,
          blockedReasons: i === 3 ? ["export_kingdee_draft"] : [],
        });
        ids.push(id);
      }

      // 插入另一个角色的记录，不应混入结果
      const otherId = recordDispatchStart({ roleId: "analyst", label: "经营分析" });
      recordDispatchEnd(otherId, { status: "success", summary: "分析完成", blockedReasons: [] });

      // 基本查询：bookkeeper 全部
      const all = listDispatchesByRole("bookkeeper");
      assert.ok(Array.isArray(all), "T1 FAIL: listDispatchesByRole 应返回数组");
      assert.equal(all.length, 5, `T1 FAIL: bookkeeper 应有 5 条，实际 ${all.length}`);

      // 结果字段完整性
      const first = all[0];
      assert.ok("id" in first, "T1 FAIL: 返回行应含 id");
      assert.ok("label" in first, "T1 FAIL: 返回行应含 label");
      assert.ok("summary" in first, "T1 FAIL: 返回行应含 summary");
      assert.ok("status" in first, "T1 FAIL: 返回行应含 status");
      assert.ok("blockedReason" in first, "T1 FAIL: 返回行应含 blockedReason");
      assert.ok("conversationId" in first, "T1 FAIL: 返回行应含 conversationId");
      assert.ok("startedAt" in first, "T1 FAIL: 返回行应含 startedAt");
      assert.ok("endedAt" in first, "T1 FAIL: 返回行应含 endedAt");

      // 降序排序（started_at 降序 → id 最大的排最前）
      const firstId = Number(first.id);
      const lastId = Number(all[all.length - 1].id);
      assert.ok(
        firstId > lastId,
        `T1 FAIL: listDispatchesByRole 应按 started_at 降序，第一条 id=${firstId} 应大于最后一条 id=${lastId}`
      );

      // limit 参数
      const limited = listDispatchesByRole("bookkeeper", 3);
      assert.equal(limited.length, 3, `T1 FAIL: limit=3 时应返回 3 条，实际 ${limited.length}`);

      // offset 参数（limit=3 offset=2 → 第 3/4/5 大的 id）
      const paged = listDispatchesByRole("bookkeeper", 3, 2);
      assert.equal(paged.length, 3, `T1 FAIL: limit=3 offset=2 时应返回 3 条，实际 ${paged.length}`);
      // paged[0] 应是 all[2]（第三条）
      assert.equal(
        Number(paged[0].id),
        Number(all[2].id),
        `T1 FAIL: offset=2 时第一条应为全集第3条 id=${all[2].id}，实际 id=${paged[0].id}`
      );

      // limit 超出实际行数时只返回有的
      const overLimit = listDispatchesByRole("bookkeeper", 100);
      assert.equal(overLimit.length, 5, `T1 FAIL: limit 超出时应返回实际行数 5，实际 ${overLimit.length}`);

      // 不同 roleId 结果独立
      const analystRows = listDispatchesByRole("analyst");
      assert.equal(analystRows.length, 1, `T1 FAIL: analyst 应有 1 条，实际 ${analystRows.length}`);

      // blocked 行的 blockedReason 字段
      const blockedRow = all.find((r) => r.blockedReason != null);
      assert.ok(blockedRow, "T1 FAIL: 应能找到 blockedReason 非空的行（任务 3）");
      assert.ok(
        (blockedRow!.blockedReason as string).includes("export_kingdee_draft"),
        `T1 FAIL: blockedReason 应含 export_kingdee_draft，实际: ${blockedRow!.blockedReason}`
      );

      console.log("agents-space T1: listDispatchesByRole 行为 ✓");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
    }
  }

  // ─── T2：GET /api/agents 源码契约 ─────────────────────────────────────────────
  {
    // 2a：文件存在
    assert.ok(
      exists("app/api/agents/route.ts"),
      "T2 FAIL: app/api/agents/route.ts 应存在"
    );

    const routeSrc = src("app/api/agents/route.ts");

    // 2b：import ROLE_REGISTRY（单一事实源）
    assert.ok(
      routeSrc.includes("ROLE_REGISTRY"),
      "T2 FAIL: /api/agents route 应 import ROLE_REGISTRY（name/charter/dataScope 的单一事实源）"
    );

    // 2c：import getInvoiceLedgerStats（bookkeeper 专项）
    assert.ok(
      routeSrc.includes("getInvoiceLedgerStats"),
      "T2 FAIL: /api/agents route 应 import getInvoiceLedgerStats（bookkeeper invoiceStats）"
    );

    // 2d：读 agent_disabled_roles from app_settings
    assert.ok(
      routeSrc.includes("agent_disabled_roles"),
      "T2 FAIL: /api/agents route 应读 app_settings key 'agent_disabled_roles'（userDisabled）"
    );

    // 2e：返回 roster 数组，逐字段检查（字段名出现在源码中）
    for (const field of ["roleId", "name", "domain", "charter", "dataScope", "skills", "available", "userDisabled", "dispatchCount", "lastAt"]) {
      assert.ok(
        routeSrc.includes(field),
        `T2 FAIL: /api/agents route 应在响应中包含字段 "${field}"`
      );
    }

    // 2f：bookkeeper 专项 invoiceStats
    assert.ok(
      routeSrc.includes("invoiceStats"),
      "T2 FAIL: /api/agents route 应为 bookkeeper 附加 invoiceStats"
    );

    // 2f2（裁决补强 2026-07-02）：技能描述必须来自 skills-store 关联，
    // 不许把 role.skills 的裸 id 原样返回冒充 {name, description}
    assert.ok(
      routeSrc.includes("skills-store") || routeSrc.includes("listSkills"),
      "T2 FAIL: /api/agents route 应关联 skills-store 取技能名称与描述"
    );

    // 2g：export async function GET（符合 Next.js route 惯例）
    assert.ok(
      routeSrc.includes("export") && routeSrc.includes("GET"),
      "T2 FAIL: /api/agents route 应 export async function GET"
    );

    // 2h：返回 NextResponse.json
    assert.ok(
      routeSrc.includes("NextResponse") || routeSrc.includes("Response"),
      "T2 FAIL: /api/agents route 应返回 NextResponse.json 或 Response"
    );

    console.log("agents-space T2: GET /api/agents 源码契约 ✓");
  }

  // ─── T3：GET /api/agents/dispatches 源码契约 ──────────────────────────────────
  {
    // 3a：文件存在
    assert.ok(
      exists("app/api/agents/dispatches/route.ts"),
      "T3 FAIL: app/api/agents/dispatches/route.ts 应存在"
    );

    const routeSrc = src("app/api/agents/dispatches/route.ts");

    // 3b：接线 listDispatchesByRole
    assert.ok(
      routeSrc.includes("listDispatchesByRole"),
      "T3 FAIL: /api/agents/dispatches route 应接线 listDispatchesByRole"
    );

    // 3c：读取 query 参数 roleId
    assert.ok(
      routeSrc.includes("roleId"),
      "T3 FAIL: /api/agents/dispatches route 应读 query 参数 roleId"
    );

    // 3d：读取 limit 参数
    assert.ok(
      routeSrc.includes("limit"),
      "T3 FAIL: /api/agents/dispatches route 应读 query 参数 limit"
    );

    // 3e：读取 offset 参数
    assert.ok(
      routeSrc.includes("offset"),
      "T3 FAIL: /api/agents/dispatches route 应读 query 参数 offset"
    );

    // 3f：export async function GET
    assert.ok(
      routeSrc.includes("export") && routeSrc.includes("GET"),
      "T3 FAIL: /api/agents/dispatches route 应 export async function GET"
    );

    // 3g：返回 NextResponse.json 或 Response
    assert.ok(
      routeSrc.includes("NextResponse") || routeSrc.includes("Response"),
      "T3 FAIL: /api/agents/dispatches route 应返回 NextResponse.json 或 Response"
    );

    console.log("agents-space T3: GET /api/agents/dispatches 源码契约 ✓");
  }

  // ─── T4：app/agents/page.tsx 源码契约与单一事实源守卫 ─────────────────────────
  {
    // 4a：文件存在（可能拆出子组件，page.tsx 必须存在）
    assert.ok(
      exists("app/agents/page.tsx"),
      "T4 FAIL: app/agents/page.tsx 应存在"
    );

    const pageSrc = src("app/agents/page.tsx");

    // 4b：fetch /api/agents
    assert.ok(
      pageSrc.includes("/api/agents"),
      "T4 FAIL: app/agents/page.tsx 应 fetch /api/agents"
    );

    // 4c：「尚未启用」弱化态文案
    assert.ok(
      pageSrc.includes("尚未启用"),
      "T4 FAIL: app/agents/page.tsx 应含文案「尚未启用」（available:false 弱化态）"
    );

    // 4d：「派活」按钮文案
    assert.ok(
      pageSrc.includes("派活"),
      "T4 FAIL: app/agents/page.tsx 应含「派活」入口"
    );

    // 4e：单一事实源守卫——app/agents/ 下不得硬编码任何角色名
    // 检查 page.tsx 本身（子组件由 glob 覆盖）
    const FORBIDDEN_ROLE_NAMES = ["记账专员", "薪税专员", "税务专员", "资金专员", "往来专员", "经营分析师"];
    for (const roleName of FORBIDDEN_ROLE_NAMES) {
      assert.ok(
        !pageSrc.includes(roleName),
        `T4 FAIL（单一事实源守卫）: app/agents/page.tsx 不应硬编码角色名「${roleName}」（应来自 API）`
      );
    }

    // 4f：台账区含「停在确认门」前置逻辑（blockedReason 或等价文案）
    // 页面需要有处理 blocked 状态的逻辑
    assert.ok(
      pageSrc.includes("blocked") ||
      pageSrc.includes("blockedReason") ||
      pageSrc.includes("停在确认门"),
      "T4 FAIL: app/agents/page.tsx 应含台账区「停在确认门」前置逻辑（blockedReason 字段或文案）"
    );

    // 4g：「查看全部」台账入口（触发 /api/agents/dispatches 分页）
    assert.ok(
      pageSrc.includes("查看全部") ||
      pageSrc.includes("/api/agents/dispatches"),
      "T4 FAIL: app/agents/page.tsx 应含台账「查看全部」或对 /api/agents/dispatches 的引用"
    );

    console.log("agents-space T4: app/agents/page.tsx 源码契约 ✓");

    // 4h：单一事实源守卫——扫描 app/agents/ 目录下所有 .tsx/.ts 文件
    // 用 Node.js 递归读 app/agents/ 目录（只需检查文件存在后读取）
    const { readdirSync } = await import("node:fs");
    function grepDir(dir: string, searchStrings: string[]): { file: string; match: string }[] {
      const hits: { file: string; match: string }[] = [];
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return hits;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          hits.push(...grepDir(fullPath, searchStrings));
        } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
          const content = readFileSync(fullPath, "utf-8");
          for (const s of searchStrings) {
            if (content.includes(s)) {
              hits.push({ file: fullPath.replace(PROJECT_ROOT + "/", ""), match: s });
            }
          }
        }
      }
      return hits;
    }

    const agentsDir = path.join(PROJECT_ROOT, "app", "agents");
    if (existsSync(agentsDir)) {
      const hardcodedHits = grepDir(agentsDir, FORBIDDEN_ROLE_NAMES);
      assert.equal(
        hardcodedHits.length,
        0,
        `T4 FAIL（单一事实源守卫）: app/agents/ 目录下不得出现硬编码角色名。发现:\n` +
        hardcodedHits.map((h) => `  ${h.file} 含「${h.match}」`).join("\n")
      );
      console.log("agents-space T4（守卫）: app/agents/ 无硬编码角色名 ✓");
    }
  }

  // ─── T5：app/cockpit/team-panel.tsx「查看全部 →」链接 /agents ──────────────────
  {
    assert.ok(
      exists("app/cockpit/team-panel.tsx"),
      "T5 FAIL: app/cockpit/team-panel.tsx 应存在"
    );

    const tpSrc = src("app/cockpit/team-panel.tsx");

    // 5a：卡底含「查看全部」链接文案
    assert.ok(
      tpSrc.includes("查看全部"),
      "T5 FAIL: app/cockpit/team-panel.tsx 应在卡底含「查看全部 →」文案"
    );

    // 5b：href 指向 /agents
    assert.ok(
      tpSrc.includes("/agents"),
      "T5 FAIL: app/cockpit/team-panel.tsx 应含 href=\"/agents\"（查看全部链接）"
    );

    // 5c：是 <a> 链接或 <Link>（Next.js Link）
    assert.ok(
      tpSrc.includes("<a") || tpSrc.includes("<Link") || tpSrc.includes("href"),
      "T5 FAIL: app/cockpit/team-panel.tsx「查看全部」应是可点击链接（<a> 或 <Link>）"
    );

    console.log("agents-space T5: team-panel.tsx「查看全部 →」链接 /agents ✓");
  }

  console.log("agents-space: all T1–T5 done（上面任何 FAIL 即为红 → 等待实现者实现后才绿）");
})();
