/**
 * session-trust.test.ts — run_python 会话级信任功能测试
 *
 * 覆盖范围(对应 spec §3 步骤 1 的 a-e):
 * (a) 存储:trust/isTrusted、conversationId 隔离、未知对话 false
 * (b) risk-confirm:已信任+有 resolver → allow 且不弹卡;未信任 → confirm+trustable=true;
 *     其他高风险工具 → confirm+trustable falsy
 * (c) chain.ts:sentinel → allow+写信任;普通「确认」→ allow 不写信任;「取消」→ deny
 * (d) 安全不变量:resolver=undefined 时即便已信任仍 deny
 * (e) 组件源码契约:ask-user-panel.tsx 含勾选项与 sentinel 提交分支
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

  // run_python 未信任 + 有 resolver → confirm 且 trustable=true
  {
    const result = await hook.before!(makeCtx(RUN_PYTHON, { conversationId: 10, resolver: async () => "确认" }));
    assert.equal(result.action, "confirm", "ST-b1: 未信任 run_python 应返回 confirm");
    assert.equal(
      (result as { action: "confirm"; trustable?: boolean }).trustable,
      true,
      "ST-b2: run_python confirm 应有 trustable=true"
    );
  }

  // run_python 已信任 + 有 resolver → 走完整链应直接 allow 且不调 resolver
  {
    clearTrustStore();
    trustToolForConversation(10, RUN_PYTHON);
    let resolverCalled = false;
    const result = await runBeforeHooks(chain, makeCtx(RUN_PYTHON, {
      conversationId: 10,
      resolver: async () => { resolverCalled = true; return "确认"; },
    }));
    assert.equal(result.behavior, "allow", "ST-b3: 已信任 run_python 应直接 allow");
    assert.equal(resolverCalled, false, "ST-b4: 已信任 run_python 不应调用 resolver");
    clearTrustStore();
  }

  // 其他高风险工具 → confirm 且 trustable falsy（even if run_python 在同 conversationId 已信任）
  {
    clearTrustStore();
    trustToolForConversation(10, RUN_PYTHON);

    const r1 = await hook.before!(makeCtx(OTHER_HIGH, { conversationId: 10 }));
    assert.equal(r1.action, "confirm", "ST-b5: calculate_payroll_batch 仍需 confirm");
    assert.ok(!(r1 as { action: "confirm"; trustable?: boolean }).trustable, "ST-b6: calculate_payroll_batch trustable 应为 falsy");

    const r2 = await hook.before!(makeCtx(KINGDEE, { conversationId: 10 }));
    assert.equal(r2.action, "confirm", "ST-b7: export_kingdee_draft 仍需 confirm");
    assert.ok(!(r2 as { action: "confirm"; trustable?: boolean }).trustable, "ST-b8: export_kingdee_draft trustable 应为 falsy");

    clearTrustStore();
  }

  // ── (c) chain.ts：sentinel 写信任、普通确认不写、取消 deny ─────────────────
  const sentinelChain = [createUnwiredToolHook(), createRiskConfirmHook()];

  // sentinel → allow + 写信任
  {
    clearTrustStore();
    const convId = 20;
    const result = await runBeforeHooks(sentinelChain, makeCtx(RUN_PYTHON, {
      conversationId: convId,
      resolver: async () => SESSION_TRUST_CONFIRM_ANSWER,
    }));
    assert.equal(result.behavior, "allow", "ST-c1: sentinel 应 allow");
    assert.equal(isToolTrustedForConversation(convId, RUN_PYTHON), true, "ST-c2: sentinel 应写入信任");
    clearTrustStore();
  }

  // 普通「确认」→ allow，不写信任
  {
    clearTrustStore();
    const convId = 21;
    const result = await runBeforeHooks(sentinelChain, makeCtx(RUN_PYTHON, {
      conversationId: convId,
      resolver: async () => "确认",
    }));
    assert.equal(result.behavior, "allow", "ST-c3: 普通确认应 allow");
    assert.equal(isToolTrustedForConversation(convId, RUN_PYTHON), false, "ST-c4: 普通确认不应写信任");
    clearTrustStore();
  }

  // 取消 → deny
  {
    clearTrustStore();
    const result = await runBeforeHooks(sentinelChain, makeCtx(RUN_PYTHON, {
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
      toolName: RUN_PYTHON,
      input: {},
      outputDir: "/tmp",
      resolveUserQuestion: async () => SESSION_TRUST_CONFIRM_ANSWER,
      // 无 conversationId
    });
    assert.equal(result.behavior, "allow", "ST-c6: 无 conversationId 的 sentinel 仍应 allow");
    assert.equal(isToolTrustedForConversation(undefined, RUN_PYTHON), false, "ST-c7: 无 conversationId sentinel 不写信任");
    clearTrustStore();
  }

  // ── (d) 安全不变量：resolver=undefined 时即便已信任仍 deny ──────────────────
  {
    clearTrustStore();
    const convId = 30;
    trustToolForConversation(convId, RUN_PYTHON);
    assert.equal(isToolTrustedForConversation(convId, RUN_PYTHON), true, "ST-d-pre: 信任应已写入");

    // 无 resolver（子代理场景）→ 仍 deny
    const result = await runBeforeHooks(sentinelChain, makeCtx(RUN_PYTHON, {
      conversationId: convId,
      resolver: undefined,
    }));
    assert.equal(result.behavior, "deny", "ST-d: 即便已信任，无 resolver 仍应 deny（硬不变量）");
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

  console.log("session-trust: all checks passed ✓");
})();
