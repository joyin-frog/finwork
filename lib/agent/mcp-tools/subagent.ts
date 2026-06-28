import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

export function createSpawnSubagentTool(sdk: Sdk, outputDir: string) {
  return sdk.tool(
    "spawn_subagent",
    `派生一个专门的子 Agent 执行特定独立任务。
适用场景：同类任务 N≥3、预计耗时>30s、任务间相互独立；一次响应可多次调用此工具，SDK 自动并行。
【指令完整性】每个子任务必须给出完整独立的指令——子 Agent 不共享主对话历史，缺少上下文会导致执行失败。
不适用：单个简单任务、有顺序依赖的任务、需要和用户交互的任务。`,
    {
      skill: z
        .enum(["reimbursement-check", "payroll-calc", "finance-analysis", "kingdee-draft", "excel-finance"])
        .describe("子 Agent 使用的 skill"),
      instructions: z
        .string()
        .describe("给子 Agent 的详细任务指令，包含所有必要上下文（子 Agent 不共享主 Agent 的对话历史）"),
      files: z
        .array(z.string())
        .nullish()
        .describe("传递给子 Agent 的文件绝对路径列表"),
      label: z
        .string()
        .default("subagent")
        .describe("用于标识此子任务的标签，结果中会显示"),
    },
    async (args: { skill: string; instructions: string; files?: string[] | null; label: string }) => {
      const { runSubagent } = await import("@/lib/agent/subagent-runner");
      const result = await runSubagent(
        {
          skill: args.skill,
          instructions: args.instructions,
          files: args.files ?? undefined,
          label: args.label,
        },
        { parentOutputDir: outputDir }
      );
      return [
        `子任务执行结果 [${result.label}]`,
        `状态：${result.success ? "成功" : "失败"}`,
        `耗时：${(result.durationMs / 1000).toFixed(1)}s`,
        "",
        result.content,
      ].join("\n");
    }
  );
}
