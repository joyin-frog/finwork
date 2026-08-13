import type { CapabilityFailure } from "./contracts";

const FAILURE_MESSAGES: Readonly<Record<CapabilityFailure["kind"], string>> = {
  invalid_input: "输入内容不符合该能力的要求，请检查后重试。",
  capability_missing: "当前缺少完成这项任务所需的能力，系统不会用较弱方案替代。",
  dependency_unavailable: "所需服务暂时不可用，任务已安全停止。",
  permission_denied: "当前账号没有执行该操作的权限。",
  policy_blocked: "该操作被安全策略阻止。",
  resource_exhausted: "本次任务已达到资源上限，当前进度已保留。",
  transient_external_failure: "外部服务暂时异常，可以稍后从当前进度继续。",
  deterministic_validation_failed: "结果没有通过确定性校验，尚未交付。",
  human_decision_required: "继续执行前需要你的确认。",
  canceled: "任务已取消。",
  internal_error: "执行过程中发生内部错误，当前进度已安全保留。",
};

export function capabilityFailureMessage(failure: CapabilityFailure): string {
  return FAILURE_MESSAGES[failure.kind];
}
