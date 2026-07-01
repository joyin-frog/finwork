import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runBeforeHooks } from "../lib/agent/hooks/chain.ts";
import { createUnwiredToolHook } from "../lib/agent/hooks/built-in.ts";

export const agentPipelineTestPromise = (async () => {
  // ── AC5: 收尾逻辑唯一(双路径共用 persistAgentTurn) ──
  const routeSource = fs.readFileSync(
    path.join(import.meta.dirname, "../app/api/agent/query/route.ts"),
    "utf-8"
  );
  const assistantInserts = routeSource.match(/insertChatMessage\(conversationId, "assistant"/g) ?? [];
  assert.equal(assistantInserts.length, 1, "AC5 FAIL: assistant 消息落库必须只在共用收尾函数中出现 1 处");
  assert.ok(routeSource.includes("function persistAgentTurn"), "AC5 FAIL: 应存在共用收尾函数 persistAgentTurn");
  assert.ok(!routeSource.includes("finalizeNonStreaming"), "AC5 FAIL: 旧的非 streaming 收尾应已删除");
  const persistCalls = routeSource.match(/persistAgentTurn\(\{ \.\.\.persistParams/g) ?? [];
  assert.equal(persistCalls.length, 2, "AC5 FAIL: streaming 与非 streaming 都应调用 persistAgentTurn");
  // 模型分层已从"路由按 intent 自动升级"改为"用户在输入框选深度思考,默认快速"(见 lib/agent/router.ts
  // 的 resolveModelByTier/normalizeTier);pickAgentModel 已废弃移除,断言改为校验新接线点。
  assert.ok(routeSource.includes("resolveModelByTier"), "AC5 FAIL: 模型分层应已接线(resolveModelByTier)");
  assert.ok(routeSource.includes("normalizeTier"), "AC5 FAIL: 模型分层应已接线(normalizeTier)");

  // ── AC6: Bash 机制兜底 ──
  const chain = [createUnwiredToolHook()];
  const ctx = (toolName: string) => ({ toolName, input: {}, activeSkills: [], outputDir: "/tmp" });

  const bash = await runBeforeHooks(chain, ctx("Bash"));
  assert.equal(bash.behavior, "deny", "AC6 FAIL: Bash 必须被机制性拒绝");
  assert.ok(bash.message?.includes("run_python"), "AC6 FAIL: 拒绝提示应指向 run_python");

  const read = await runBeforeHooks(chain, ctx("Read"));
  assert.equal(read.behavior, "allow", "AC6 FAIL: Read 不应被拦截");
  const python = await runBeforeHooks(chain, ctx("mcp__finance_worker__run_python"));
  assert.equal(python.behavior, "allow", "AC6 FAIL: run_python 不应被拦截");

  console.log("agent-pipeline: all 2 checks passed ✓");
})();
