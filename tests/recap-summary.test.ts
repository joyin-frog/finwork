/**
 * recap-summary.test.ts
 *
 * AR1a + AR1b 测试。TDD 先红后绿。
 *
 * 测试分组：
 * T1  短 history (≤RECENT_KEEP=8) → fallbackFlatRecap（不调 LLM）
 * T2  SKIP_LLM 下长 history → 整段 fallbackFlatRecap 降级
 * T3  长 history + mock fetch 成功 → 结构化产出（分段边界校验）
 * T4  快照等价：fallbackFlatRecap 输出与改造前 yieldMessages recap 逐字一致
 * T5  prompt 契约源码断言（mainModel / 四段关键词 / timeout / max_tokens）
 * T6  AR1b PostCompact hook → writeSpan 含 metadata.compactSummary（功能测试）
 * T7  AR1b 源码契约 → compact_boundary 原 span 保留 + PostCompact hook 存在
 *
 * 运行（单跑）：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/recap-summary.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "../lib/agent/claude-adapter.ts";
import type { SpanInput } from "../lib/observability/spans.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

export const recapSummaryTestPromise = (async () => {
  const { fallbackFlatRecap, buildStructuredRecap, createPostCompactHookCallback } =
    await import("../lib/agent/recap-summary.ts");

  // ─── T1: 短 history (≤ RECENT_KEEP=8) → fallbackFlatRecap，不调 LLM ─────────
  {
    const shortHistory: AgentMessage[] = [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ];
    const lastPrompt = "当前问题";

    // T1a: fallbackFlatRecap 格式校验
    const flat = fallbackFlatRecap(shortHistory, lastPrompt);
    assert.ok(flat.includes("<对话回顾>"), "T1a FAIL: fallback 应含 <对话回顾>");
    assert.ok(flat.includes("用户:第一问"), "T1a FAIL: user 消息应映射到 用户:");
    assert.ok(flat.includes("助手:第一答"), "T1a FAIL: assistant 消息应映射到 助手:");
    assert.ok(flat.includes("</对话回顾>"), "T1a FAIL: fallback 应含 </对话回顾>");
    assert.ok(flat.includes("当前请求:\n"), "T1a FAIL: 应含 当前请求:换行");
    assert.ok(flat.endsWith(lastPrompt), "T1a FAIL: 应以 lastPromptText 结尾");

    // T1b: buildStructuredRecap ≤8 条 → 与 fallbackFlatRecap 完全相同（无 LLM）
    const built = await buildStructuredRecap(shortHistory, lastPrompt, undefined);
    assert.equal(built, flat, "T1b FAIL: ≤RECENT_KEEP 时 buildStructuredRecap 应等于 fallbackFlatRecap");

    // T1c: 恰好 8 条 history 也走 fallback
    const exactly8: AgentMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg${i + 1}`,
    }));
    const built8 = await buildStructuredRecap(exactly8, lastPrompt, undefined);
    assert.equal(built8, fallbackFlatRecap(exactly8, lastPrompt), "T1c FAIL: 恰好 8 条应走 fallback");

    // T1d: 空 history → 仅返回 lastPromptText
    const emptyFlat = fallbackFlatRecap([], lastPrompt);
    assert.equal(emptyFlat, lastPrompt, "T1d FAIL: 空 history 应仅返回 lastPromptText");

    console.log("T1: short/empty history → fallbackFlatRecap ✓");
  }

  // ─── T2: SKIP_LLM 下长 history → 整段 fallbackFlatRecap 降级 ────────────────
  {
    assert.ok(process.env.SKIP_LLM, "T2 前提: SKIP_LLM 应已设置");

    const longHistory: AgentMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `消息${i + 1}`,
    }));
    const lastPrompt = "最新问题";

    const fakeSettings = {
      apiKey: "fake-key",
      apiUrl: "https://api.anthropic.com/v1",
      mainModel: "claude-sonnet-4-5",
      routerModel: "claude-haiku-4-5",
      subagentModel: "claude-haiku-4-5",
    };

    const result = await buildStructuredRecap(longHistory, lastPrompt, fakeSettings);
    const expected = fallbackFlatRecap(longHistory, lastPrompt);

    // SKIP_LLM → summary=null → 整段 fallback（包含所有 10 条）
    assert.equal(result, expected, "T2 FAIL: SKIP_LLM 下应降级为全量 fallbackFlatRecap");
    assert.ok(result.includes("<对话回顾>"), "T2 FAIL: 降级结果应含 <对话回顾>");
    assert.ok(result.includes("消息1"), "T2 FAIL: 降级结果应含第1条消息（全量）");
    assert.ok(result.includes("消息10"), "T2 FAIL: 降级结果应含第10条消息（全量）");

    console.log("T2: SKIP_LLM + long history → full fallback ✓");
  }

  // ─── T3: 长 history + mock fetch 成功 → 结构化产出（分段边界） ───────────────
  {
    const longHistory: AgentMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `消息${i + 1}`,
    }));
    const lastPrompt = "当前问题";
    const mockSummary = "## 目标\n测试目标\n## 进展\n已完成X\n## 关键决策\n选择Y\n## 下一步\n执行Z";

    const origSkipLlm = process.env.SKIP_LLM;
    delete process.env.SKIP_LLM;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: mockSummary }] }),
      }) as unknown as Response;

    try {
      const fakeSettings = {
        apiKey: "sk-test-key",
        apiUrl: "https://api.anthropic.com/v1",
        mainModel: "claude-sonnet-4-5",
        routerModel: "claude-haiku-4-5",
        subagentModel: "claude-haiku-4-5",
      };
      const result = await buildStructuredRecap(longHistory, lastPrompt, fakeSettings);

      assert.ok(result.includes("<历史摘要>"), "T3a FAIL: 结构化结果应含 <历史摘要>");
      assert.ok(result.includes(mockSummary), "T3b FAIL: 结构化结果应含摘要文本");
      assert.ok(result.includes("</历史摘要>"), "T3c FAIL: 结构化结果应含 </历史摘要>");
      assert.ok(result.includes("<最近对话>"), "T3d FAIL: 结构化结果应含 <最近对话>");
      assert.ok(result.includes("</最近对话>"), "T3e FAIL: 结构化结果应含 </最近对话>");
      assert.ok(result.includes("当前请求:\n"), "T3f FAIL: 结构化结果应含 当前请求:");
      assert.ok(result.endsWith(lastPrompt), "T3g FAIL: 结构化结果应以 lastPromptText 结尾");

      // 验证分段：older(前2条)进摘要，recent(后8条，消息3-10)在 <最近对话>
      const recentMatch = result.match(/<最近对话>([\s\S]*?)<\/最近对话>/);
      assert.ok(recentMatch, "T3h FAIL: 应有 <最近对话> 段");
      const recentSection = recentMatch![1];
      assert.ok(recentSection.includes("消息3"), "T3i FAIL: 第3条(recent的最早)应在最近对话");
      assert.ok(recentSection.includes("消息10"), "T3j FAIL: 第10条应在最近对话");
      // 注意："消息1" 是 "消息10" 的子串；使用 ":消息1\n" 区分（旧式消息1后跟换行，消息10后跟0）
      assert.ok(!recentSection.includes(":消息1\n"), "T3k FAIL: 第1条(older)不应在最近对话");
      assert.ok(!recentSection.includes(":消息2\n"), "T3l FAIL: 第2条(older)不应在最近对话");

    } finally {
      if (origSkipLlm !== undefined) process.env.SKIP_LLM = origSkipLlm;
      else delete process.env.SKIP_LLM;
      globalThis.fetch = origFetch;
    }

    console.log("T3: long history + mock fetch → structured output ✓");
  }

  // ─── T4: 快照等价：fallbackFlatRecap == 改造前 yieldMessages recap 逐字一致 ──
  {
    // 精确锁死快照——任何偏差都会悄悄改变所有 stale 重建的 prompt
    const history: AgentMessage[] = [
      { role: "user", content: "问题A" },
      { role: "assistant", content: "回答B" },
    ];
    const lastPrompt = "现在的问题";
    const result = fallbackFlatRecap(history, lastPrompt);

    const expected =
      "<对话回顾>\n用户:问题A\n助手:回答B\n</对话回顾>\n\n当前请求:\n现在的问题";
    assert.equal(
      result,
      expected,
      "T4 FAIL: fallbackFlatRecap 快照应与旧 yieldMessages 输出逐字一致"
    );

    console.log("T4: fallbackFlatRecap 快照等价 ✓");
  }

  // ─── T5: prompt 契约（源码断言） ───────────────────────────────────────────────
  {
    const recapSrc = src("lib/agent/recap-summary.ts");

    assert.ok(
      recapSrc.includes("purpose: \"summary\"") || recapSrc.includes('purpose: "summary"'),
      "T5a FAIL: summarizeHistory 应经 resolver purpose=summary 取 mainModel",
    );
    assert.ok(recapSrc.includes("resolveExecutionModel"), "T5a FAIL: 应使用 resolveExecutionModel");
    assert.ok(!recapSrc.includes("settings.mainModel || settings.model"), "T5a FAIL: 不应再回退 settings.model");
    assert.ok(recapSrc.includes("## 目标"), "T5b FAIL: prompt 应含 ## 目标");
    assert.ok(recapSrc.includes("## 进展"), "T5c FAIL: prompt 应含 ## 进展");
    assert.ok(recapSrc.includes("## 关键决策"), "T5d FAIL: prompt 应含 ## 关键决策");
    assert.ok(recapSrc.includes("## 下一步"), "T5e FAIL: prompt 应含 ## 下一步");
    assert.ok(recapSrc.includes("AbortSignal.timeout"), "T5f FAIL: 应有超时守卫 AbortSignal.timeout");
    assert.ok(recapSrc.includes("SKIP_LLM"), "T5g FAIL: 应有 SKIP_LLM 守卫");
    assert.ok(recapSrc.includes("600"), "T5h FAIL: max_tokens 应为 600");
    assert.ok(
      recapSrc.includes("具体文件") || recapSrc.includes("单据") || recapSrc.includes("报表名"),
      "T5i FAIL: prompt 应要求提及文件/单据/报表名"
    );

    console.log("T5: prompt 契约源码断言 ✓");
  }

  // ─── T6: AR1b PostCompact hook → writeSpan 含 metadata.compactSummary ────────
  {
    const spansWritten: SpanInput[] = [];
    const mockWriteSpan = (span: SpanInput) => spansWritten.push(span);

    const hookCb = createPostCompactHookCallback("trace-abc-001", mockWriteSpan);
    const fakeInput = {
      hook_event_name: "PostCompact" as const,
      trigger: "auto" as const,
      compact_summary: "## 目标\n财务对话目标\n## 进展\n已完成步骤",
      session_id: "sess-001",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
    };

    const returnVal = await hookCb(fakeInput, undefined, {
      signal: new AbortController().signal,
    });

    assert.equal(spansWritten.length, 1, "T6a FAIL: hook 应调用 writeSpan 恰好一次");
    assert.equal(spansWritten[0].spanType, "compact", "T6b FAIL: spanType 应为 compact");
    assert.equal(
      spansWritten[0].metadata?.compactSummary,
      fakeInput.compact_summary,
      "T6c FAIL: metadata.compactSummary 应等于 compact_summary 全文（不截断）"
    );
    assert.equal(
      spansWritten[0].metadata?.trigger,
      fakeInput.trigger,
      "T6d FAIL: metadata.trigger 应等于输入 trigger"
    );
    assert.equal(spansWritten[0].traceId, "trace-abc-001", "T6e FAIL: traceId 应透传 requestId");
    assert.deepEqual(returnVal, { continue: true }, "T6f FAIL: hook 应返回 { continue: true }");

    // name 格式：compact:summary:{trigger}
    assert.equal(
      spansWritten[0].name,
      "compact:summary:auto",
      "T6g FAIL: name 应为 compact:summary:{trigger}"
    );

    // 验证 trigger=manual 分支
    const spansWritten2: SpanInput[] = [];
    const hookCb2 = createPostCompactHookCallback("trace-def-002", (s) =>
      spansWritten2.push(s)
    );
    await hookCb2(
      { ...fakeInput, trigger: "manual" as const, compact_summary: "手动压缩摘要" },
      undefined,
      { signal: new AbortController().signal }
    );
    assert.equal(
      spansWritten2[0].metadata?.compactSummary,
      "手动压缩摘要",
      "T6h FAIL: manual trigger 摘要应正确写入"
    );
    assert.equal(spansWritten2[0].name, "compact:summary:manual", "T6i FAIL: name 应含 trigger=manual");

    console.log("T6: AR1b PostCompact hook → writeSpan compactSummary ✓");
  }

  // ─── T7: AR1b 源码契约 ────────────────────────────────────────────────────────
  {
    const adapterSrc = src("lib/agent/claude-adapter.ts");

    // 原 compact_boundary span 保留（pre_tokens 字段）
    assert.ok(
      adapterSrc.includes("inputSummary: `pre=${meta.pre_tokens}`"),
      "T7a FAIL: 原 compact_boundary span(pre_tokens)应保留，不被移除"
    );

    // PostCompact hook 已接入
    assert.ok(adapterSrc.includes("PostCompact"), "T7b FAIL: options 应含 PostCompact hook");
    // compactSummary 写入逻辑在 recap-summary.ts（已由 T6 功能测试），adapter 通过工厂函数调用
    assert.ok(
      adapterSrc.includes("createPostCompactHookCallback"),
      "T7c FAIL: adapter 应调用 createPostCompactHookCallback（compactSummary 写入在其内部）"
    );

    // hooks 字段在 options 里（以 "hooks:" 形式出现）
    assert.ok(
      adapterSrc.includes("hooks:") || adapterSrc.includes("hooks :"),
      "T7d FAIL: options 对象应有 hooks 字段"
    );

    // recap-summary.ts 已被引用
    assert.ok(
      adapterSrc.includes("recap-summary"),
      "T7e FAIL: claude-adapter 应 import recap-summary"
    );

    // settings 透传（buildPromptInput 调用处应传 settings）
    assert.ok(
      adapterSrc.includes("buildPromptInput(pickedMessages") &&
        adapterSrc.includes("settings"),
      "T7f FAIL: buildPromptInput 调用应透传 settings"
    );

    console.log("T7: AR1b 源码契约 ✓");
  }

  console.log("\nrecap-summary: 全部断言通过 ✓");
})();
