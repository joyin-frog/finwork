import { createRunPythonTool } from "./run-python";
import { createSpawnSubagentTool } from "./subagent";
import { createRememberConventionTool } from "./conventions";
import { createRecordBusinessMetricsTool } from "./business-metrics";
import { createBusinessAnalysisTool } from "./business-analysis-tool";
import { createSearchKnowledgeTool, createQueryKnowledgeTool, createReadFileTool } from "./knowledge";
import { createReadDocumentTool } from "./read-document";
import { createScanSlipFolderTool } from "./scan-slip-folder";
import { createKingdeeTools } from "./kingdee-tools";
import { createFinanceTools } from "./finance-tools";
import { createPayrollTools } from "../tools/finance/payroll";
import { createReimbursementTools } from "../tools/finance/reimbursement";
import { createReconciliationTools } from "../tools/finance/reconciliation";
import { createRecordDocumentMetadataTool } from "./document-metadata";
import { createUpdateCompanyProfileTool } from "./profile";
import { createFinalizeDeliverableTool } from "./finalize-deliverable";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike & { createSdkMcpServer: NonNullable<SdkLike["createSdkMcpServer"]> };

export async function createFinanceMcpServer(sdk: Sdk, outputDir: string, traceId?: string, conversationId?: string) {
  return sdk.createSdkMcpServer({
    name: "finance_worker",
    version: "0.1.0",
    tools: [
      createRunPythonTool(sdk, outputDir, traceId),
      createSpawnSubagentTool(sdk, outputDir, traceId, conversationId),
      createSearchKnowledgeTool(sdk),
      createQueryKnowledgeTool(sdk),
      createReadFileTool(sdk),
      createReadDocumentTool(sdk),
      createScanSlipFolderTool(sdk),
      createRememberConventionTool(sdk),
      createRecordBusinessMetricsTool(sdk),
      createBusinessAnalysisTool(sdk),
      ...createPayrollTools(sdk),
      ...createReimbursementTools(sdk),
      ...createReconciliationTools(sdk),
      ...createFinanceTools(sdk, outputDir),
      createRecordDocumentMetadataTool(sdk),
      // P3: 公司画像
      createUpdateCompanyProfileTool(sdk),
      // 收尾声明最终产物 → 成功收尾时清掉本回合未声明的中间/试错文件
      createFinalizeDeliverableTool(sdk, outputDir),
    ],
  });
}

export async function createKingdeeMcpServer(sdk: Sdk) {
  return sdk.createSdkMcpServer({
    name: "kingdee_worker",
    version: "0.1.0",
    tools: createKingdeeTools(sdk),
  });
}

export async function buildFinanceMcpServers(
  sdk: Sdk,
  outputDir: string,
  traceId?: string,
  conversationId?: string,
) {
  return {
    finance_worker: await createFinanceMcpServer(sdk, outputDir, traceId, conversationId),
    kingdee_worker: await createKingdeeMcpServer(sdk),
  };
}
