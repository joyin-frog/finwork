/**
 * availability.ts — 角色启停（用户侧覆盖）
 *
 * 存储：app_settings key "agent_disabled_roles"（JSON 数组）
 * 审计：setRoleDisabled 落 audit_logs，event_type "agent_role_toggle"
 *
 * 契约：
 * - getDisabledRoleIds()：返回用户已停用的 roleId 数组
 * - setRoleDisabled(roleId, disabled)：设置停用/启用，返回新数组；
 *   对不存在或 available:false 的 roleId 抛错
 * - listDispatchableRoleIds()：返回 available && !userDisabled 的 roleId 数组；
 *   全部停用时兜底返回 available 全集
 */

import { ROLE_REGISTRY } from "@/lib/agent/roles/registry";
import { getAppSetting, setAppSetting, insertAuditLog } from "@/lib/db/sqlite";

const SETTINGS_KEY = "agent_disabled_roles";

export function getDisabledRoleIds(): string[] {
  try {
    const raw = getAppSetting(SETTINGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * 停用或启用一个角色。
 * - 对不存在于 ROLE_REGISTRY 的 roleId 抛错
 * - 对 available:false 的 roleId 抛错（不可配置，逻辑由注册表控制）
 * - 写 audit_logs（event_type "agent_role_toggle"）
 * @returns 新的 disabledRoleIds 数组
 */
export function setRoleDisabled(roleId: string, disabled: boolean): string[] {
  const role = ROLE_REGISTRY.find((r) => r.id === roleId);
  if (!role) {
    throw new Error(`setRoleDisabled: 未知角色 "${roleId}"，不存在于 ROLE_REGISTRY`);
  }
  if (!role.available) {
    throw new Error(
      `setRoleDisabled: 角色 "${roleId}" 的 available 为 false（注册表预留，尚未启用），不可通过用户配置启停`
    );
  }

  const current = getDisabledRoleIds();
  let updated: string[];
  if (disabled) {
    updated = current.includes(roleId) ? current : [...current, roleId];
  } else {
    updated = current.filter((id) => id !== roleId);
  }

  setAppSetting(SETTINGS_KEY, JSON.stringify(updated));

  // 写审计（红线 8：角色可用面的变化可审计）
  insertAuditLog("agent_role_toggle", { roleId, disabled, at: new Date().toISOString() });

  return updated;
}

/**
 * 返回可派发角色 id 数组（available:true && !userDisabled）。
 * 兜底：如果所有 available 角色均被停用，返回 available 全集（非空保证）。
 */
export function listDispatchableRoleIds(): string[] {
  const availableRoles = ROLE_REGISTRY.filter((r) => r.available);
  const availableIds = availableRoles.map((r) => r.id);

  const disabledSet = new Set(getDisabledRoleIds());
  const dispatchable = availableIds.filter((id) => !disabledSet.has(id));

  // 兜底：全停时返回 available 全集
  if (dispatchable.length === 0) {
    return availableIds;
  }

  return dispatchable;
}
