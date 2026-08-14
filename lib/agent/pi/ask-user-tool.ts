import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@earendil-works/pi-ai";
import { z } from "zod/v4";
import type { AgentQuestion } from "@/lib/agent/contracts";
import { createAskUserQuestionHook } from "@/lib/agent/hooks/built-in";

const optionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  preview: z.string().optional(),
});

const questionSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(optionSchema).optional(),
});

const askUserQuestionSchema = z.object({
  questions: z.array(questionSchema).min(1).max(3),
});

type AskUserQuestionResult = {
  questions: AgentQuestion[];
  answers: Record<string, string>;
};

/**
 * Pi 没有 Claude Agent SDK 的 AskUserQuestion 内置工具；Finwork 在这里补齐
 * 同名的模型可调用工具，并复用既有 hook，避免实时会话与其它 runtime 出现两套问答语义。
 */
export function createPiAskUserQuestionTool(
  resolveUserQuestion: (question: AgentQuestion) => Promise<string>,
): ToolDefinition {
  const hook = createAskUserQuestionHook();
  return {
    name: "AskUserQuestion",
    label: "向用户提问",
    description: "缺少关键输入、存在冲突口径或必须由用户选择时，暂停当前任务并向用户提出一至三个结构化问题。",
    promptSnippet: "AskUserQuestion: pause and request missing input or a user decision.",
    promptGuidelines: [
      "缺少关键输入、存在冲突口径或必须由用户选择时，调用 AskUserQuestion，不要只在普通回复中提问。",
    ],
    parameters: z.toJSONSchema(askUserQuestionSchema, {
      target: "draft-7",
      unrepresentable: "any",
    }) as TSchema,
    executionMode: "sequential",
    async execute(_toolCallId, rawArgs, signal) {
      if (signal?.aborted) throw new Error("Tool execution aborted");
      const args = await askUserQuestionSchema.parseAsync(rawArgs);
      const decision = await hook.before!({
        toolName: "AskUserQuestion",
        input: args,
        outputDir: "",
        resolveUserQuestion,
      });
      if (decision.action === "deny") throw new Error(decision.reason);
      if (decision.action !== "allow" || !decision.input) {
        throw new Error("AskUserQuestion did not return a user decision");
      }
      const result = decision.input as AskUserQuestionResult;
      const text = result.questions.length === 1
        ? result.answers[result.questions[0].question] ?? ""
        : JSON.stringify(result.answers);
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };
}
