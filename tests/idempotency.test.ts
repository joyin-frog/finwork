import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const idempotencyTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-idemp-test-"));
  const origDb = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = path.join(dir, "test.db");

  try {
    const { withIdempotency } = await import("../lib/agent/tools/idempotency.ts");
    const { getDb } = await import("../lib/db/sqlite.ts");
    getDb(); // 初始化 schema(tool_executions / audit_logs)

    const countExec = (key: string, tool: string) =>
      (getDb()
        .prepare("SELECT COUNT(*) c FROM tool_executions WHERE idempotency_key=? AND tool_name=?")
        .get(key, tool) as { c: number }).c;
    const countAudit = () =>
      (getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE event_type='tool_exec'").get() as { c: number }).c;

    // ── 1. 无 key:handler 每次执行,不缓存,不落 tool_executions ──────────
    {
      let calls = 0;
      const wrapped = withIdempotency("no_key_tool", async () => ({ calls: ++calls }));
      const r1 = await wrapped({});
      const r2 = await wrapped({});
      assert.deepEqual(r1, { calls: 1 }, "无 key 第一次应执行");
      assert.deepEqual(r2, { calls: 2 }, "无 key 第二次应再次执行(不缓存)");
      const rows = (getDb().prepare("SELECT COUNT(*) c FROM tool_executions WHERE tool_name='no_key_tool'").get() as { c: number }).c;
      assert.equal(rows, 0, "无 key 不应写 tool_executions");
    }

    // ── 2. 合法 key:首次执行并缓存,二次命中缓存不再执行 handler ──────────
    {
      let calls = 0;
      const wrapped = withIdempotency("cache_tool", async () => ({ n: ++calls }));
      const key = "idem-key-0001";
      const r1 = await wrapped({ idempotency_key: key });
      const r2 = await wrapped({ idempotency_key: key });
      assert.deepEqual(r1, { n: 1 }, "首次应执行 handler");
      assert.deepEqual(r2, { n: 1 }, "二次应返回缓存结果,handler 不重跑");
      assert.equal(calls, 1, "handler 只应被调用一次");
      assert.equal(countExec(key, "cache_tool"), 1, "应写入一行 tool_executions");
    }

    // ── 3. 缓存错误:首次抛错被缓存,二次仍抛(不重跑 handler) ────────────
    {
      let calls = 0;
      const wrapped = withIdempotency("error_tool", async () => {
        calls++;
        throw new Error("boom");
      });
      const key = "idem-key-err-1";
      await assert.rejects(() => wrapped({ idempotency_key: key }), /boom/, "首次应抛出原始错误");
      // 二次:命中缓存的错误对象({message})后被 throw
      await assert.rejects(
        () => wrapped({ idempotency_key: key }),
        (e: unknown) => (e as { message?: string })?.message === "boom",
        "二次应抛出缓存的错误"
      );
      assert.equal(calls, 1, "失败的 handler 不应在缓存命中时重跑");
    }

    // ── 4. key 过短(<8)视同无 key:每次执行,不缓存 ──────────────────────
    {
      let calls = 0;
      const wrapped = withIdempotency("short_key_tool", async () => ({ n: ++calls }));
      const r1 = await wrapped({ idempotency_key: "short" });
      const r2 = await wrapped({ idempotency_key: "short" });
      assert.deepEqual(r1, { n: 1 });
      assert.deepEqual(r2, { n: 2 }, "过短 key 不缓存,应重跑");
    }

    // ── 5. 同 key 不同 tool 互不干扰 ─────────────────────────────────────
    {
      const key = "idem-shared-key-9";
      const wrappedA = withIdempotency("tool_a", async () => ({ who: "a" }));
      const wrappedB = withIdempotency("tool_b", async () => ({ who: "b" }));
      const ra = await wrappedA({ idempotency_key: key });
      const rb = await wrappedB({ idempotency_key: key });
      assert.deepEqual(ra, { who: "a" });
      assert.deepEqual(rb, { who: "b" }, "同 key 不同 tool 应各自独立");
      assert.equal(countExec(key, "tool_a"), 1);
      assert.equal(countExec(key, "tool_b"), 1);
    }

    // ── 6. 审计:medium/high 每次执行都落 audit_logs,low/无 不落 ─────────
    {
      const before = countAudit();

      const lowTool = withIdempotency("audit_low", async () => ({}), { riskLevel: "low" });
      await lowTool({});
      assert.equal(countAudit(), before, "low 风险不应写审计");

      const medTool = withIdempotency("audit_med", async () => ({}), { riskLevel: "medium" });
      await medTool({});
      await medTool({}); // 不依赖 key,每次都审计
      assert.equal(countAudit(), before + 2, "medium 风险应每次执行都写审计");

      const highTool = withIdempotency("audit_high", async () => ({}), { riskLevel: "high" });
      await highTool({});
      assert.equal(countAudit(), before + 3, "high 风险应写审计");
    }

    // 注意:不关闭 getDb() 单例——它是整个测试套件共享的进程级资源,
    // 显式关闭会与延迟启动备份(setImmediate)竞争并污染后续测试(database is not open)。
    // 进程退出时自动回收,与其余测试保持一致。
  } finally {
    if (origDb === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = origDb;
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("idempotency: all 6 checks passed ✓");
})();
