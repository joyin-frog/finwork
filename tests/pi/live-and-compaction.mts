import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  _resetLiveSessionsForTest,
  followUpConversation,
  isConversationRunning,
  liveSessionCount,
  registerLiveSession,
  steerConversation,
} from "../../lib/agent/pi/live-sessions.ts";
import {
  extractCompactionFacts,
  formatFactsBlock,
} from "../../lib/agent/pi/compaction-facts.ts";
import { createFinworkExtension } from "../../lib/agent/pi/extension.ts";
import { createFinworkPiResourceLoader } from "../../lib/agent/pi/resource-loader.ts";

const root = mkdtempSync(path.join(tmpdir(), "finwork-pi-live-"));
mkdirSync(path.join(root, "generate"), { recursive: true });
const roots = { writeRoot: path.join(root, "generate"), readRoot: root };

// ════════ L6a 在途 session 注册表 ════════
_resetLiveSessionsForTest();

function fakeSession() {
  const calls: string[] = [];
  return {
    calls,
    session: {
      steer: async (text: string) => { calls.push(`steer:${text}`); },
      followUp: async (text: string) => { calls.push(`followUp:${text}`); },
    } as never,
  };
}

// ── S-1 未在跑时插话返回 false，调用方据此起新回合 ──
{
  assert.equal(await steerConversation(1, "改用不含税口径"), false, "S-1 FAIL: 无在途运行应返回 false");
  assert.equal(isConversationRunning(1), false);
}

// ── S-2 在跑时插话打到真 session ──
{
  const a = fakeSession();
  const handle = registerLiveSession(1, a.session, "trace-a");
  assert.equal(isConversationRunning(1), true, "S-2 FAIL: 应登记为在途");
  assert.equal(await steerConversation(1, "改用不含税口径"), true);
  assert.equal(await followUpConversation(1, "顺便出个环比"), true);
  assert.deepEqual(a.calls, ["steer:改用不含税口径", "followUp:顺便出个环比"]);
  handle.release();
  assert.equal(liveSessionCount(), 0, "S-2 FAIL: 回合结束必须注销，不能泄漏");
}

// ── S-3 后开的回合覆盖条目，先结束的回合不得把它删掉 ──
// 插话必须打到「最新那次运行」，否则会打进一个已经结束的 session。
{
  const a = fakeSession();
  const b = fakeSession();
  const handleA = registerLiveSession(7, a.session, "trace-a");
  const handleB = registerLiveSession(7, b.session, "trace-b");

  handleA.release(); // A 先结束
  assert.equal(isConversationRunning(7), true, "S-3 FAIL: A 的注销不该删掉 B 的条目");
  assert.equal(await steerConversation(7, "给 B"), true);
  assert.deepEqual(b.calls, ["steer:给 B"], "S-3 FAIL: 插话应打到最新的 B");
  assert.deepEqual(a.calls, [], "S-3 FAIL: 不应打到已结束的 A");

  handleB.release();
  assert.equal(liveSessionCount(), 0);
}

// ── S-4 无 conversationId（一次性运行）不登记 ──
{
  const c = fakeSession();
  const handle = registerLiveSession(null, c.session, "trace-c");
  assert.equal(liveSessionCount(), 0, "S-4 FAIL: 无会话号不应进表");
  handle.release();
}

// ════════ L8 财务压缩 ════════

// ── K-1 关键事实提取：金额要带上下文，纯数字不算金额 ──
{
  const facts = extractCompactionFacts([
    "2026年7月 不含税收入 1,234,567.89 元，按权责发生制口径确认。",
    "订单编号 20260731 共 42 件",           // 不该被当成金额
    "毛利率 32.5%，环比上升",
  ]);
  assert.ok(
    facts.amounts.some((item) => item.includes("1,234,567.89")),
    `K-1 FAIL: 应提取金额，实际：${JSON.stringify(facts.amounts)}`,
  );
  assert.ok(
    facts.amounts.every((item) => !item.includes("20260731")),
    `K-1 FAIL: 编号被误判为金额：${JSON.stringify(facts.amounts)}`,
  );
  assert.ok(facts.periods.some((p) => p.includes("2026")), "K-1 FAIL: 应提取期间");
  assert.ok(
    facts.conventions.some((c) => c.includes("权责发生制")),
    `K-1 FAIL: 应保留口径原句：${JSON.stringify(facts.conventions)}`,
  );
}

// ── K-2 无财务内容时不产出空壳块 ──
{
  assert.equal(formatFactsBlock(extractCompactionFacts(["你好", "帮我看看"])), "", "K-2 FAIL: 应为空串");
}

// ── K-3 摘要生成失败必须回落 pi 默认，不能让压缩崩掉 ──
{
  const loader = await createFinworkPiResourceLoader({
    cwd: root,
    agentDir: path.join(root, "agent"),
    systemPrompt: "probe",
    extensionFactories: [
      createFinworkExtension({
        roots,
        summarizeForCompaction: async () => { throw new Error("模型不可用"); },
      }),
    ],
  });
  const finwork = loader.getExtensions().extensions.find((e) => e.path.includes("finwork-core"))!;
  const handler = (finwork.handlers.get("session_before_compact") ?? [])[0];
  assert.ok(handler, "K-3 FAIL: 未注册 session_before_compact");

  const event = {
    reason: "threshold",
    preparation: {
      messagesToSummarize: [{ role: "user", content: "不含税收入 100 元，按权责发生制" }],
      firstKeptEntryId: "e1",
      tokensBefore: 1000,
    },
  };
  const result = await handler(event as never, {} as never);
  assert.equal(result, undefined, "K-3 FAIL: 生成器抛错时必须返回 undefined 回落 pi 默认摘要");
}

// ── K-4 正常路径：事实块在前，叙述在后 ──
{
  const loader = await createFinworkPiResourceLoader({
    cwd: root,
    agentDir: path.join(root, "agent"),
    systemPrompt: "probe",
    extensionFactories: [
      createFinworkExtension({
        roots,
        summarizeForCompaction: async () => "用户在核对 7 月收入。",
      }),
    ],
  });
  const finwork = loader.getExtensions().extensions.find((e) => e.path.includes("finwork-core"))!;
  const handler = (finwork.handlers.get("session_before_compact") ?? [])[0];
  const result = await handler(
    {
      reason: "threshold",
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "2026年7月 不含税收入 1,234,567.89 元，按权责发生制口径。" },
        ],
        firstKeptEntryId: "e1",
        tokensBefore: 1000,
      },
    } as never,
    {} as never,
  );
  const summary = (result as { compaction: { summary: string } }).compaction.summary;
  assert.match(summary, /<关键事实/, "K-4 FAIL: 摘要应含确定性事实块");
  assert.match(summary, /1,234,567\.89/, "K-4 FAIL: 金额必须原样保留");
  assert.match(summary, /用户在核对 7 月收入。$/, "K-4 FAIL: 叙述应在事实块之后");
  assert.ok(
    summary.indexOf("<关键事实") < summary.indexOf("用户在核对"),
    "K-4 FAIL: 事实块必须在叙述之前",
  );
}

console.log("Pi live sessions + compaction ✓ 插话打到最新运行、压缩保住金额口径且失败可回落");
