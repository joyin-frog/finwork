import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { runBeforeHooks } from "./chain";
import { createPathSafetyHook, createReadGuardHook, createUnwiredToolHook } from "./built-in";

const SECURITY_SENSITIVE_BUILTINS = new Set(["Bash", "Read", "Write", "Edit", "MultiEdit"]);

/**
 * SDK 原生 PreToolUse 机制闸。
 *
 * 安全检查只负责 deny：命中即以 permissionDecision:"deny" 短路拒绝（deny 会绕过 canUseTool）。
 * 通过检查时不下任何 permissionDecision，交回 SDK 正常权限流——由于内置工具已移出 allowedTools，
 * 会继续走到 canUseTool 作最终裁决。绝不在原生 hook 中 approve/defer：
 * "allow" 会抢先放行并绕过确认逻辑；"defer" 会触发 deferred_tool_use / tool_deferred 终止流程，
 * 而 runClaudeAgent / runSubagent 未实现 deferred 恢复，会让合法工具调用中断整个回合。
 */
export function createSdkPreToolUseHook(outputDir: string): HookCallback {
  const securityHooks = [
    createUnwiredToolHook(),
    createReadGuardHook(),
    createPathSafetyHook(),
  ];

  // 通过检查（含非安全敏感工具）：不下 permissionDecision，交回正常权限流。
  const passThrough: HookJSONOutput = {
    continue: true,
    hookSpecificOutput: { hookEventName: "PreToolUse" },
  };

  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };

    if (!SECURITY_SENSITIVE_BUILTINS.has(input.tool_name)) {
      return passThrough;
    }

    const result = await runBeforeHooks(securityHooks, {
      toolName: input.tool_name,
      input: input.tool_input,
      outputDir,
    });

    if (result.behavior === "deny") {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.message,
        },
      };
    }

    return passThrough;
  };
}
