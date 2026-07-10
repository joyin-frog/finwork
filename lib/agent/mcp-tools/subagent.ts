import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";
import { ROLE_REGISTRY } from "@/lib/agent/roles/registry";
import { listDispatchableRoleIds } from "@/lib/agent/roles/availability";
import { TASK_TEMPLATES, expandTaskTemplate } from "@/lib/agent/roles/task-templates";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";

type Sdk = SdkLike;

export function createSpawnSubagentTool(sdk: Sdk, outputDir: string, traceId?: string, conversationId?: string, onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void) {
  // 从 ROLE_REGISTRY 按 available 过滤，再经 listDispatchableRoleIds 排除用户停用的角色
  const dispatchableIds = listDispatchableRoleIds();
  const ROLE_IDS = dispatchableIds as [string, ...string[]];

  // subagent 型模板 id 列表（main-skill 型不进 enum）
  const SUBAGENT_TEMPLATE_IDS = TASK_TEMPLATES
    .filter((t) => t.mode === "subagent")
    .map((t) => t.id) as [string, ...string[]];

  const ROLE_CHEATSHEET = ROLE_REGISTRY
    .filter((r) => r.available && dispatchableIds.includes(r.id))
    .map((r) => {
      const subagentTemplates = TASK_TEMPLATES.filter(
        (t) => t.roleId === r.id && t.mode === "subagent"
      );
      const templateSuffix =
        subagentTemplates.length > 0
          ? `；模板：${subagentTemplates.map((t) => `${t.id}「${t.name}」`).join("、")}`
          : "";
      return `- ${r.id}（${r.name}）：${r.charter}${templateSuffix}`;
    })
    .join("\n");

  return sdk.tool(
    "spawn_subagent",
    `按预制角色派发一个子 Agent 执行特定独立任务。周期任务优先用 task_template 派发。
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
        .describe("给子 Agent 的详细任务指令或补充上下文；带 task_template 时此字段作为补充指令拼到模板后"),
      files: z
        .array(z.string())
        .nullish()
        .describe("传递给子 Agent 的文件绝对路径列表"),
      label: z
        .string()
        .default("subagent")
        .describe("用于标识此子任务的标签，结果中会显示"),
      task_template: z
        .enum(SUBAGENT_TEMPLATE_IDS)
        .nullish()
        .describe("预定义任务模板 id（subagent 型）；指定时 period 必填，instructions 作补充上下文"),
      period: z
        .string()
        .nullish()
        .describe("任务期间，格式 YYYY-MM；task_template 指定时必填"),
    },
    async (args: {
      role: string;
      instructions: string;
      files?: string[] | null;
      label: string;
      task_template?: string | null;
      period?: string | null;
    }) => {
      const { runSubagent } = await import("@/lib/agent/subagent-runner");

      // ── 模板路径 ──────────────────────────────────────────────────────────
      if (args.task_template) {
        // 校验：period 必填且格式合法
        if (!args.period || !/^\d{4}-\d{2}$/.test(args.period)) {
          return {
            content: [{
              type: "text" as const,
              text: `task_template 指定时 period 必填，且格式须为 YYYY-MM，实际：${args.period ?? "(空)"}`,
            }],
            isError: true as const,
          };
        }

        // 校验：模板须归属指定角色
        const template = TASK_TEMPLATES.find((t) => t.id === args.task_template);
        if (!template || template.roleId !== args.role) {
          return {
            content: [{
              type: "text" as const,
              text: `模板 "${args.task_template}" 不属于角色 "${args.role}"，请核对模板归属（各角色模板见工具说明）`,
            }],
            isError: true as const,
          };
        }

        // 展开模板，args.instructions 作补充上下文
        const expandedInstructions = expandTaskTemplate(
          args.task_template,
          args.period,
          args.instructions || undefined
        );

        const result = await runSubagent(
          {
            roleId: args.role,
            instructions: expandedInstructions,
            files: args.files ?? undefined,
            label: args.label,
            taskTemplateId: args.task_template,
            businessObject: template.objectLabel,
            period: args.period,
          },
          { parentOutputDir: outputDir, traceId, conversationId, onEvent: onSubagentEvent }
        );
        const text = [
          `子任务执行结果 [${result.label}]`,
          `状态：${result.success ? "成功" : "失败"}`,
          `耗时：${(result.durationMs / 1000).toFixed(1)}s`,
          "",
          result.content,
        ].join("\n");
        return { content: [{ type: "text" as const, text }], ...(result.success ? {} : { isError: true as const }) };
      }

      // ── 自由指令路径（无模板）─────────────────────────────────────────────
      const result = await runSubagent(
        {
          roleId: args.role,
          instructions: args.instructions,
          files: args.files ?? undefined,
          label: args.label,
        },
        { parentOutputDir: outputDir, traceId, conversationId, onEvent: onSubagentEvent }
      );
      const text = [
        `子任务执行结果 [${result.label}]`,
        `状态：${result.success ? "成功" : "失败"}`,
        `耗时：${(result.durationMs / 1000).toFixed(1)}s`,
        "",
        result.content,
      ].join("\n");
      return { content: [{ type: "text" as const, text }], ...(result.success ? {} : { isError: true as const }) };
    }
  );
}
