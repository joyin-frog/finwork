/**
 * run_filing_precheck_batch: 申报前复核批跑工具（spec-filing-precheck-batch §3 步骤 2）
 *
 * 职责：
 *   - 接收可选 period（缺省取当前年月），校验格式；
 *   - 读取公司画像注入纳税人资格上下文；
 *   - 并行派发增值税及附加复核、个税申报一致性复核两个税务专员子代理；
 *   - 聚合结果：按税种分段，仅双双失败时置 isError。
 *
 * 接线：safe/finance，不进任何角色 tools 白名单（子代理不可递归批跑）。
 * deps 注入点用于测试隔离（fake runner 记录入参，fake readProfile 控制画像）。
 */

import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";
import { currentYearMonth, expandTaskTemplate, getTaskTemplate } from "@/lib/agent/roles/task-templates";
import { readCompanyProfile } from "@/lib/profile/file-store";
import type { CompanyProfile } from "@/lib/profile/file-store";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import type {
  SubagentParallelExecutor,
  SubagentTask,
} from "@/lib/agent/subagent-contracts";
import type { FinanceToolExecutionContext } from "@/lib/agent/tools/finance-definition";
import type { MemoryRuntimeContext } from "@/lib/memory-v2/contracts";
import type { AgentRunContext } from "@/lib/agent/contracts";

type Sdk = SdkLike;

/** runSubagentsParallel 同签名类型，供 deps 注入与测试。 */
type RunParallelFn = SubagentParallelExecutor;

export type FilingPrecheckBatchDeps = {
  /** 注入替代 runSubagentsParallel（测试用）；生产路径缺省动态 import subagent-runner */
  run?: RunParallelFn;
  /** 注入替代 readCompanyProfile（测试用）；生产路径缺省调用真实函数 */
  readProfile?: () => Promise<CompanyProfile>;
  /** Runtime-authoritative memory scope inherited by every batch child. */
  memoryContext?: Partial<MemoryRuntimeContext> | null;
  runContext?: AgentRunContext;
  modelOverride?: string;
};

const TEMPLATE_IDS = ["vat-filing-precheck", "iit-filing-precheck"] as const;

export function createRunFilingPrecheckBatchTool(
  sdk: Sdk,
  outputDir: string,
  traceId?: string,
  conversationId?: string,
  onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void,
  deps?: FilingPrecheckBatchDeps
) {
  return sdk.tool(
    "run_filing_precheck_batch",
    [
      "批量派发申报前复核：同时派出「增值税及附加」和「个税」两个税务专员子代理，各产出一张对象化派发卡（进看板，需人工锁定确认）。",
      "需要把申报前复核整套跑一遍（增值税+个税各一卡）用本工具；单税种复核用 spawn_subagent + 对应模板。",
      "注意：一次调用消耗两次派发额度。",
    ].join("\n"),
    {
      period: z
        .string()
        .nullish()
        .describe("复核期间，格式 YYYY-MM；缺省取当前年月"),
    },
    async (args: { period?: string | null }, execution?: FinanceToolExecutionContext) => {
      // 1. 确定期间
      const period = (args.period ?? "").trim() || currentYearMonth();

      // 2. 校验格式
      if (!/^\d{4}-\d{2}$/.test(period)) {
        return {
          content: [{ type: "text" as const, text: `period 格式非法，须为 YYYY-MM，实际：${period}` }],
          isError: true as const,
        };
      }

      // 3. 读取公司画像（readCompanyProfile 内部已兜异常，失败返回 {}，无需额外 try/catch）
      const readProfileFn = deps?.readProfile ?? readCompanyProfile;
      const profile = await readProfileFn();
      const taxpayerType = profile.taxpayerType;

      const extra = taxpayerType
        ? `本公司纳税人资格：${taxpayerType}（增值税${taxpayerType === "一般纳税人" ? "月报" : "季报"}口径，申报期限以当年日历为准）`
        : "纳税人资格未配置：请先形式判断本期适用性，无法判断的项列为无法核验";

      // 4. 组装 2 个子任务（expandTaskTemplate 自动追加「补充上下文：」前缀）
      const tasks: SubagentTask[] = TEMPLATE_IDS.map((id) => {
        const template = getTaskTemplate(id)!;
        const instructions = expandTaskTemplate(id, period, extra);
        return {
          roleId: "tax-officer",
          instructions,
          label: template.name,
          taskTemplateId: id,
          businessObject: template.objectLabel,
          period,
        };
      });

      // 5. 并行跑（复用 runSubagentsParallel，Promise.allSettled + 信号量）
      if (!deps?.run) {
        return {
          content: [{ type: "text" as const, text: "当前 Agent runtime 未配置批量子代理执行器。" }],
          isError: true as const,
        };
      }
      const runFn: RunParallelFn = deps.run;

      const results = await runFn(tasks, {
        parentOutputDir: outputDir,
        traceId,
        conversationId,
        memoryContext: deps?.memoryContext,
        runContext: deps?.runContext,
        modelOverride: deps?.modelOverride,
        onEvent: onSubagentEvent,
        signal: execution?.signal,
      });

      // 6. 聚合：按税种分段，仅双双失败时置 isError
      const segments = results.map((r, i) => {
        const templateId = TEMPLATE_IDS[i];
        const template = getTaskTemplate(templateId)!;
        return [
          `【${template.name}】`,
          `状态：${r.success ? "成功" : "失败"}`,
          `耗时：${(r.durationMs / 1000).toFixed(1)}s`,
          r.content,
        ].join("\n");
      });

      const allFailed = results.every((r) => !r.success);
      const text = [
        ...segments,
        "",
        "两张复核卡已进看板，确认无误后请在角色抽屉中逐张锁定。",
      ].join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        ...(allFailed ? { isError: true as const } : {}),
      };
    }
  );
}
