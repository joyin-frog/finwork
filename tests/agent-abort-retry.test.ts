import assert from "node:assert/strict";
import { shouldRetryStaleSession } from "../lib/agent/claude-adapter";

// 回归:点「停止」时,SDK 抛出的 abort 错误不能被 session 续接重试逻辑当成"续接失败"而重跑。
export const agentAbortRetryTestPromise = (async () => {
  const { ok } = assert;

  // 续接早期遇到疑似 session 失效 → 重试(预期保留的行为)
  ok(
    shouldRetryStaleSession({ errorMessage: "session not found", resumeSession: true, alreadyRetried: false, elapsedMs: 1000, aborted: false }) === true,
    "T1 FAIL: 续接早期 session 失效应重试"
  );
  // 非续接 / 已重试 / 超 5s → 不重试
  ok(shouldRetryStaleSession({ errorMessage: "session not found", resumeSession: false, alreadyRetried: false, elapsedMs: 1000, aborted: false }) === false, "T2 FAIL: 非续接不重试");
  ok(shouldRetryStaleSession({ errorMessage: "session not found", resumeSession: true, alreadyRetried: true, elapsedMs: 1000, aborted: false }) === false, "T3 FAIL: 已重试不再重试");
  ok(shouldRetryStaleSession({ errorMessage: "session not found", resumeSession: true, alreadyRetried: false, elapsedMs: 6000, aborted: false }) === false, "T4 FAIL: 超5s不重试");

  // ★ BUG 复现:用户点停止 → abort 错误(msg 含 abort)+ 续接早期 → 绝不能重试,否则停不下来
  ok(
    shouldRetryStaleSession({ errorMessage: "The operation was aborted", resumeSession: true, alreadyRetried: false, elapsedMs: 1000, aborted: true }) === false,
    "T5 FAIL: 用户中止绝不能重试(否则点停止停不下来)"
  );

  console.log("agent-abort-retry tests passed");
})();
