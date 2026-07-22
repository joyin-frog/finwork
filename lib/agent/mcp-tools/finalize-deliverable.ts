import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import type { TaskContract } from "@/lib/agent/run-contract";
import {
  FINALIZED_MARKER,
  finalizeDeliverables,
  MemoryDeliverableStore,
  SqliteDeliverableStore,
  type DeliverableStore,
  type FinalizeDeps,
  type FinalizeFile,
} from "@/lib/deliverable";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

export { FINALIZED_MARKER };

export type FinalizeDeliverableToolOptions = {
  runId?: string;
  taskContract?: TaskContract | (() => TaskContract | null | undefined);
  conversationFilesDir?: string;
  conversationId?: number;
  messageId?: number;
  deps?: FinalizeDeps;
};

function defaultStore(): DeliverableStore {
  try {
    // 延迟 import，避免工具加载期强依赖 DB 初始化顺序
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db/sqlite") as typeof import("@/lib/db/sqlite");
    const db = getDb();
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deliverables'")
      .get();
    if (has) return new SqliteDeliverableStore(db);
  } catch {
    /* fall through */
  }
  return new MemoryDeliverableStore();
}

/**
 * finalize_deliverable — CR-Q1 质量门。
 * 入参 FinalizeFile{name, contractDeliverableId}；只提交 CompletionEvidence，绝不写 Run completed。
 */
export function createFinalizeDeliverableTool(
  sdk: Sdk,
  outputDir: string,
  options: FinalizeDeliverableToolOptions = {}
) {
  return sdk.tool(
    "finalize_deliverable",
    [
      "一次回答结束、文件产物已定稿时调用：声明最终交付文件及其合同 deliverable id。",
      "系统按 TaskContract 做存在性/类型/可打开性/表格重算等校验，通过后复制到不可变 delivered/ 并提交 CompletionEvidence。",
      "不要传 kind/profile/mime 覆盖字段——质量档位以合同为准。",
      "验证失败时工作文件与报告保留；未通过质量门的文件不会成为正式附件。",
      "每次回答最多调用一次，放在最后一步。",
    ].join("\n"),
    {
      files: z
        .array(
          z.object({
            name: z.string().min(1).describe("最终交付文件名（basename，不要写路径）"),
            contractDeliverableId: z
              .string()
              .min(1)
              .describe("TaskContract.requiredDeliverables[].id"),
          })
        )
        .min(1)
        .describe('如 [{ "name": "科目表差异汇总.xlsx", "contractDeliverableId": "workbook" }]'),
    },
    async (args: { files: FinalizeFile[] }) => {
      try {
        const contract =
          typeof options.taskContract === "function"
            ? options.taskContract()
            : options.taskContract;
        if (!contract) {
          return {
            content: [
              {
                type: "text" as const,
                text: "TaskContract 未接线，无法 finalize。请由系统注入合同后再声明交付物。",
              },
            ],
            isError: true as const,
            structuredContent: { code: "missing_task_contract" },
          };
        }

        const runId = options.runId?.trim() || `run-${randomUUID()}`;
        const store = options.deps?.store ?? defaultStore();
        const evidenceSink =
          options.deps?.evidenceSink ??
          (typeof (store as { submit?: unknown }).submit === "function"
            ? (store as MemoryDeliverableStore)
            : new MemoryDeliverableStore());
        const result = await finalizeDeliverables(
          args.files,
          {
            runId,
            outputDir,
            conversationFilesDir: options.conversationFilesDir,
            taskContract: contract,
            conversationId: options.conversationId,
            messageId: options.messageId,
          },
          { ...options.deps, store, evidenceSink }
        );

        if (!result.ok) {
          const detail =
            result.failures
              ?.map(
                (f) =>
                  `${f.name}(${f.contractDeliverableId}): ${f.errors.map((e) => e.message).join("; ")}`
              )
              .join("\n") ?? result.error;
          return {
            content: [{ type: "text" as const, text: `交付质量门未通过：${detail}` }],
            isError: true as const,
            structuredContent: {
              code: result.code,
              error: result.error,
              failures: result.failures,
            },
          };
        }

        const gateNote =
          result.gate.ok
            ? "合同所需交付物证据已齐。"
            : `证据未齐，缺少: ${result.gate.missing.join(", ")}（Run 完成态由 CompletionGate 决定，本工具不写 completed）。`;

        return {
          content: [
            {
              type: "text" as const,
              text: `已验证并交付: ${result.declaredNames.join("、")}。${gateNote}`,
            },
          ],
          structuredContent: {
            finalized: result.finalized,
            evidences: result.evidences,
            gate: result.gate,
            // 明确：不包含 runStatus / completed
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `声明最终产物失败:${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true as const,
        };
      }
    }
  );
}
