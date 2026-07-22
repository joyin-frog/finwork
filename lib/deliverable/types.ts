/**
 * CR-Q1：交付物质量门类型与 UI 数据合同。
 * CompletionEvidence / TaskContract 从 run-contract 导入，不复制。
 */

import type { CompletionEvidence, QualityProfile, TaskContract } from "@/lib/agent/run-contract";

export type DeliverableStatus =
  | "working"
  | "candidate"
  | "validating"
  | "validated"
  | "delivered"
  | "validation_failed";

/** UI / 组件可消费的附件态（CR-R2 接权威完成态；本包只提供合同）。 */
export type AttachmentQualityState =
  | "working_unverified"
  | "validating"
  | "validation_failed"
  | "delivered";

export type FinalizeFile = {
  name: string;
  contractDeliverableId: string;
};

export type ValidatorIssue = {
  code: string;
  message: string;
  location?: string;
};

export type ValidatorResult = {
  status: "passed" | "failed";
  validatorId: string;
  fileSha256: string;
  errors: ValidatorIssue[];
  warnings: ValidatorIssue[];
  evidence: Record<string, unknown>;
};

export type DeliverableRecord = {
  id: string;
  runId: string;
  contractDeliverableId: string;
  workingPath: string | null;
  deliveredPath: string | null;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  workingSha256: string | null;
  deliveredSha256: string | null;
  validatorId: string | null;
  qualityProfile: QualityProfile | null;
  validationReportJson: string | null;
  status: DeliverableStatus;
  createdAt: string;
  validatedAt: string | null;
  deliveredAt: string | null;
};

export type FinalizeContext = {
  runId: string;
  outputDir: string;
  /** 会话文件根（含 generate/ delivered/）；缺省则由 outputDir 推导。 */
  conversationFilesDir?: string;
  taskContract: TaskContract;
  /** 可选：正式附件挂到该 assistant message；缺省则只写 registry/evidence。 */
  messageId?: number;
  conversationId?: number;
};

export type FinalizeSuccess = {
  ok: true;
  finalized: Array<{
    name: string;
    contractDeliverableId: string;
    deliveredPath: string;
    deliveredSha256: string;
    status: "delivered";
  }>;
  evidences: CompletionEvidence[];
  gate: { ok: true } | { ok: false; missing: string[] };
  /** 供 cleanupUnfinalizedFiles 使用的 basename 列表 */
  declaredNames: string[];
};

export type FinalizeFailure = {
  ok: false;
  error: string;
  code: string;
  failures?: Array<{
    name: string;
    contractDeliverableId: string;
    errors: ValidatorIssue[];
    workingPath?: string;
  }>;
};

export type FinalizeResult = FinalizeSuccess | FinalizeFailure;

export function attachmentStateFromStatus(status: DeliverableStatus): AttachmentQualityState {
  switch (status) {
    case "validating":
      return "validating";
    case "validation_failed":
      return "validation_failed";
    case "validated":
    case "delivered":
      return "delivered";
    default:
      return "working_unverified";
  }
}
