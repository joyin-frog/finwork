/**
 * CR-R2：成功收口前用 CompletionGate 决定是否真能标 completed。
 * 不写 Run 状态本身（由 settle / appendDurableRunEvent 写）；只给出决策。
 */

import {
  completionGateSatisfied,
  type QualityStatus,
  type TaskContract,
  type TerminationReason,
} from "@/lib/agent/run-contract";
import { SqliteDeliverableStore } from "@/lib/deliverable/store";
import { getDb } from "@/lib/db/sqlite";

export type SettleDecision =
  | {
      outcome: "completed";
      qualityStatus: QualityStatus;
      terminationReason?: undefined;
      gateMessage?: undefined;
      diagnosticFingerprint?: undefined;
    }
  | {
      outcome: "error";
      qualityStatus: QualityStatus;
      terminationReason: TerminationReason;
      gateMessage: string;
      diagnosticFingerprint: string;
    };

/**
 * 无 requiredDeliverables → completed + not_applicable。
 * 有要求且 gate 通过 → completed + passed。
 * 有要求且未通过 → error + failed + validation_failed（不得伪装成成功）。
 */
export function decideSettleFromCompletionGate(
  runId: string,
  contract: TaskContract | null | undefined,
): SettleDecision {
  if (!contract || contract.requiredDeliverables.length === 0) {
    return { outcome: "completed", qualityStatus: "not_applicable" };
  }

  try {
    const store = new SqliteDeliverableStore(getDb());
    const evidences = store.list(runId);
    const gate = completionGateSatisfied(contract, evidences);
    if (gate.ok) {
      return { outcome: "completed", qualityStatus: "passed" };
    }
    const records = store.listByRun(runId);
    const details = contract.requiredDeliverables.flatMap((required) => {
      const attempts = records
        .filter((record) => record.contractDeliverableId === required.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latest = attempts[0];
      if (!latest) return [`${required.id}: 尚未声明候选文件`];
      const issues = validationIssues(latest.validationReportJson);
      return [
        `${required.id}: ${latest.fileName}，状态=${latest.status}` +
          (issues.length ? `，问题=${issues.join("; ")}` : ""),
      ];
    });
    const fingerprint = [
      `missing=${gate.missing.slice().sort().join(",")}`,
      ...records
        .map((record) =>
          `${record.contractDeliverableId}:${record.status}:${record.workingSha256 ?? "no-hash"}`
        )
        .sort(),
    ].join("|");
    return {
      outcome: "error",
      qualityStatus: "failed",
      terminationReason: "validation_failed",
      gateMessage: [
        `交付验证未通过，缺少: ${gate.missing.join(", ")}`,
        ...details,
      ].join("\n"),
      diagnosticFingerprint: fingerprint,
    };
  } catch {
    return {
      outcome: "error",
      qualityStatus: "unverified",
      terminationReason: "validation_failed",
      gateMessage: "交付验证未能完成（无法读取证据）",
      diagnosticFingerprint: "completion-evidence-unreadable",
    };
  }
}

function validationIssues(reportJson: string | null): string[] {
  if (!reportJson) return [];
  try {
    const parsed = JSON.parse(reportJson) as {
      errors?: Array<{ code?: unknown; message?: unknown; location?: unknown }>;
    };
    return (parsed.errors ?? []).slice(0, 5).map((issue) => {
      const code = typeof issue.code === "string" ? issue.code : "validation_error";
      const message = typeof issue.message === "string" ? issue.message : "";
      const location = typeof issue.location === "string" ? `@${issue.location}` : "";
      return `${code}${location}: ${message}`;
    });
  } catch {
    return ["validation_report_invalid: 无法解析验证报告"];
  }
}
