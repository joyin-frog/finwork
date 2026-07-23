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
    }
  | {
      outcome: "error";
      qualityStatus: QualityStatus;
      terminationReason: TerminationReason;
      gateMessage: string;
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
    return {
      outcome: "error",
      qualityStatus: "failed",
      terminationReason: "validation_failed",
      gateMessage: `交付验证未通过，缺少: ${gate.missing.join(", ")}`,
    };
  } catch {
    return {
      outcome: "error",
      qualityStatus: "unverified",
      terminationReason: "validation_failed",
      gateMessage: "交付验证未能完成（无法读取证据）",
    };
  }
}
