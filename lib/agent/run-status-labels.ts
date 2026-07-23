/**
 * CR-R2：Run / 终止原因 → 用户可读文案（UI 横幅与侧栏共用）。
 */

import type { QualityStatus, RunStatus, TerminationReason } from "@/lib/agent/run-contract";
import type { AttachmentQualityState } from "@/lib/deliverable/types";

export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "正在执行";
    case "waiting_user":
      return "等待确认";
    case "waiting_dependency":
      return "等待安装依赖";
    case "paused":
      return "已暂停，可恢复";
    case "completed":
      return "已完成";
    case "failed":
      return "系统错误";
    case "canceled":
      return "用户已停止";
    default:
      return status;
  }
}

export function terminationReasonLabel(reason: TerminationReason | null | undefined): string | null {
  if (!reason) return null;
  switch (reason) {
    case "user_stop":
      return "你已停止本任务";
    case "budget_exhausted":
      return "已用尽本轮预算，可恢复继续";
    case "idle_timeout":
      return "长时间无进展，已暂停";
    case "hard_timeout":
      return "超过最长执行时间，已暂停";
    case "permission_denied":
      return "权限被拒绝";
    case "permission_expired":
      return "权限已过期";
    case "dependency_missing":
      return "缺少运行依赖";
    case "validation_failed":
      return "交付验证失败，可修复后继续";
    case "model_auth":
      return "模型鉴权失败";
    case "model_not_found":
      return "模型不可用";
    case "rate_limited":
      return "模型限流";
    case "network_error":
      return "网络错误";
    case "tool_error":
      return "工具执行失败";
    case "process_crash":
      return "进程异常中断，可恢复现场";
    case "session_stale":
      return "会话已失效，需重建后续跑";
    case "sdk_error":
      return "运行时错误";
    default:
      return reason;
  }
}

export function qualityStatusLabel(quality: QualityStatus | null | undefined): string | null {
  if (!quality || quality === "not_applicable") return null;
  switch (quality) {
    case "passed":
      return "质量检查通过";
    case "failed":
      return "质量检查未通过";
    case "unverified":
      return "交付物尚未验证";
    default:
      return null;
  }
}

export function attachmentQualityLabel(state: AttachmentQualityState): string {
  switch (state) {
    case "working_unverified":
      return "未验证工作文件";
    case "validating":
      return "验证中";
    case "validation_failed":
      return "验证失败";
    case "delivered":
      return "已验证交付";
    default:
      return state;
  }
}

/** 文件任务：仅有旧 done 帧、无质量通过证据时，不得显示为成功完成。 */
export function canShowFileTaskSuccess(input: {
  runStatus?: RunStatus | null;
  qualityStatus?: QualityStatus | null;
  hasRequiredDeliverables: boolean;
}): boolean {
  if (!input.hasRequiredDeliverables) {
    return input.runStatus == null || input.runStatus === "completed";
  }
  return input.runStatus === "completed" && input.qualityStatus === "passed";
}
