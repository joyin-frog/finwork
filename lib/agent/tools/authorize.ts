import { runAfterHooks, runBeforeHooks } from "@/lib/agent/hooks/chain";
import {
  createAskUserQuestionHook,
  createPathSafetyHook,
  createReadGuardHook,
  createRiskConfirmHook,
  createRoleScopeHook,
  createStuckGuardHook,
  createUnwiredToolHook,
} from "@/lib/agent/hooks/built-in";
import type { HookChain } from "@/lib/agent/hooks/types";
import type { FinanceToolDefinition } from "@/lib/agent/tools/finance-definition";
import type { AgentQuestion } from "@/lib/agent/contracts";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";

export type FinanceToolAuthorizationContext = {
  outputDir: string;
  conversationId?: number;
  roleId?: string | null;
  resolveUserQuestion?: (question: AgentQuestion) => Promise<string>;
  emit?: (event: AgentRuntimeEvent) => void;
};

export type FinanceToolAuthorization = ((
  definition: FinanceToolDefinition,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => Promise<void>) & {
  after(
    definition: FinanceToolDefinition,
    args: Record<string, unknown>,
    result: string,
    isError: boolean,
    durationMs: number,
  ): Promise<void>;
};

/**
 * Runtime-neutral authorization entrypoint shared by Pi custom tools.
 * It deliberately reuses the frozen AS0 hook semantics during AS1.
 */
export function createFinanceToolAuthorizer(context: FinanceToolAuthorizationContext) {
  const chain: HookChain = [
    createUnwiredToolHook(),
    createReadGuardHook(),
    createStuckGuardHook(),
    createAskUserQuestionHook(),
    createPathSafetyHook(),
    ...(context.roleId ? [createRoleScopeHook(context.roleId)] : []),
    createRiskConfirmHook(),
  ];
  const authorize = async (
    definition: FinanceToolDefinition,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    if (signal?.aborted) throw new Error("Tool execution aborted");
    const decision = await runBeforeHooks(chain, {
      toolName: definition.id,
      input: args,
      outputDir: context.outputDir,
      conversationId: context.conversationId,
      resolveUserQuestion: context.resolveUserQuestion,
    });
    if (decision.behavior === "deny") {
      context.emit?.({
        type: "run_blocked",
        toolName: definition.id,
        summary: decision.message ?? `Tool denied: ${definition.id}`,
      });
      throw new Error(decision.message ?? `Tool denied: ${definition.id}`);
    }
  };
  authorize.after = async (
    definition: FinanceToolDefinition,
    args: Record<string, unknown>,
    result: string,
    isError: boolean,
    durationMs: number,
  ) => {
    await runAfterHooks(chain, {
      toolName: definition.id,
      input: args,
      outputDir: context.outputDir,
      conversationId: context.conversationId,
      resolveUserQuestion: context.resolveUserQuestion,
      result,
      isError,
      durationMs,
    });
  };
  return authorize as FinanceToolAuthorization;
}
