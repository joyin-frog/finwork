/**
 * session-trust.test.ts — 会话级信任存储 + 确认链行为
 *
 * run_python 已改为默认授权（不弹确认卡）；信任存储 / sentinel / revoke / trust API
 * 仍保留，供历史勾选路径与其它可 trustable 工具使用。
 *
 * (a) 存储:trust/isTrusted、conversationId 隔离
 * (b) risk-confirm:run_python 一律 allow；其它高风险仍 confirm 且 trustable falsy
 * (c) chain.ts:对仍需确认的工具 — sentinel → allow+写信任;普通确认不写;取消 deny
 * (d) 无 resolver 时：run_python 仍 allow；其它高风险仍 deny
 * (e) 组件源码契约
 * (f) revoke / list
 * (g) trust route
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 待测模块 ─────────────────────────────────────────────────────────────────
import {
  SESSION_TRUST_CONFIRM_ANSWER,
  trustToolForConversation,
  isToolTrustedForConversation,
  revokeToolTrust,
  listTrustedTools,
} from "../lib/agent/hooks/session-trust.ts";
import { createRiskConfirmHook, createUnwiredToolHook } from "../lib/agent/hooks/built-in.ts";
import { runBeforeHooks } from "../lib/agent/hooks/chain.ts";

// ── 工具常量 ──────────────────────────────────────────────────────────────────
const RUN_PYTHON = "mcp__finance_worker__run_python";
const OTHER_HIGH = "mcp__finance_worker__calculate_payroll_batch";
const KINGDEE = "mcp__kingdee_worker__export_kingdee_draft";

/** 清空进程级信任存储（测试隔离用）。 */
const TRUST_SYMBOL = Symbol.for("finance-agent.run-python-session-trust");
function clearTrustStore(): void {
  const g = globalThis as typeof globalThis & { [TRUST_SYMBOL]?: Set<string> };
  if (g[TRUST_SYMBOL]) g[TRUST_SYMBOL].clear();
}

function makeCtx(
  toolName: string,
  opts: {
    resolver?: ((q: { question: string; kind?: string; trustable?: boolean }) => Promise<string>) | undefined;
    conversationId?: number;
  } = {}
) {
  return {
    toolName,
    input: { year: 2026, month: 6 },
    outputDir: "/tmp",
    resolveUserQuestion: opts.resolver as ((q: { question: string; header?: string; kind?: "confirm"; trustable?: boolean }) => Promise<string>) | undefined,
    conversationId: opts.conversationId,
  };
}

export const sessionTrustTestPromise = (async () => {
  // ── (a) 存储：trust/isTrusted、conversationId 隔离、未知对话 false ────────
  clearTrustStore();

  assert.equal(isToolTrustedForConversation(1, RUN_PYTHON), false, "ST-a1: 未信任应返回 false");
  assert.equal(isToolTrustedForConversation(undefined, RUN_PYTHON), false, "ST-a2: conversationId=undefined 应返回 false");

  trustToolForConversation(1, RUN_PYTHON);
  assert.equal(isToolTrustedForConversation(1, RUN_PYTHON), true, "ST-a3: 信任后应返回 true");
  assert.equal(isToolTrustedForConversation(2, RUN_PYTHON), false, "ST-a4: 不同 conversationId 应隔离");
  assert.equal(isToolTrustedForConversation(1, OTHER_HIGH), false, "ST-a5: 同对话不同工具应返回 false");

  // conversationId=undefined 的 trust 调用应是 no-op
  trustToolForConversation(undefined, RUN_PYTHON);
  assert.equal(isToolTrustedForConversation(undefined, RUN_PYTHON), false, "ST-a6: undefined conversationId 信任后仍 false");

  clearTrustStore();

  // ── (b) risk-confirm 行为 ──────────────────────────────────────────────────
  const hook = createRiskConfirmHook();
  const chain = [createUnwiredToolHook(), createRiskConfirmHook()];

  // run_python：默认放行，不弹卡、不调 resolver
  {
    let resolverCalled = false;
    const result = await runBeforeHooks(chain, makeCtx(RUN_PYTHON, {
      conversationId: 10,
      resolver: async () => { resolverCalled = true; return "确认"; },
    }));
    assert.equal(result.behavior, "allow", "ST-b1: run_python 应默认 allow");
    assert.equal(resolverCalled, false, "ST-b2: run_python 不应调用 resolver");

    const noResolver = await runBeforeHooks(chain, makeCtx(RUN_PYTHON, {
      conversationId: 10,
      resolver: undefined,
    }));
    assert.equal(noResolver.behavior, "allow", "ST-b3: run_python 无 resolver 也应 allow");
  }

  // 其他高风险工具 → confirm 且 trustable falsy
  {
    clearTrustStore();

    const r1 = await hook.before!(makeCtx(OTHER_HIGH, { conversationId: 10 }));
    assert.equal(r1.action, "confirm", "ST-b5: calculate_payroll_batch 仍需 confirm");
    assert.ok(!(r1 as { action: "confirm"; trustable?: boolean }).trustable, "ST-b6: calculate_payroll_batch trustable 应为 falsy");

    const r2 = await hook.before!(makeCtx(KINGDEE, { conversationId: 10 }));
    assert.equal(r2.action, "confirm", "ST-b7: export_kingdee_draft 仍需 confirm");
    assert.ok(!(r2 as { action: "confirm"; trustable?: boolean }).trustable, "ST-b8: export_kingdee_draft trustable 应为 falsy");

    clearTrustStore();
  }

  // ── (c) chain.ts：sentinel 写信任、普通确认不写、取消 deny（用仍需确认的工具）──
  const sentinelChain = [createUnwiredToolHook(), createRiskConfirmHook()];

  // sentinel → allow + 写信任
  {
    clearTrustStore();
    const convId = 20;
    const result = await runBeforeHooks(sentinelChain, makeCtx(OTHER_HIGH, {
      conversationId: convId,
      resolver: async () => SESSION_TRUST_CONFIRM_ANSWER,
    }));
    assert.equal(result.behavior, "allow", "ST-c1: sentinel 应 allow");
    assert.equal(isToolTrustedForConversation(convId, OTHER_HIGH), true, "ST-c2: sentinel 应写入信任");
    clearTrustStore();
  }

  // 普通「确认」→ allow，不写信任
  {
    clearTrustStore();
    const convId = 21;
    const result = await runBeforeHooks(sentinelChain, makeCtx(OTHER_HIGH, {
      conversationId: convId,
      resolver: async () => "确认",
    }));
    assert.equal(result.behavior, "allow", "ST-c3: 普通确认应 allow");
    assert.equal(isToolTrustedForConversation(convId, OTHER_HIGH), false, "ST-c4: 普通确认不应写信任");
    clearTrustStore();
  }

  // 取消 → deny
  {
    clearTrustStore();
    const result = await runBeforeHooks(sentinelChain, makeCtx(OTHER_HIGH, {
      conversationId: 22,
      resolver: async () => "取消",
    }));
    assert.equal(result.behavior, "deny", "ST-c5: 取消应 deny");
    clearTrustStore();
  }

  // sentinel + 无 conversationId → allow 但不写信任（无法作用域）
  {
    clearTrustStore();
    const result = await runBeforeHooks(sentinelChain, {
      toolName: OTHER_HIGH,
      input: { year: 2026, month: 6 },
      outputDir: "/tmp",
      resolveUserQuestion: async () => SESSION_TRUST_CONFIRM_ANSWER,
      // 无 conversationId
    });
    assert.equal(result.behavior, "allow", "ST-c6: 无 conversationId 的 sentinel 仍应 allow");
    assert.equal(isToolTrustedForConversation(undefined, OTHER_HIGH), false, "ST-c7: 无 conversationId sentinel 不写信任");
    clearTrustStore();
  }

  // ── (d) 无 resolver：run_python allow；其它高风险 deny ──────────────────────
  {
    clearTrustStore();
    const convId = 30;

    const py = await runBeforeHooks(sentinelChain, makeCtx(RUN_PYTHON, {
      conversationId: convId,
      resolver: undefined,
    }));
    assert.equal(py.behavior, "allow", "ST-d1: run_python 无 resolver 应 allow");

    const high = await runBeforeHooks(sentinelChain, makeCtx(OTHER_HIGH, {
      conversationId: convId,
      resolver: undefined,
    }));
    assert.equal(high.behavior, "deny", "ST-d2: 高风险财务工具无 resolver 仍应 deny");
    clearTrustStore();
  }

  // ── (e) 组件源码契约 ────────────────────────────────────────────────────────
  const panelSource = readFileSync(
    path.join(projectRoot, "app/components/ask-user-panel.tsx"),
    "utf-8"
  );
  assert.match(panelSource, /本次对话不再询问/, "ST-e1: 面板应含「本次对话不再询问」文案");
  assert.match(panelSource, /SESSION_TRUST_CONFIRM_ANSWER/, "ST-e2: 面板应使用 SESSION_TRUST_CONFIRM_ANSWER 常量");
  assert.match(panelSource, /trustable/, "ST-e3: 面板应读取 trustable prop");
  assert.match(panelSource, /checkbox|Checkbox/i, "ST-e4: 面板应有 checkbox 元素");

  // ── (f) revokeToolTrust + listTrustedTools ──────────────────────────────────
  {
    clearTrustStore();
    const convId = 40;

    // trust → isTrusted true
    trustToolForConversation(convId, RUN_PYTHON);
    assert.equal(isToolTrustedForConversation(convId, RUN_PYTHON), true, "ST-f1: 信任后应返回 true");

    // listTrustedTools 只回本会话条目
    trustToolForConversation(convId + 1, RUN_PYTHON); // 另一会话
    const tools = listTrustedTools(convId);
    assert.deepEqual(tools, [RUN_PYTHON], "ST-f2: listTrustedTools 只回本会话条目");
    assert.equal(listTrustedTools(convId + 1).length, 1, "ST-f3: 另一会话条目隔离");

    // revoke → isTrusted false
    revokeToolTrust(convId, RUN_PYTHON);
    assert.equal(isToolTrustedForConversation(convId, RUN_PYTHON), false, "ST-f4: revoke 后应返回 false");
    assert.deepEqual(listTrustedTools(convId), [], "ST-f5: revoke 后 listTrustedTools 应为空");

    // 另一会话不受影响
    assert.equal(isToolTrustedForConversation(convId + 1, RUN_PYTHON), true, "ST-f6: revoke 只影响指定会话");

    // revokeToolTrust 不存在的 key 是 no-op（不抛）
    revokeToolTrust(convId, RUN_PYTHON); // 重复 revoke
    assert.equal(isToolTrustedForConversation(convId, RUN_PYTHON), false, "ST-f7: 重复 revoke 无操作");

    // undefined conversationId → no-op
    revokeToolTrust(undefined, RUN_PYTHON);
    assert.equal(listTrustedTools(undefined).length, 0, "ST-f8: undefined conversationId 无操作");

    clearTrustStore();
  }

  // ── (g) trust route 契约 ─────────────────────────────────────────────────────
  {
    const { GET, DELETE } = await import("../app/api/agent/trust/route.ts");

    // GET 缺少合法 conversationId → 400
    const bad = await GET(new Request("http://localhost/api/agent/trust?conversationId=abc"));
    assert.equal(bad.status, 400, "ST-g1: 非整数 conversationId 应返回 400");

    // GET conversationId=0 → 400（非正整数）
    const zero = await GET(new Request("http://localhost/api/agent/trust?conversationId=0"));
    assert.equal(zero.status, 400, "ST-g2: conversationId=0 应返回 400");

    // GET 合法 conversationId → 200 + tools 数组（空）
    const ok = await GET(new Request("http://localhost/api/agent/trust?conversationId=99"));
    assert.equal(ok.status, 200, "ST-g3: 合法 conversationId 应返回 200");
    const okBody = (await ok.json()) as { ok: boolean; data: { tools: string[] } };
    assert.equal(okBody.ok, true, "ST-g4: 合法请求体 ok 应为 true");
    assert.ok(Array.isArray(okBody.data.tools), "ST-g5: data.tools 应为数组");

    // DELETE 缺少 toolName → 400
    const delBad = await DELETE(new Request("http://localhost/api/agent/trust", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: 1 }),
    }));
    assert.equal(delBad.status, 400, "ST-g6: 缺少 toolName 应返回 400");

    // DELETE 合法请求 → 200
    trustToolForConversation(99, RUN_PYTHON);
    const delOk = await DELETE(new Request("http://localhost/api/agent/trust", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: 99, toolName: RUN_PYTHON }),
    }));
    assert.equal(delOk.status, 200, "ST-g7: 合法 DELETE 应返回 200");
    assert.equal(isToolTrustedForConversation(99, RUN_PYTHON), false, "ST-g8: DELETE 后信任应已撤销");

    clearTrustStore();
  }

  console.log("session-trust: all checks passed ✓");
})();
