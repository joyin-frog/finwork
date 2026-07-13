import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { runBeforeHooks } from "./chain";
import { createPathSafetyHook, createReadGuardHook, createUnwiredToolHook } from "./built-in";

const SECURITY_SENSITIVE_BUILTINS = new Set(["Bash", "Read", "Write", "Edit", "MultiEdit"]);

/**
 * SDK 原生 PreToolUse 机制闸。
 *
 * 安全检查只负责 deny 或 defer：通过检查后仍交给 canUseTool 作最终裁决，
 * 避免原生 hook 抢先放行并绕过确认、交互等后续逻辑。
 */
export function createSdkPreToolUseHook(outputDir: string): HookCallback {
  const securityHooks = [
    createUnwiredToolHook(),
    createReadGuardHook(),
    createPathSafetyHook(),
  ];

  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };

    if (!SECURITY_SENSITIVE_BUILTINS.has(input.tool_name)) {
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: "PreToolUse" },
      };
    }

    const result = await runBeforeHooks(securityHooks, {
      toolName: input.tool_name,
      input: input.tool_input,
      outputDir,
    });

    return {
      continue: true,
      hookSpecificOutput: result.behavior === "deny"
        ? {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: result.message,
          }
        : {
            hookEventName: "PreToolUse",
            permissionDecision: "defer",
          },
    };
  };
}
