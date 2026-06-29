import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { NextResponse } from "next/server";

export const withApiErrorTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-apierr-test-"));
  const origDb = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = path.join(dir, "test.db");

  try {
    const { withApiError } = await import("../lib/api/with-api-error.ts");
    const { fetchUnreportedAppErrors } = await import("../lib/runtime/app-errors.ts");
    const { getDb } = await import("../lib/db/sqlite.ts");
    getDb(); // 初始化 schema(app_errors)

    const errorsFor = (source: string) =>
      fetchUnreportedAppErrors(500).filter((e) => e.source === source);

    // ── 1. 成功路径:原样透传 handler 的 Response,不记录错误 ─────────────
    {
      const source = "/api/ok";
      const handler = withApiError(async () => NextResponse.json({ ok: true, value: 42 }, { status: 200 }), source);
      const res = await handler();
      assert.equal(res.status, 200, "成功应保留 handler 的 200");
      const body = (await res.json()) as { ok: boolean; value: number };
      assert.deepEqual(body, { ok: true, value: 42 }, "成功应原样透传 body");
      assert.equal(errorsFor(source).length, 0, "成功不应记录 app_errors");
    }

    // ── 2. handler 抛 Error:返回结构化 500,并记录一条 api 错误 ───────────
    {
      const source = "/api/throws";
      const handler = withApiError(async () => {
        throw new Error("test handler exploded");
      }, source);
      const res = await handler();
      assert.equal(res.status, 500, "抛错应返回 500");
      const body = (await res.json()) as { ok: boolean; error: string };
      assert.equal(body.ok, false, "错误响应 ok 应为 false");
      assert.equal(body.error, "服务暂时不可用,请稍后重试", "应返回统一兜底文案,不泄露内部错误");

      const recorded = errorsFor(source);
      assert.equal(recorded.length, 1, "应记录恰好一条 app_errors");
      assert.equal(recorded[0].kind, "api", "kind 应为 api");
      assert.equal(recorded[0].message, "test handler exploded", "应记录原始错误消息");
    }

    // ── 3. handler 抛非 Error(字符串):强制转为 Error 并记录其字符串 ──────
    {
      const source = "/api/throws-string";
      const handler = withApiError(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "plain string failure";
      }, source);
      const res = await handler();
      assert.equal(res.status, 500, "非 Error 抛出仍应返回 500");
      const recorded = errorsFor(source);
      assert.equal(recorded.length, 1, "非 Error 抛出也应记录");
      assert.equal(recorded[0].message, "plain string failure", "非 Error 应被 String() 转换后记录");
    }

    // 不关闭 getDb() 单例(进程级共享资源),避免与延迟备份竞争污染后续测试。
  } finally {
    if (origDb === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = origDb;
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("with-api-error: all 3 checks passed ✓");
})();
