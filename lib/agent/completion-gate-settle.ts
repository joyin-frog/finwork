/**
 * CR-R2：成功收口前用 CompletionGate 决定是否真能标 completed。
 * 不写 Run 状态本身（由 settle / appendDurableRunEvent 写）；只给出决策。
 */

import {
  completionGateSatisfied,
  type QualityStatus,
  type DeliverySpec,
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
      failureClass: "business" | "environment" | "tool" | "version";
      repairableByModel: boolean;
      failureCodes: string[];
    };

/**
 * 无 requiredDeliverables → completed + not_applicable。
 * 有要求且 gate 通过 → completed + passed。
 * 有要求且未通过 → error + failed + validation_failed（不得伪装成成功）。
 */
export function decideSettleFromCompletionGate(
  runId: string,
  contract: DeliverySpec | null | undefined,
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
    const failureCodes: string[] = [];
    const details = contract.requiredDeliverables.flatMap((required) => {
      const attempts = records
        .filter((record) => record.contractDeliverableId === required.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latest = attempts[0];
      if (!latest) return [`${required.id}: 尚未声明候选文件`];
      const issues = validationIssues(latest.validationReportJson);
      failureCodes.push(...issues.map((issue) => issue.code));
      return [
        `${required.id}: ${latest.fileName}，状态=${latest.status}` +
          (issues.length ? `，问题=${issues.map((issue) => issue.text).join("; ")}` : ""),
      ];
    });
    const failureClass = classifyCompletionFailure(failureCodes);
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
      terminationReason:
        failureClass === "environment" ? "dependency_missing"
          : failureClass === "version" ? "session_stale"
            : failureClass === "tool" ? "tool_error"
              : "validation_failed",
      gateMessage: [
        `交付验证未通过，缺少: ${gate.missing.join(", ")}`,
        ...details,
      ].join("\n"),
      diagnosticFingerprint: fingerprint,
      failureClass,
      repairableByModel: failureClass === "business",
      failureCodes: [...new Set(failureCodes)].sort(),
    };
  } catch {
    return {
      outcome: "error",
      qualityStatus: "unverified",
      terminationReason: "tool_error",
      gateMessage: "交付验证未能完成（无法读取证据）",
      diagnosticFingerprint: "completion-evidence-unreadable",
      failureClass: "tool",
      repairableByModel: false,
      failureCodes: ["completion_evidence_unreadable"],
    };
  }
}

function validationIssues(reportJson: string | null): Array<{ code: string; text: string }> {
  if (!reportJson) return [];
  try {
    const parsed = JSON.parse(reportJson) as {
      errors?: Array<{ code?: unknown; message?: unknown; location?: unknown }>;
    };
    return (parsed.errors ?? []).slice(0, 20).map((issue) => {
      const code = typeof issue.code === "string" ? issue.code : "validation_error";
      const message = typeof issue.message === "string" ? issue.message : "";
      const location = typeof issue.location === "string" ? `@${issue.location}` : "";
      return { code, text: `${code}${location}: ${message}` };
    });
  } catch {
    return [{ code: "validation_report_invalid", text: "validation_report_invalid: 无法解析验证报告" }];
  }
}

export function classifyCompletionFailure(
  codes: readonly string[],
): "business" | "environment" | "tool" | "version" {
  const normalized = codes.map((code) => code.toLowerCase());
  if (normalized.some((code) => code === "stale_base_version" || code.includes("version_stale"))) return "version";
  if (normalized.some((code) =>
    code.includes("unavailable")
    || code.includes("dependency")
    || code.includes("python_missing")
    || code.includes("probe_failed")
  )) return "environment";
  if (normalized.some((code) =>
    code.includes("commit_failed")
    || code.includes("parser_open_failed")
    || code.includes("validation_report_invalid")
    || code.includes("artifact_diff_failed")
    || code.includes("runtime_error")
  )) return "tool";
  return "business";
}
