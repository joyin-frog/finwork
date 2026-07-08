import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as React from "react";

// tsx 直跑 .tsx 用 classic JSX 转换，需要 React 在全局作用域
(globalThis as Record<string, unknown>).React = React;

/** 辅助：建 in-memory db 并跑到 v10 */
async function makeTestDb() {
  const { MIGRATIONS } = await import("../lib/db/migrations.ts");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE chat_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      claude_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      claude_session_updated_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL DEFAULT 'default-user'
    )
  `);
  const v10 = MIGRATIONS.find((m) => m.version === 10);
  if (!v10) throw new Error("v10 migration not found");
  v10.up(db);
  return db;
}

export const artifactChecklistTestPromise = (async () => {
  // ── 预先验证：migrations 末尾版本 ≥ v10（v11 知识库语义索引已加入）────────────
  const { MIGRATIONS, LATEST_VERSION } = await import("../lib/db/migrations.ts");
  assert.ok(LATEST_VERSION >= 10, `MIGRATIONS 末尾版本应 ≥ v10，实际 ${LATEST_VERSION}`);

  // ── A1: v10 artifacts 表 DDL 形状 ────────────────────────────────────────────
  const db1 = await makeTestDb();

  // 验证 artifacts 表存在
  const tableExists = db1.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'"
  ).get() as { name: string } | undefined;
  assert.ok(tableExists, "A1 FAIL: artifacts 表未创建");

  // 验证列结构
  const cols = db1.prepare("PRAGMA table_info(artifacts)").all() as Array<{
    cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }>;
  const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

  assert.ok(colMap["id"], "A1 FAIL: 缺 id 列");
  assert.equal(colMap["id"].type.toUpperCase(), "TEXT", "A1 FAIL: id 应为 TEXT");
  assert.equal(colMap["id"].pk, 1, "A1 FAIL: id 应为 PRIMARY KEY");

  assert.ok(colMap["kind"], "A1 FAIL: 缺 kind 列");
  assert.equal(colMap["kind"].notnull, 1, "A1 FAIL: kind 应 NOT NULL");
  assert.equal(colMap["kind"].dflt_value, "'checklist'", "A1 FAIL: kind DEFAULT 应为 'checklist'");

  assert.ok(colMap["conversation_id"], "A1 FAIL: 缺 conversation_id 列");
  assert.equal(colMap["conversation_id"].notnull, 0, "A1 FAIL: conversation_id 允许 NULL");

  assert.ok(colMap["title"], "A1 FAIL: 缺 title 列");
  assert.equal(colMap["title"].notnull, 1, "A1 FAIL: title 应 NOT NULL");

  assert.ok(colMap["payload"], "A1 FAIL: 缺 payload 列");
  assert.equal(colMap["payload"].notnull, 1, "A1 FAIL: payload 应 NOT NULL");

  assert.ok(colMap["state"], "A1 FAIL: 缺 state 列");
  assert.equal(colMap["state"].notnull, 1, "A1 FAIL: state 应 NOT NULL");
  assert.equal(colMap["state"].dflt_value, "'{}'", "A1 FAIL: state DEFAULT 应为 '{}'");

  assert.ok(colMap["created_at"], "A1 FAIL: 缺 created_at 列");
  assert.ok(colMap["updated_at"], "A1 FAIL: 缺 updated_at 列");

  // 验证索引存在
  const indexes = db1.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='artifacts'"
  ).all() as Array<{ name: string }>;
  const indexNames = indexes.map((i) => i.name);
  assert.ok(
    indexNames.some((n) => n.includes("conversation_id")),
    "A1 FAIL: 缺 conversation_id 索引"
  );

  // ── A2: ON DELETE CASCADE 级联删除断言 ──────────────────────────────────────
  const db2 = await makeTestDb();

  // 插入一条会话
  db2.exec(`
    INSERT INTO chat_conversations (id, title, user_id, created_at, updated_at)
    VALUES (1, '测试会话', 'default-user', datetime('now'), datetime('now'))
  `);

  // 插入一个工件（绑定到会话 1）
  db2.exec(`
    INSERT INTO artifacts (id, kind, conversation_id, title, payload, state)
    VALUES ('art-001', 'checklist', 1, '测试清单', '{"items":[]}', '{}')
  `);

  // 删除会话，工件应随之被删
  db2.exec("DELETE FROM chat_conversations WHERE id = 1");

  const artifactAfterDelete = db2.prepare(
    "SELECT id FROM artifacts WHERE id = 'art-001'"
  ).get() as { id: string } | undefined;
  assert.equal(artifactAfterDelete, undefined, "A2 FAIL: 删除 conversation 后 artifact 应被级联删除");

  // 插入 conversation_id 为 NULL 的工件（不应被级联影响）
  db2.exec(`
    INSERT INTO artifacts (id, kind, conversation_id, title, payload, state)
    VALUES ('art-null', 'checklist', NULL, '孤儿清单', '{"items":[]}', '{}')
  `);
  const orphanArtifact = db2.prepare(
    "SELECT id FROM artifacts WHERE id = 'art-null'"
  ).get() as { id: string } | undefined;
  assert.ok(orphanArtifact, "A2 FAIL: conversation_id=NULL 的 artifact 不应被级联删除");

  // ── A3: artifact-store createArtifact / getArtifact / patchArtifactState ────
  const { createArtifact, getArtifact, patchArtifactState } = await import("../lib/db/artifact-store.ts");
  const db3 = await makeTestDb();

  // createArtifact
  const items = [
    { id: "item-1", label: "检查项一", detail: "详情", severity: "warn" as const },
    { id: "item-2", label: "检查项二" },
  ];
  const artifactId = createArtifact(db3, {
    title: "申报前复核",
    items,
    conversationId: null,
  });
  assert.ok(typeof artifactId === "string" && artifactId.length > 0, "A3 FAIL: createArtifact 应返回 uuid 字符串");

  // getArtifact
  const retrieved = getArtifact(db3, artifactId);
  assert.ok(retrieved, "A3 FAIL: getArtifact 应返回已创建的 artifact");
  assert.equal(retrieved!.title, "申报前复核", "A3 FAIL: title 应匹配");
  assert.equal(retrieved!.kind, "checklist", "A3 FAIL: kind 应为 checklist");
  assert.deepEqual(retrieved!.items, items, "A3 FAIL: items 应完整保存");
  assert.deepEqual(retrieved!.state, {}, "A3 FAIL: 初始 state 应为空对象");

  // patchArtifactState - 合法 state
  const patched = patchArtifactState(db3, artifactId, "item-1", "done");
  assert.ok(patched, "A3 FAIL: patchArtifactState 应返回 true");
  const updated = getArtifact(db3, artifactId);
  assert.equal(updated!.state["item-1"], "done", "A3 FAIL: 勾选状态应更新");

  // patchArtifactState - 非法 itemId
  assert.throws(
    () => patchArtifactState(db3, artifactId, "nonexistent-item", "done"),
    /itemId.*不存在|不在 payload/,
    "A3 FAIL: 非法 itemId 应抛出错误"
  );

  // patchArtifactState - 非法 state 枚举
  assert.throws(
    () => patchArtifactState(db3, artifactId, "item-1", "invalid_state" as "done"),
    /state.*枚举|无效的 state/,
    "A3 FAIL: 非法 state 枚举应抛出错误"
  );

  // getArtifact - 不存在的 id
  const notFound = getArtifact(db3, "nonexistent-uuid");
  assert.equal(notFound, null, "A3 FAIL: 不存在的 artifact 应返回 null");

  // ── A4: emit_checklist 工具定义与落库 ──────────────────────────────────────
  const { createEmitChecklistTool } = await import("../lib/agent/mcp-tools/emit-checklist.ts");

  type MockTool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };
  const mockSdk = {
    tool: (name: string, _desc: string, _schema: unknown, handler: MockTool["handler"]): MockTool => ({ name, handler })
  };

  const emitDb = await makeTestDb();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emitTool = createEmitChecklistTool(mockSdk as any, emitDb, undefined) as MockTool;
  assert.equal(emitTool.name, "emit_checklist", "A4 FAIL: 工具名称应为 emit_checklist");

  // 调用工具
  const emitResult = await emitTool.handler({
    title: "测试清单工具",
    items: [
      { label: "待办项A", detail: "说明A", severity: "warn" },
      { label: "待办项B" },
    ]
  }) as { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean };

  assert.ok(!emitResult.isError, "A4 FAIL: 正常调用不应返回 isError");
  assert.ok(emitResult.structuredContent, "A4 FAIL: 应返回 structuredContent");

  const sc = emitResult.structuredContent as {
    kind: string; artifactId: string; title: string;
    items: Array<{ id: string; label: string; detail?: string; severity?: string }>;
  };
  assert.equal(sc.kind, "artifact_checklist", "A4 FAIL: structuredContent.kind 应为 artifact_checklist");
  assert.ok(sc.artifactId, "A4 FAIL: structuredContent 应含 artifactId");
  assert.equal(sc.title, "测试清单工具", "A4 FAIL: structuredContent.title 应匹配");
  assert.equal(sc.items.length, 2, "A4 FAIL: items 数量应为 2");
  assert.ok(sc.items[0].id, "A4 FAIL: 每个 item 应有稳定 id");

  // 工件应已落库
  const storedArtifact = getArtifact(emitDb, sc.artifactId);
  assert.ok(storedArtifact, "A4 FAIL: 工具调用后 artifact 应已落库");
  assert.equal(storedArtifact!.title, "测试清单工具", "A4 FAIL: 落库 title 应匹配");

  // 上限：超过 50 项应报错
  const tooManyItems = Array.from({ length: 51 }, (_, i) => ({ label: `项${i + 1}` }));
  const overLimitResult = await emitTool.handler({
    title: "超限测试",
    items: tooManyItems,
  }) as { isError?: boolean; content: Array<{ text: string }> };
  assert.ok(overLimitResult.isError, "A4 FAIL: 超过 50 项应返回 isError");

  // ── A5: API route GET/PATCH 三路径（含 400）─────────────────────────────────
  // 使用 handleGet/handlePatch（注入 emitDb，避免依赖 getDb() 单例）
  const { handleGet, handlePatch } = await import("../app/api/artifacts/[id]/handlers.ts");

  // GET - 存在的 artifact
  {
    const res = handleGet(emitDb, sc.artifactId);
    assert.equal(res.status, 200, "A5 FAIL: GET 已存在的 artifact 应返回 200");
    const body = await res.json() as Record<string, unknown>;
    assert.ok(body.title, "A5 FAIL: GET 响应应含 title");
    assert.ok("state" in body, "A5 FAIL: GET 响应应含 state");
    assert.ok("items" in body, "A5 FAIL: GET 响应应含 items");
  }

  // GET - 不存在的 artifact → 404
  {
    const res = handleGet(emitDb, "no-such-id");
    assert.equal(res.status, 404, "A5 FAIL: GET 不存在的 artifact 应返回 404");
  }

  // PATCH - 合法请求
  {
    const res = await handlePatch(emitDb, sc.artifactId, { itemId: sc.items[0].id, state: "done" });
    assert.equal(res.status, 200, "A5 FAIL: PATCH 合法请求应返回 200");
    const body = await res.json() as Record<string, unknown>;
    const updatedState = body.state as Record<string, string>;
    assert.equal(updatedState[sc.items[0].id], "done", "A5 FAIL: PATCH 后 state 应更新");
  }

  // PATCH - 非法 itemId → 400
  {
    const res = await handlePatch(emitDb, sc.artifactId, { itemId: "bad-item-id", state: "done" });
    assert.equal(res.status, 400, "A5 FAIL: PATCH 非法 itemId 应返回 400");
    const body = await res.json() as Record<string, unknown>;
    assert.ok(
      typeof body.error === "string" && body.error.length > 0,
      "A5 FAIL: 400 响应应有中文 error 提示"
    );
  }

  // PATCH - 非法 state 枚举 → 400
  {
    const res = await handlePatch(emitDb, sc.artifactId, { itemId: sc.items[0].id, state: "invalid_state" });
    assert.equal(res.status, 400, "A5 FAIL: PATCH 非法 state 枚举应返回 400");
  }

  // ── A6: ChecklistCard parse（finance-cards 模板）──────────────────────────
  const { parseChecklistStructured } = await import("../app/components/checklist-card.tsx");

  // 合法 payload
  const validStructured = {
    kind: "artifact_checklist",
    artifactId: "art-test",
    title: "清单卡片测试",
    items: [
      { id: "i1", label: "检查项一", severity: "warn" },
      { id: "i2", label: "检查项二", detail: "详情" },
    ],
  };
  const parsed = parseChecklistStructured(validStructured);
  assert.ok(parsed, "A6 FAIL: 合法 payload 应解析成功");
  assert.equal(parsed!.artifactId, "art-test", "A6 FAIL: artifactId 应匹配");
  assert.equal(parsed!.title, "清单卡片测试", "A6 FAIL: title 应匹配");
  assert.equal(parsed!.items.length, 2, "A6 FAIL: items 数量应为 2");
  assert.equal(parsed!.items[0].severity, "warn", "A6 FAIL: severity 应保留");

  // 缺必要字段 → null
  assert.equal(parseChecklistStructured(null), null, "A6 FAIL: null 应返回 null");
  assert.equal(parseChecklistStructured({ kind: "artifact_checklist" }), null, "A6 FAIL: 缺 artifactId/items 应返回 null");
  assert.equal(
    parseChecklistStructured({ kind: "artifact_checklist", artifactId: "x", title: "t", items: "not-array" }),
    null,
    "A6 FAIL: items 非数组应返回 null"
  );

  // ── A7: TOOLS_WITH_RESULT_CARD 白名单守卫 ──────────────────────────────────
  const { TOOL_REGISTRY } = await import("../lib/agent/tools/registry.ts");
  const { hasToolSummary } = await import("../lib/agent/tools/renderers.ts");

  // emit_checklist 应在 TOOL_REGISTRY（safe + finance）
  const emitInRegistry = TOOL_REGISTRY.some(
    (t) => t.name === "mcp__finance_worker__emit_checklist" && t.category === "finance" && t.riskLevel === "safe"
  );
  assert.ok(emitInRegistry, "A7 FAIL: emit_checklist 应在 TOOL_REGISTRY(safe/finance)");

  // emit_checklist 应有中文摘要
  assert.ok(hasToolSummary("emit_checklist"), "A7 FAIL: emit_checklist 应有 renderer summary");

  // ── A8: json_patch 并发语义——两次交错 patch 互不覆盖 ──────────────────────────
  // 验证 patchArtifactState 的原子 UPDATE 让并发修改不相互覆盖：
  // patch item-1 → "done" 与 patch item-2 → "ignored" 同时执行后，两个状态均应保留。
  {
    const { createArtifact: ca, patchArtifactState: pa, getArtifact: ga } = await import("../lib/db/artifact-store.ts");
    const dbConc = await makeTestDb();
    const concItems = [
      { id: "c-item-1", label: "并发项一" },
      { id: "c-item-2", label: "并发项二" },
      { id: "c-item-3", label: "并发项三" },
    ];
    const concId = ca(dbConc, { title: "并发测试清单", items: concItems, conversationId: null });

    // 先串行打入一个初始状态，确认基准
    pa(dbConc, concId, "c-item-3", "done");

    // 两次交错 patch：模拟并发——因为 node:sqlite DatabaseSync 是同步的，
    // 我们用 Promise.all 包两个同步调用，等价于验证各自的原子 UPDATE 不互覆。
    await Promise.all([
      Promise.resolve(pa(dbConc, concId, "c-item-1", "done")),
      Promise.resolve(pa(dbConc, concId, "c-item-2", "ignored")),
    ]);

    const concResult = ga(dbConc, concId);
    assert.equal(concResult!.state["c-item-1"], "done",    "A8 FAIL: c-item-1 应为 done");
    assert.equal(concResult!.state["c-item-2"], "ignored", "A8 FAIL: c-item-2 应为 ignored");
    assert.equal(concResult!.state["c-item-3"], "done",    "A8 FAIL: c-item-3 初始状态应保留");
  }

  console.log("artifact-checklist: all 8 checks passed ✓");
})();
