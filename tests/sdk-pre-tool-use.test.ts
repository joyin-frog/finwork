import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkPreToolUseHook } from "../lib/agent/hooks/sdk-pre-tool-use.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function preToolInput(toolName: string, toolInput: unknown) {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: `tool-${toolName}`,
    session_id: "session-security-test",
    transcript_path: "/tmp/security-test.jsonl",
    cwd: projectRoot,
  };
}

export const sdkPreToolUseTestPromise = (async () => {
  const outputDir = path.join(projectRoot, ".test-output");
  const callback = createSdkPreToolUseHook(outputDir);
  const options = { signal: new AbortController().signal };

  const bash = await callback(preToolInput("Bash", { command: "echo unsafe" }), "bash-1", options);
  assert.equal(bash.hookSpecificOutput?.hookEventName, "PreToolUse", "SPT-1 FAIL: 应返回 PreToolUse 输出");
  assert.equal(bash.hookSpecificOutput?.permissionDecision, "deny", "SPT-1 FAIL: Bash 必须由原生 hook 拒绝");

  const outsideWrite = await callback(
    preToolInput("Write", { file_path: path.join(projectRoot, "outside.txt"), content: "x" }),
    "write-outside",
    options
  );
  assert.equal(outsideWrite.hookSpecificOutput?.permissionDecision, "deny", "SPT-2 FAIL: 越界 Write 必须拒绝");

  const insideWrite = await callback(
    preToolInput("Write", { file_path: path.join(outputDir, "inside.txt"), content: "x" }),
    "write-inside",
    options
  );
  // 通过安全检查时不下任何 permissionDecision,交回正常权限流由 canUseTool 裁决。
  // 不能用 "allow"(抢先放行绕过确认)或 "defer"(触发未实现的 deferred_tool_use 恢复流程,会中断回合)。
  assert.equal(insideWrite.continue, true, "SPT-3 FAIL: 合法 Write 应继续");
  assert.equal(
    insideWrite.hookSpecificOutput?.permissionDecision,
    undefined,
    "SPT-3 FAIL: 合法 Write 不得下 permissionDecision,须交回正常权限流(canUseTool)"
  );

  const otherTool = await callback(preToolInput("AskUserQuestion", { questions: [] }), "ask-1", options);
  assert.equal(otherTool.continue, true, "SPT-4 FAIL: 非安全敏感内置工具应继续");
  assert.equal(
    otherTool.hookSpecificOutput?.permissionDecision,
    undefined,
    "SPT-4 FAIL: 其他工具不得抢先给出权限裁决"
  );

  for (const relativePath of ["lib/agent/claude-adapter.ts", "lib/agent/subagent-runner.ts"]) {
    const source = readFileSync(path.join(projectRoot, relativePath), "utf-8");
    assert.ok(source.includes("createSdkPreToolUseHook"), `SPT-5 FAIL: ${relativePath} 应创建原生 PreToolUse hook`);
    assert.match(source, /PreToolUse\s*:\s*\[\{\s*hooks\s*:\s*\[/s, `SPT-5 FAIL: ${relativePath} 应注册 hooks.PreToolUse`);
  }

  const subagentSource = readFileSync(path.join(projectRoot, "lib/agent/subagent-runner.ts"), "utf-8");
  assert.match(
    subagentSource,
    /import\s*\{[^}]*BUILTIN_TOOLS[^}]*\}\s*from\s*["']\.\/tools\/registry["']/s,
    "SPT-6 FAIL: 子 Agent 应从 registry 使用显式 BUILTIN_TOOLS 集合"
  );
  assert.match(
    subagentSource,
    /tools\s*:\s*\[\s*\.\.\.BUILTIN_TOOLS\s*,\s*["']Skill["']\s*\]/,
    "SPT-6 FAIL: 子 Agent 只应加载 BUILTIN_TOOLS + Skill"
  );
  assert.doesNotMatch(
    subagentSource,
    /preset\s*:\s*["']claude_code["']/,
    "SPT-6 FAIL: 子 Agent 不得加载会暴露未登记写工具的 claude_code preset"
  );

  console.log("sdk-pre-tool-use: native mechanism gate and main/subagent wiring ✓");
})();
