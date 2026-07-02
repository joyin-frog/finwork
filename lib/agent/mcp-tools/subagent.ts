import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";
import { ROLE_REGISTRY } from "@/lib/agent/roles/registry";
import { listDispatchableRoleIds } from "@/lib/agent/roles/availability";

type Sdk = SdkLike;

export function createSpawnSubagentTool(sdk: Sdk, outputDir: string, traceId?: string, conversationId?: string) {
  // 从 ROLE_REGISTRY 按 available 过滤，再经 listDispatchableRoleIds 排除用户停用的角色
  const dispatchableIds = listDispatchableRoleIds();
  const ROLE_IDS = dispatchableIds as [string, ...string[]];
  const ROLE_CHEATSHEET = ROLE_REGISTRY
    .filter((r) => r.available && dispatchableIds.includes(r.id))
    .map((r) => `- ${r.id}（${r.name}）：${r.charter}`)
    .join("\n");

  return sdk.tool(
    "spawn_subagent",
    `按预制角色派发一个子 Agent 执行特定独立任务。
适用场景：同类任务 N≥3、预计耗时>30s、任务间相互独立；一次响应可多次调用此工具，SDK 自动并行。
可派发角色：
${ROLE_CHEATSHEET}
【指令完整性】每个子任务必须给出完整独立的指令——子 Agent 不共享主对话历史，缺少上下文会导致执行失败。
不适用：单个简单任务、有顺序依赖的任务、需要和用户交互的任务、高风险写操作（子 Agent 内会被确认门拒绝，留在主对话经人确认后执行）。`,
    {
      role: z
        .enum(ROLE_IDS)
        .describe("派发目标角色 id（各角色职责见工具说明的角色速查）"),
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
    async (args: { role: string; instructions: string; files?: string[] | null; label: string }) => {
      const { runSubagent } = await import("@/lib/agent/subagent-runner");
      const result = await runSubagent(
        {
          roleId: args.role,
          instructions: args.instructions,
          files: args.files ?? undefined,
          label: args.label,
        },
        { parentOutputDir: outputDir, traceId, conversationId }
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
