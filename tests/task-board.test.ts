/**
 * task-board.test.ts
 *
 * 覆盖：
 * - TB1–TB5  五档状态优先级（running / locked / blocked / failed / pending）
 * - TB6      success + blockedReason + locked → locked
 * - TB7      success + blockedReason（未锁）→ blocked
 * - TB8      reviewStatus=NULL + success → pending（旧数据兜底）
 * - TB9      cards 内按 startedAt 降序
 * - TB10     counts 无零值键
 * - TB11     subagent 型无派发 → empty 节点 + startHref
 * - TB12     main-skill 型 → manual 节点 + startHref
 * - TB13     startHref 与 buildTemplateDispatchHref 一致
 * - SC1      task-board.tsx 不含 fetch(
 * - SC2      task-board.tsx 含 /chat/recent?id=
 * - SC3      app/api/agents/route.ts 含 deriveTaskBoard(
 * - SC4      app/api/agents/route.ts 含 listDispatchesForPeriod(
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/task-board.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");
}

export const taskBoardTestPromise = (async () => {
  // ── 导入被测模块 ──────────────────────────────────────────────────────────
  const { deriveTaskBoard } = await import("../lib/domain/task-board.ts");
  const { TASK_TEMPLATES, buildTemplateDispatchHref, currentYearMonth } =
    await import("../lib/agent/roles/task-templates.ts");
  const { getRoleDefinition } = await import("../lib/agent/roles/registry.ts");

  const PERIOD = "2026-07";

  // 小工具：构造最小 DispatchRow
  function makeRow(
    overrides: Partial<{
      id: number;
      roleId: string;
      taskTemplateId: string | null;
      status: string;
      reviewStatus: string | null;
      blockedReason: string | null;
      summary: string | null;
      businessObject: string | null;
      conversationId: string | null;
      startedAt: string | null;
      label: string | null;
    }>
  ) {
    return {
      id: overrides.id ?? 1,
      roleId: overrides.roleId ?? "bookkeeper",
      label: overrides.label ?? null,
      summary: overrides.summary ?? null,
      status: overrides.status ?? "success",
      blockedReason: overrides.blockedReason ?? null,
      conversationId: overrides.conversationId ?? null,
      startedAt: overrides.startedAt ?? "2026-07-01T10:00:00",
      endedAt: null,
      taskTemplateId: overrides.taskTemplateId !== undefined ? overrides.taskTemplateId : "month-close-precheck",
      businessObject: overrides.businessObject ?? null,
      period: PERIOD,
      reviewStatus: overrides.reviewStatus !== undefined ? overrides.reviewStatus : null,
    };
  }

  // ─── TB1 running 优先级最高 ────────────────────────────────────────────────
  {
    const row = makeRow({ status: "running", reviewStatus: "locked", blockedReason: "gate" });
    const board = deriveTaskBoard(TASK_TEMPLATES, [row], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB1: 应为 cards 节点");
    assert.equal(node.cards[0].state, "running", "TB1 FAIL: running 行状态应为 running（最高优先）");
    console.log("task-board TB1: running 优先级 ✓");
  }

  // ─── TB2 locked 排在 blocked 之前 ─────────────────────────────────────────
  {
    const row = makeRow({ status: "success", reviewStatus: "locked", blockedReason: "gate" });
    const board = deriveTaskBoard(TASK_TEMPLATES, [row], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB2: 应为 cards 节点");
    assert.equal(node.cards[0].state, "locked", "TB2 FAIL: reviewStatus=locked 行状态应为 locked（优先于 blocked）");
    console.log("task-board TB2: locked > blocked 优先级 ✓");
  }

  // ─── TB3 blocked（blockedReason 非空，未 locked） ─────────────────────────
  {
    const row = makeRow({ status: "success", reviewStatus: "pending", blockedReason: "export_kingdee_draft" });
    const board = deriveTaskBoard(TASK_TEMPLATES, [row], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB3: 应为 cards 节点");
    assert.equal(node.cards[0].state, "blocked", "TB3 FAIL: blockedReason 非空且未 locked → blocked");
    console.log("task-board TB3: blocked 优先级 ✓");
  }

  // ─── TB4 failed ────────────────────────────────────────────────────────────
  {
    const row = makeRow({ status: "failed", reviewStatus: null, blockedReason: null });
    const board = deriveTaskBoard(TASK_TEMPLATES, [row], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB4: 应为 cards 节点");
    assert.equal(node.cards[0].state, "failed", "TB4 FAIL: failed 行状态应为 failed");
    console.log("task-board TB4: failed 优先级 ✓");
  }

  // ─── TB5 pending（success，无 blockedReason，reviewStatus=pending） ────────
  {
    const row = makeRow({ status: "success", reviewStatus: "pending", blockedReason: null });
    const board = deriveTaskBoard(TASK_TEMPLATES, [row], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB5: 应为 cards 节点");
    assert.equal(node.cards[0].state, "pending", "TB5 FAIL: success+reviewStatus=pending+无 blockedReason → pending");
    console.log("task-board TB5: pending 优先级 ✓");
  }

  // ─── TB6 success + blockedReason + locked → locked ────────────────────────
  {
    const row = makeRow({ status: "success", reviewStatus: "locked", blockedReason: "export_kingdee_draft" });
    const board = deriveTaskBoard(TASK_TEMPLATES, [row], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB6: 应为 cards 节点");
    assert.equal(node.cards[0].state, "locked", "TB6 FAIL: locked 应覆盖 blockedReason");
    console.log("task-board TB6: success+blockedReason+locked → locked ✓");
  }

  // ─── TB7 success + blockedReason（未锁）→ blocked ─────────────────────────
  {
    const row = makeRow({ status: "success", reviewStatus: "pending", blockedReason: "export_kingdee_draft" });
    const board = deriveTaskBoard(TASK_TEMPLATES, [row], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB7: 应为 cards 节点");
    assert.equal(node.cards[0].state, "blocked", "TB7 FAIL: success+blockedReason（未锁）→ blocked");
    console.log("task-board TB7: success+blockedReason（未锁）→ blocked ✓");
  }

  // ─── TB8 reviewStatus=NULL + success → pending（旧数据兜底） ─────────────
  {
    const row = makeRow({ status: "success", reviewStatus: null, blockedReason: null });
    const board = deriveTaskBoard(TASK_TEMPLATES, [row], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB8: 应为 cards 节点");
    assert.equal(node.cards[0].state, "pending", "TB8 FAIL: reviewStatus=NULL+success → pending（旧数据兜底）");
    console.log("task-board TB8: reviewStatus=NULL+success → pending ✓");
  }

  // ─── TB9 cards 内按 startedAt 降序 ────────────────────────────────────────
  {
    const r1 = makeRow({ id: 10, startedAt: "2026-07-01T08:00:00", status: "success" });
    const r2 = makeRow({ id: 20, startedAt: "2026-07-05T12:00:00", status: "success" });
    const r3 = makeRow({ id: 30, startedAt: "2026-07-03T15:00:00", status: "success" });
    // 入参已按 startedAt DESC 排好（模拟 listDispatchesForPeriod 的排序）
    const sorted = [r2, r3, r1];
    const board = deriveTaskBoard(TASK_TEMPLATES, sorted, PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB9: 应为 cards 节点");
    assert.equal(node.cards.length, 3, `TB9 FAIL: 应有 3 张卡，实际 ${node.cards.length}`);
    // 顺序应与入参一致（domain 不重排，store 已按 startedAt DESC 返回）
    assert.equal(node.cards[0].dispatchId, 20, "TB9 FAIL: 第一张应为 id=20（最新）");
    assert.equal(node.cards[2].dispatchId, 10, "TB9 FAIL: 最后一张应为 id=10（最旧）");
    console.log("task-board TB9: 卡片顺序 ✓");
  }

  // ─── TB10 counts 无零值键 ─────────────────────────────────────────────────
  {
    const rows = [
      makeRow({ id: 1, status: "success", reviewStatus: "pending", blockedReason: null }),
      makeRow({ id: 2, status: "success", reviewStatus: "pending", blockedReason: null }),
    ];
    const board = deriveTaskBoard(TASK_TEMPLATES, rows, PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node && node.kind === "cards", "TB10: 应为 cards 节点");
    for (const [key, val] of Object.entries(node.counts)) {
      assert.ok((val ?? 0) > 0, `TB10 FAIL: counts["${key}"] 应为非零值，实际 ${val}`);
    }
    assert.equal(node.counts.pending, 2, `TB10 FAIL: pending 应为 2，实际 ${node.counts.pending}`);
    console.log("task-board TB10: counts 无零值键 ✓");
  }

  // ─── TB11 subagent 型无派发 → empty 节点 + startHref ──────────────────────
  {
    // 传空数组，month-close-precheck（subagent 型）应为 empty
    const board = deriveTaskBoard(TASK_TEMPLATES, [], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "month-close-precheck");
    assert.ok(node, "TB11: 节点应存在");
    assert.equal(node.kind, "empty", `TB11 FAIL: 无派发的 subagent 模板应为 empty，实际 ${node.kind}`);
    assert.ok("startHref" in node, "TB11 FAIL: empty 节点应含 startHref");
    assert.ok((node as { startHref: string }).startHref.startsWith("/chat/new"), "TB11 FAIL: startHref 应以 /chat/new 开头");
    console.log("task-board TB11: empty 节点 ✓");
  }

  // ─── TB12 main-skill 型 → manual 节点 ─────────────────────────────────────
  {
    const board = deriveTaskBoard(TASK_TEMPLATES, [], PERIOD);
    const node = board.nodes.find((n) => n.templateId === "filing-precheck");
    assert.ok(node, "TB12: filing-precheck 节点应存在");
    assert.equal(node.kind, "manual", `TB12 FAIL: main-skill 模板应为 manual 节点，实际 ${node.kind}`);
    assert.ok("note" in node, "TB12 FAIL: manual 节点应含 note");
    assert.ok("startHref" in node, "TB12 FAIL: manual 节点应含 startHref");
    const manualNode = node as { startHref: string; note: string };
    assert.ok(manualNode.startHref.includes("filing-precheck"), "TB12 FAIL: startHref 应含 filing-precheck");
    assert.ok(manualNode.note.length > 0, "TB12 FAIL: note 应非空");
    console.log("task-board TB12: manual 节点 ✓");
  }

  // ─── TB13 startHref 与 buildTemplateDispatchHref 一致 ─────────────────────
  {
    const board = deriveTaskBoard(TASK_TEMPLATES, [], PERIOD);
    for (const t of TASK_TEMPLATES) {
      const node = board.nodes.find((n) => n.templateId === t.id);
      assert.ok(node, `TB13: 节点 ${t.id} 应存在`);
      if (node.kind === "empty" || node.kind === "manual") {
        const roleName = getRoleDefinition(t.roleId)?.name ?? t.roleId;
        const expected = buildTemplateDispatchHref(t, roleName, PERIOD);
        assert.equal(
          (node as { startHref: string }).startHref,
          expected,
          `TB13 FAIL: 模板 ${t.id} startHref 与 buildTemplateDispatchHref 不一致`
        );
      }
    }
    console.log("task-board TB13: startHref 与 buildTemplateDispatchHref 一致 ✓");
  }

  // ─── 源码契约 ─────────────────────────────────────────────────────────────

  // SC1: task-board.tsx 不含 fetch(
  {
    const taskBoardSrc = src("app/agents/task-board.tsx");
    assert.ok(
      !taskBoardSrc.includes("fetch("),
      "SC1 FAIL: app/agents/task-board.tsx 不得含 fetch(（看板零动作铁律）"
    );
    console.log("task-board SC1: task-board.tsx 无 fetch( ✓");
  }

  // SC2: task-board.tsx 含 /chat/recent?id=
  {
    const taskBoardSrc = src("app/agents/task-board.tsx");
    assert.ok(
      taskBoardSrc.includes("/chat/recent?id="),
      "SC2 FAIL: app/agents/task-board.tsx 应含会话深链 /chat/recent?id="
    );
    console.log("task-board SC2: task-board.tsx 含 /chat/recent?id= ✓");
  }

  // SC3: route.ts 含 deriveTaskBoard(
  {
    const routeSrc = src("app/api/agents/route.ts");
    assert.ok(
      routeSrc.includes("deriveTaskBoard("),
      "SC3 FAIL: app/api/agents/route.ts 应调用 deriveTaskBoard("
    );
    console.log("task-board SC3: route.ts 含 deriveTaskBoard( ✓");
  }

  // SC4: route.ts 含 listDispatchesForPeriod(
  {
    const routeSrc = src("app/api/agents/route.ts");
    assert.ok(
      routeSrc.includes("listDispatchesForPeriod("),
      "SC4 FAIL: app/api/agents/route.ts 应调用 listDispatchesForPeriod("
    );
    console.log("task-board SC4: route.ts 含 listDispatchesForPeriod( ✓");
  }

  // ─── currentYearMonth 可注入 Date ─────────────────────────────────────────
  {
    const d = new Date("2026-07-15T12:00:00");
    assert.equal(currentYearMonth(d), "2026-07", "currentYearMonth FAIL: 注入 Date 应返回 2026-07");
    const d2 = new Date("2025-01-01T00:00:00");
    assert.equal(currentYearMonth(d2), "2025-01", "currentYearMonth FAIL: 注入 Date 应返回 2025-01");
    console.log("task-board currentYearMonth: 可注入 Date ✓");
  }

  console.log("task-board: all TB1–TB13 + SC1–SC4 ✓");
})();
