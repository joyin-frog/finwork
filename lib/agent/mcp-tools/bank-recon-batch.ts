/**
 * run_bank_recon_batch: 银行对账批跑工具（spec-bank-recon-batch §3 步骤 2）
 *
 * 职责：
 *   - 接收多个银行流水文件路径（每账户一个，1-8 个）、可选账面文件、可选期间；
 *   - handler 内自行复查全部五条校验（不信任 schema）；
 *   - 按流水文件 fan-out 资金专员子代理，每账户一张对象化派发卡；
 *   - 聚合结果：按账户分段，仅全败置 isError。
 *
 * 接线：safe/finance，不进任何角色 tools 白名单（子代理不可递归批跑）。
 * deps 注入点用于测试隔离（fake runner 记录入参，fake fileExists 控制存在性）。
 */

import { z } from "zod/v4";
import path from "node:path";
import fs from "node:fs";
import type { SdkLike } from "./sdk-types";
import { currentYearMonth, expandTaskTemplate } from "@/lib/agent/roles/task-templates";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import type {
  SubagentParallelExecutor,
  SubagentTask,
} from "@/lib/agent/subagent-contracts";
import type { FinanceToolExecutionContext } from "@/lib/agent/tools/finance-definition";
import type { MemoryRuntimeContext } from "@/lib/memory-v2/contracts";
import type { AgentFoundationContext } from "@/lib/agent/contracts";

type Sdk = SdkLike;

/** runSubagentsParallel 同签名类型，供 deps 注入与测试。 */
type RunParallelFn = SubagentParallelExecutor;

export type BankReconBatchDeps = {
  /** 注入替代 runSubagentsParallel（测试用）；生产路径缺省动态 import subagent-runner */
  run?: RunParallelFn;
  /** 注入替代 fs.existsSync（测试用）；生产路径缺省调用真实函数 */
  fileExists?: (p: string) => boolean;
  /** Runtime-authoritative memory scope inherited by every batch child. */
  memoryContext?: Partial<MemoryRuntimeContext> | null;
  foundation?: AgentFoundationContext;
  modelOverride?: string;
};

export function createRunBankReconBatchTool(
  sdk: Sdk,
  outputDir: string,
  traceId?: string,
  conversationId?: string,
  onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void,
  deps?: BankReconBatchDeps
) {
  return sdk.tool(
    "run_bank_recon_batch",
    [
      "批量派发银行对账：将多个银行流水文件分别交给资金专员子代理处理，每个文件产出一张对象化派发卡（进看板「银行对账」节点，需人工锁定确认）。",
      "多账户批量对账用本工具；单账户对账用 spawn_subagent + bank-recon 模板。",
      "注意：每个流水文件消耗一次派发额度。",
    ].join("\n"),
    {
      statement_files: z
        .array(z.string())
        .min(1)
        .max(8)
        .describe("银行流水文件绝对路径列表（每账户一个，1-8 个）"),
      book_file: z
        .string()
        .nullish()
        .describe("账面记录文件绝对路径（可选；有多账户数据时由子代理按账户列筛选）"),
      period: z
        .string()
        .nullish()
        .describe("对账期间，格式 YYYY-MM；缺省取当前年月"),
    },
    async (args: {
      statement_files?: string[] | null;
      book_file?: string | null;
      period?: string | null;
    }, execution?: FinanceToolExecutionContext) => {
      // ── 五条校验（handler 内自行复查，不信任 schema） ────────────────────────────

      // 1. statement_files 非空
      const statementFiles = Array.isArray(args.statement_files) ? args.statement_files : [];
      if (statementFiles.length === 0) {
        return {
          content: [{ type: "text" as const, text: "statement_files 不能为空，请至少提供 1 个银行流水文件路径。" }],
          isError: true as const,
        };
      }

      // 2. statement_files 不超过 8 个
      if (statementFiles.length > 8) {
        return {
          content: [{ type: "text" as const, text: `statement_files 最多 8 个，实际 ${statementFiles.length} 个。请分批调用。` }],
          isError: true as const,
        };
      }

      // 3. period 格式（缺省当前年月）
      const period = (args.period ?? "").trim() || currentYearMonth();
      if (!/^\d{4}-\d{2}$/.test(period)) {
        return {
          content: [{ type: "text" as const, text: `period 格式非法，须为 YYYY-MM，实际：${period}` }],
          isError: true as const,
        };
      }

      // 4. book_file 与 statement_files 去重冲突
      const bookFile = args.book_file ?? null;
      if (bookFile && statementFiles.includes(bookFile)) {
        return {
          content: [{ type: "text" as const, text: `book_file（${bookFile}）与 statement_files 中的条目重复，账面文件与流水文件必须分开提供。` }],
          isError: true as const,
        };
      }

      // 5. 逐个文件存在性检查（含 book_file），任一不存在 → 整批不派发
      const fileExistsFn = deps?.fileExists ?? ((p: string) => fs.existsSync(p));
      const missingFiles: string[] = [];
      for (const f of statementFiles) {
        if (!fileExistsFn(f)) missingFiles.push(f);
      }
      if (bookFile && !fileExistsFn(bookFile)) {
        missingFiles.push(bookFile);
      }
      if (missingFiles.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: [
              "以下文件不存在，整批不派发，请确认路径后重试：",
              ...missingFiles.map((f) => `  - ${f}`),
            ].join("\n"),
          }],
          isError: true as const,
        };
      }

      // ── 组装子任务（每个流水文件一个 SubagentTask） ──────────────────────────────
      const tasks: SubagentTask[] = statementFiles.map((file) => {
        const businessObject = path.basename(file, path.extname(file));
        const extra = bookFile
          ? `本卡只负责账户流水文件：${file}；账面记录文件：${bookFile}（只取属于本账户的记录）`
          : `本卡只负责账户流水文件：${file}；用户未提供账面记录文件，按缺账面降级路径执行`;
        const instructions = expandTaskTemplate("bank-recon", period, extra);
        return {
          roleId: "treasury-officer",
          instructions,
          label: `银行对账·${businessObject}`,
          taskTemplateId: "bank-recon",
          businessObject,
          period,
          files: [file, ...(bookFile ? [bookFile] : [])],
        };
      });

      // ── 并行跑（runSubagentsParallel 内部 Promise.allSettled 保序——
      //    结果数组与 tasks 入参顺序一一对应，本工具依赖此假设） ───────────────────
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
        foundation: deps?.foundation,
        modelOverride: deps?.modelOverride,
        onEvent: onSubagentEvent,
        signal: execution?.signal,
      });

      // ── 聚合：按账户分段，仅全败置 isError ──────────────────────────────────────
      const segments = results.map((r, i) => {
        const file = statementFiles[i];
        const name = path.basename(file, path.extname(file));
        return [
          `【${name}】`,
          `状态：${r.success ? "成功" : "失败"}`,
          `耗时：${(r.durationMs / 1000).toFixed(1)}s`,
          r.content,
        ].join("\n");
      });

      const allFailed = results.every((r) => !r.success);
      const text = [
        ...segments,
        "",
        `本批 ${statementFiles.length} 个账户的对账卡已进看板「银行对账」节点，确认无误后请在角色抽屉中逐张锁定。`,
      ].join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        ...(allFailed ? { isError: true as const } : {}),
      };
    }
  );
}
