import type { HookChain, HookContext, AfterHookContext } from "./types";

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
        });
        // 空回答(超时/通道中断)按未确认处理:宁可拒绝,不可放行
        const cancelled = !answer.trim() || /^(n|no|取消|否)$/i.test(answer.trim());
        if (cancelled) {
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
