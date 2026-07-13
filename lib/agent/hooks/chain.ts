import type { HookChain, HookContext, AfterHookContext } from "./types";

const EXPLICIT_CONFIRM_ANSWERS = new Set([
  "确认",
  "确认执行",
  "是",
  "同意",
  "执行",
  "继续执行",
  "y",
  "yes",
  "approve",
]);

export async function runBeforeHooks(
  chain: HookChain,
  ctx: HookContext
): Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }> {
  let currentInput = ctx.input;

  for (const hook of chain) {
    if (!hook.before) continue;
    const result = await hook.before({ ...ctx, input: currentInput });

    if (result.action === "deny") {
      return { behavior: "deny", message: result.reason };
    }

    if (result.action === "confirm") {
      if (ctx.resolveUserQuestion) {
        const answer = await ctx.resolveUserQuestion({
          question: result.prompt,
          header: "操作确认",
          kind: "confirm",
        });
        // 只接受精确、明确的肯定答案；超时、取消、含糊或否定文本一律 fail-closed。
        if (!EXPLICIT_CONFIRM_ANSWERS.has(answer.trim().toLowerCase())) {
          return { behavior: "deny", message: `用户取消了操作：${ctx.toolName}` };
        }
      } else {
        return {
          behavior: "deny",
          message: `需要用户确认才能执行 ${ctx.toolName}，但当前通道不支持交互式确认。请明确确认后重试。`,
        };
      }
    }

    if (result.action === "allow" && result.input !== undefined) {
      currentInput = result.input;
    }
  }

  return { behavior: "allow", updatedInput: currentInput };
}

export async function runAfterHooks(chain: HookChain, ctx: AfterHookContext): Promise<void> {
  for (const hook of chain) {
    if (!hook.after) continue;
    try {
      await hook.after(ctx);
    } catch (err) {
      console.error(`[hook:after] ${hook.name} threw`, err);
    }
  }
}
