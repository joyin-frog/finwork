import { createAnalyzeTabularTool } from "./analyze-tabular";
import { createSpawnSubagentTool } from "./subagent";
import { createRememberConventionTool } from "./conventions";
import { createRememberRoleConventionTool } from "./role-conventions";
import { createRecordBusinessMetricsTool } from "./business-metrics";
import { createBusinessAnalysisTool } from "./business-analysis-tool";
import { createSearchKnowledgeTool, createQueryKnowledgeTool, createReadFileTool } from "./knowledge";
import { createReadDocumentTool } from "./read-document";
import { createScanSlipFolderTool } from "./scan-slip-folder";
import { createKingdeeTools } from "./kingdee-tools";
import { createFinanceTools } from "./finance-tools";
import { createPayrollTools } from "../tools/finance/payroll";
import { createReimbursementTools } from "../tools/finance/reimbursement";
import { createSalesInvoiceTools } from "../tools/finance/sales-invoices";
import { createReconciliationTools } from "../tools/finance/reconciliation";
import { createRecordDocumentMetadataTool } from "./document-metadata";
import { createUpdateCompanyProfileTool } from "./profile";
import { createFinalizeDeliverableTool, type FinalizeDeliverableToolOptions } from "./finalize-deliverable";
import { createEmitChecklistTool } from "./emit-checklist";
import { createRunFilingPrecheckBatchTool } from "./filing-precheck-batch";
import { createRunBankReconBatchTool } from "./bank-recon-batch";
import { createUndoLastWriteTool } from "./undo-write";
import { createProposeTransferTool } from "./propose-transfer";
import type { SdkLike } from "./sdk-types";
import {
  createFinanceToolCollector,
  type FinanceToolDefinition,
} from "@/lib/agent/tools/finance-definition";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import { getConversationFilesDir } from "@/lib/runtime/paths";
import type {
  SubagentExecutor,
  SubagentParallelExecutor,
} from "@/lib/agent/subagent-contracts";

type Sdk = SdkLike & { createSdkMcpServer: NonNullable<SdkLike["createSdkMcpServer"]> };

export type FinanceMcpServerOptions = {
  /** CR-Q1：由宿主注入 TaskContract（R1 Query Pipeline 接线）；缺省则 finalize 拒绝声明。 */
  finalize?: FinalizeDeliverableToolOptions;
  /** Runtime-owned subagent seams. Claude remains the legacy default. */
  subagentExecutor?: SubagentExecutor;
  subagentParallelExecutor?: SubagentParallelExecutor;
  /** 本回合用户附件的只读根；供 read_document 使用。 */
  readDocumentAllowedRoots?: string[];
};

function createFinanceWorkerTools(
  sdk: SdkLike,
  outputDir: string,
  traceId?: string,
  conversationId?: string,
  onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void,
  serverOptions?: FinanceMcpServerOptions,
) {
  const cidNum = conversationId != null && conversationId !== "" ? Number(conversationId) : undefined;
  const finalizeOpts: FinalizeDeliverableToolOptions = {
    runId: traceId,
    conversationId: Number.isFinite(cidNum) ? cidNum : undefined,
    conversationFilesDir:
      cidNum != null && Number.isFinite(cidNum) ? getConversationFilesDir(cidNum) : undefined,
    ...serverOptions?.finalize,
  };
  return [
    createAnalyzeTabularTool(sdk),
      createSpawnSubagentTool(
        sdk,
        outputDir,
        traceId,
        conversationId,
        onSubagentEvent,
        serverOptions?.subagentExecutor,
      ),
      createSearchKnowledgeTool(sdk),
      createQueryKnowledgeTool(sdk),
      createReadFileTool(sdk),
      createReadDocumentTool(sdk, {
        allowedRoots: [outputDir, ...(serverOptions?.readDocumentAllowedRoots ?? [])],
      }),
      createScanSlipFolderTool(sdk),
      createRememberConventionTool(sdk),
      createRememberRoleConventionTool(sdk),
      createRecordBusinessMetricsTool(sdk),
      createBusinessAnalysisTool(sdk),
      ...createPayrollTools(sdk, outputDir),
      ...createReimbursementTools(sdk),
      ...createSalesInvoiceTools(sdk),
      ...createReconciliationTools(sdk),
      ...createFinanceTools(sdk, outputDir),
      createRecordDocumentMetadataTool(sdk),
      // P3: 公司画像
      createUpdateCompanyProfileTool(sdk),
      // CR-Q1: 质量门 + 不可变 delivered/；只提交 CompletionEvidence
      createFinalizeDeliverableTool(sdk, outputDir, finalizeOpts),
      // WP14a: 把清单产物物化为可勾选工件
      createEmitChecklistTool(sdk, undefined, conversationId),
      // 功能4首刀: 申报前复核批跑（增值税+个税并行派发）
      createRunFilingPrecheckBatchTool(
        sdk,
        outputDir,
        traceId,
        conversationId,
        onSubagentEvent,
        serverOptions?.subagentParallelExecutor
          ? { run: serverOptions.subagentParallelExecutor }
          : undefined,
      ),
      // 功能4第二刀: 银行对账批跑（N 个账户并行派发）
      createRunBankReconBatchTool(
        sdk,
        outputDir,
        traceId,
        conversationId,
        onSubagentEvent,
        serverOptions?.subagentParallelExecutor
          ? { run: serverOptions.subagentParallelExecutor }
          : undefined,
      ),
      // WP15: 撤销最近 agent 写操作（high 风险，confirm gate 拦截）
      createUndoLastWriteTool(sdk),
      // D2·刀8: 越权转交卡（safe，ALLOWED_TOOLS 静默放行）
    createProposeTransferTool(sdk, conversationId),
  ];
}

export async function createFinanceMcpServer(
  sdk: Sdk,
  outputDir: string,
  traceId?: string,
  conversationId?: string,
  onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void,
  serverOptions?: FinanceMcpServerOptions,
) {
  return sdk.createSdkMcpServer({
    name: "finance_worker",
    version: "0.1.0",
    tools: createFinanceWorkerTools(
      sdk,
      outputDir,
      traceId,
      conversationId,
      onSubagentEvent,
      serverOptions,
    ),
  });
}

export async function createKingdeeMcpServer(sdk: Sdk, outputDir?: string) {
  return sdk.createSdkMcpServer({
    name: "kingdee_worker",
    version: "0.1.0",
    tools: createKingdeeTools(sdk, outputDir),
  });
}

/**
 * Builds the complete production finance catalog without binding it to MCP or
 * Pi. Existing factories and handlers are executed once against a collector;
 * runtime adapters consume the resulting definitions.
 */
export function buildFinanceToolDefinitions(
  outputDir: string,
  traceId?: string,
  conversationId?: string,
  onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void,
  serverOptions?: FinanceMcpServerOptions,
): FinanceToolDefinition[] {
  const finance = createFinanceToolCollector("finance_worker");
  createFinanceWorkerTools(
    finance.sdk,
    outputDir,
    traceId,
    conversationId,
    onSubagentEvent,
    serverOptions,
  );

  const kingdee = createFinanceToolCollector("kingdee_worker");
  createKingdeeTools(kingdee.sdk, outputDir);
  return [...finance.definitions, ...kingdee.definitions];
}

export async function buildFinanceMcpServers(
  sdk: Sdk,
  outputDir: string,
  traceId?: string,
  conversationId?: string,
  onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void,
  serverOptions?: FinanceMcpServerOptions,
) {
  return {
    finance_worker: await createFinanceMcpServer(
      sdk,
      outputDir,
      traceId,
      conversationId,
      onSubagentEvent,
      serverOptions,
    ),
    kingdee_worker: await createKingdeeMcpServer(sdk, outputDir),
  };
}
