/**
 * confirm-gate.test.ts
 *
 * 两个测试段:
 *   ① 纯函数段(仿 ask-user-multi.test.ts):chain.ts confirm 路径打 kind:"confirm",
 *      答案 allow/deny/空串三分支,薪税+记账双角色一致。
 *   ② 源码契约段(仿 tool-call-step-ui.test.ts):ask-user-panel.tsx 有 confirm 分支、
 *      两按钮、无文本框、颜色走 tone token。
 *
 * 运行:
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/confirm-gate.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

export const confirmGateTestPromise = (async () => {
  // ══════════════════════════════════════════════════════════════════════
  // § 1  纯函数段 ── chain.ts confirm 路径
  // ══════════════════════════════════════════════════════════════════════

  // 仿 ask-user-multi.test.ts:宽松的 HookContext 类型,避免引入 DOM
  type Ctx = {
    toolName: string;
    input: unknown;
    outputDir: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveUserQuestion?: (q: any) => Promise<string>;
  };

  const { runBeforeHooks } = await import("../lib/agent/hooks/chain.ts");
  const { createRiskConfirmHook } = await import("../lib/agent/hooks/built-in.ts");

  const HIGH_PAYROLL = "calculate_payroll_batch";
  const HIGH_KINGDEE = "export_kingdee_draft";

  // ── G1: confirm 路径打 kind:"confirm" ──────────────────────────────────
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const received: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolve = async (q: any): Promise<string> => {
      received.push(q);
      return "确认";
    };

    const ctx: Ctx = {
      toolName: HIGH_PAYROLL,
      input: { period: "2025-06" },
      outputDir: "/tmp",
      resolveUserQuestion: resolve,
    };

    const result = await runBeforeHooks([createRiskConfirmHook()], ctx as Parameters<typeof runBeforeHooks>[1]);
    assert.equal(result.behavior, "allow", "G1 FAIL: 答「确认」应放行");
    assert.equal(received.length, 1, "G1 FAIL: resolveUserQuestion 应被调用一次");
    assert.equal(received[0].kind, "confirm", 'G1 FAIL: confirm 路径应带 kind:"confirm"');
    assert.equal(received[0].header, "操作确认", "G1 FAIL: header 应为「操作确认」");
    console.log("G1: confirm 路径带 kind:\"confirm\" ✓");
  }

  // ── G2: 答「确认」→ allow ──────────────────────────────────────────────
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolve = async (_q: any): Promise<string> => "确认";
    const ctx: Ctx = { toolName: HIGH_PAYROLL, input: {}, outputDir: "/tmp", resolveUserQuestion: resolve };
    const result = await runBeforeHooks([createRiskConfirmHook()], ctx as Parameters<typeof runBeforeHooks>[1]);
    assert.equal(result.behavior, "allow", "G2 FAIL: 答「确认」应 allow");
    console.log("G2: 「确认」→ allow ✓");
  }

  // ── G3: 答「取消」→ deny ───────────────────────────────────────────────
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolve = async (_q: any): Promise<string> => "取消";
    const ctx: Ctx = { toolName: HIGH_PAYROLL, input: {}, outputDir: "/tmp", resolveUserQuestion: resolve };
    const result = await runBeforeHooks([createRiskConfirmHook()], ctx as Parameters<typeof runBeforeHooks>[1]);
    assert.equal(result.behavior, "deny", "G3 FAIL: 答「取消」应 deny");
    console.log("G3: 「取消」→ deny ✓");
  }

  // ── G4: 空串 → deny ────────────────────────────────────────────────────
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolve = async (_q: any): Promise<string> => "";
    const ctx: Ctx = { toolName: HIGH_PAYROLL, input: {}, outputDir: "/tmp", resolveUserQuestion: resolve };
    const result = await runBeforeHooks([createRiskConfirmHook()], ctx as Parameters<typeof runBeforeHooks>[1]);
    assert.equal(result.behavior, "deny", "G4 FAIL: 空串应 deny(宁可拒绝,不可放行)");
    console.log("G4: 空串 → deny ✓");
  }

  // ── G5: 双角色一致 ── 薪税 + 记账都产出 kind:"confirm" ─────────────────
  {
    for (const toolName of [HIGH_PAYROLL, HIGH_KINGDEE]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const received: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolve = async (q: any): Promise<string> => { received.push(q); return "确认"; };
      const ctx: Ctx = { toolName, input: {}, outputDir: "/tmp", resolveUserQuestion: resolve };
      await runBeforeHooks([createRiskConfirmHook()], ctx as Parameters<typeof runBeforeHooks>[1]);
      assert.equal(received[0]?.kind, "confirm", `G5 FAIL: ${toolName} 应带 kind:"confirm"`);
    }
    console.log("G5: 双角色(薪税+记账)均带 kind:\"confirm\" ✓");
  }

  // ── G6: 非 confirm 路径不带 kind ─────────────────────────────────────
  {
    // 低风险工具:createRiskConfirmHook 直接 allow,不调用 resolveUserQuestion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const received: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolve = async (q: any): Promise<string> => { received.push(q); return "ok"; };
    const ctx: Ctx = { toolName: "Read", input: {}, outputDir: "/tmp", resolveUserQuestion: resolve };
    await runBeforeHooks([createRiskConfirmHook()], ctx as Parameters<typeof runBeforeHooks>[1]);
    // 低风险工具不会调用 resolveUserQuestion
    assert.equal(received.length, 0, "G6 FAIL: 低风险工具不应调用 resolveUserQuestion");
    console.log("G6: 低风险工具不调 resolveUserQuestion ✓");
  }

  // ══════════════════════════════════════════════════════════════════════
  // § 2  源码契约段 ── ask-user-panel.tsx
  // ══════════════════════════════════════════════════════════════════════

  const panelSrc = src("app/components/ask-user-panel.tsx");

  // ── U1: kind==="confirm" 分支存在 ──────────────────────────────────────
  assert.ok(
    panelSrc.includes('kind === "confirm"') || panelSrc.includes("kind===\"confirm\""),
    'U1 FAIL: ask-user-panel.tsx 应有 kind === "confirm" 分支'
  );
  console.log('U1: kind === "confirm" 分支存在 ✓');

  // ── U2: 两按钮标识 ─────────────────────────────────────────────────────
  assert.ok(
    panelSrc.includes("确认执行"),
    "U2a FAIL: ask-user-panel.tsx 应有「确认执行」按钮"
  );
  assert.ok(
    panelSrc.includes("取消"),
    "U2b FAIL: ask-user-panel.tsx 应有「取消」按钮"
  );
  console.log("U2: 两按钮(确认执行/取消)存在 ✓");

  // ── U3: confirm 分支内无自由文本输入框 ─────────────────────────────────
  // 取出 kind==="confirm" 分支代码块,确认其中无 <textarea> 和文本 <input>
  // 策略:找到 kind === "confirm" 之后到下一个 return ( 之前的区段(即 confirm 早 return),
  //       再检查其中无 textarea/InputGroupInput
  {
    const confirmStart = panelSrc.indexOf('kind === "confirm"');
    assert.ok(confirmStart > -1, "U3 setup FAIL: 找不到 confirm 分支");
    // confirm 分支以 `return (` 结束 + ); 之后是主 return,
    // 找该分支 return 的闭合:从 confirmStart 往后找 "return (" 以定位分支主体
    const returnInConfirm = panelSrc.indexOf("return (", confirmStart);
    assert.ok(returnInConfirm > -1, "U3 setup FAIL: 找不到 confirm 分支的 return");
    // 找 confirm 分支结束:主 return 后再出现 "return (" 是主流程
    const mainReturn = panelSrc.indexOf("return (", returnInConfirm + 8);
    const confirmBlock = mainReturn > -1
      ? panelSrc.slice(confirmStart, mainReturn)
      : panelSrc.slice(confirmStart);

    assert.ok(
      !confirmBlock.includes("<textarea"),
      "U3 FAIL: confirm 分支内不应有 <textarea>"
    );
    assert.ok(
      !confirmBlock.includes("InputGroupInput"),
      "U3b FAIL: confirm 分支内不应有 InputGroupInput(文本输入框)"
    );
  }
  console.log("U3: confirm 分支内无文本输入框 ✓");

  // ── U4: 颜色用 tone token(--tone-notice / --tone-*),非裸 hex ─────────
  assert.ok(
    panelSrc.includes("--tone-notice") || panelSrc.includes("--tone-"),
    "U4 FAIL: ask-user-panel.tsx 应用 --tone-* CSS 变量(非裸 hex)渲染告警色"
  );
  // 确认 confirm 分支用了 fa-toned / fa-tone-pill 套路
  assert.ok(
    panelSrc.includes("fa-toned") || panelSrc.includes("fa-tone-pill"),
    "U4b FAIL: confirm 分支应用 fa-toned 或 fa-tone-pill 套路"
  );
  console.log("U4: 颜色走 tone token ✓");

  console.log("\nconfirm-gate: 全部断言通过 ✓");
})();
