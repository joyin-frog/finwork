import type { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { ZodRawShape } from "zod/v4";
import { ZodError } from "zod/v4";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SdkMcpToolDef = any;

export type SdkLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: (name: string, description: string, schema: ZodRawShape, handler: (args: any) => any) => SdkMcpToolDef;
  createSdkMcpServer?: typeof createSdkMcpServer;
};

/**
 * Wraps a tool handler to catch ZodError and return a human-readable error
 * that the model can use to self-correct its arguments.
 */
export function wrapToolHandler<S extends ZodRawShape>(
  _schema: S,
  handler: (args: Record<string, unknown>) => Promise<unknown>
): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args: Record<string, unknown>) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ZodError) {
        const messages = error.issues.map(
          (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `工具调用参数错误：\n${messages.join("\n")}\n请修正参数后重试。`,
            },
          ],
          isError: true,
        };
      }
      throw error;
    }
  };
}
