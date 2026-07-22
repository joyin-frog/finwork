/**
 * CR-R1：Query Pipeline 在 Router 之后的真实模型接线。
 * 只调用 resolveExecutionModel，不复制槽位规则。
 */

import { isEnabled } from "@/lib/runtime/flags";
import {
  modelConfigFromSettings,
  resolveExecutionModel,
  type LegacyModelFields,
  type ResolvedModel,
} from "@/lib/settings/model-config";
import { normalizeTier } from "@/lib/agent/router";

export type RouterPathForModel = "cheap" | "main" | "fallback";

export type ResolveRunModelInput = {
  settings: LegacyModelFields;
  /** 用户显式档位（深度思考）；缺省按 fast */
  modelTier?: string;
  routerPath: RouterPathForModel;
  routerIntent?: string;
  /** 专员会话 → purpose=specialist */
  sessionRoleId?: string | null;
  /**
   * Router 失败原因线索（error message / log why）。
   * path=fallback 时用于区分 timeout / invalid；router 关闭时忽略。
   */
  routerFailureHint?: string | null;
};

/**
 * Router 分类之后解析本次主任务模型。
 * - 专员 → mainModel
 * - router 关闭 / 超时 / 非法 → mainModel + fallbackReason
 * - complex_workflow（含 fast 档）→ mainModel
 * - 其余按档位：reasoning→main，fast→router
 */
export function resolveRunExecutionModel(input: ResolveRunModelInput): ResolvedModel | null {
  const config = modelConfigFromSettings(input.settings);
  if (!config) return null;

  if (input.sessionRoleId) {
    return resolveExecutionModel({ config, purpose: "specialist" });
  }

  if (!isEnabled("ROUTER_ENABLED")) {
    return resolveExecutionModel({
      config,
      purpose: "router_fallback",
      fallbackReason: "router_disabled",
    });
  }

  if (input.routerPath === "fallback") {
    return resolveExecutionModel({
      config,
      purpose: "router_fallback",
      fallbackReason: inferRouterFallbackReason(input.routerFailureHint),
    });
  }

  return resolveExecutionModel({
    config,
    purpose: "task",
    intent: input.routerIntent,
    tier: normalizeTier(input.modelTier),
  });
}

export function inferRouterFallbackReason(
  hint?: string | null,
): "router_timeout" | "router_invalid" | "router_disabled" {
  const h = (hint ?? "").toLowerCase();
  if (!h) return "router_invalid";
  if (h.includes("timeout") || h.includes("abort") || h.includes("timed out")) {
    return "router_timeout";
  }
  if (h.includes("disabled") || h.includes("router disabled")) {
    return "router_disabled";
  }
  return "router_invalid";
}
