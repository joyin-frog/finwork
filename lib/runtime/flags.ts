/**
 * Feature flags for gradual rollout.
 * 优先级:环境变量 FINANCE_AGENT_FLAG_<NAME> > app_settings 表 `flag:<NAME>` 行(懒加载) > 默认值。
 */

import { getAppSetting } from "@/lib/db/sqlite";

const DEFAULTS: Record<string, boolean> = {
  PROMPT_CACHE_ENABLED: true,              // [wired] lib/agent/claude-adapter.ts:203
  ROUTER_ENABLED: true,                    // [wired] app/api/agent/query/route.ts:102
  SESSION_LIVENESS_CHECK_ENABLED: true,   // [wired] app/api/agent/query/route.ts:84
  USAGE_LIMIT_ENABLED: true,              // [wired] app/api/agent/query/route.ts — 用量配额拦截(默认开)
};

let _flags: Record<string, boolean> = { ...DEFAULTS };
let _dbLoaded = false;

export function initFlags(dbOverrides?: Record<string, boolean>): void {
  _flags = { ...DEFAULTS, ...dbOverrides };
  _dbLoaded = true;
}

export function loadFlags(overrides?: Record<string, boolean>): void {
  _flags = { ...DEFAULTS, ...overrides };
  _dbLoaded = true;
}

function parseFlagValue(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on") return true;
  if (v === "0" || v === "false" || v === "off") return false;
  return undefined;
}

/** 首次访问时从 app_settings 懒加载覆盖(key = `flag:<NAME>`,值 0/1);DB 不可用则静默用默认。 */
function ensureDbOverridesLoaded(): void {
  if (_dbLoaded) return;
  _dbLoaded = true;
  try {
    for (const name of Object.keys(DEFAULTS)) {
      const parsed = parseFlagValue(getAppSetting(`flag:${name}`));
      if (parsed !== undefined) _flags[name] = parsed;
    }
  } catch { /* 启动早期/测试环境 DB 未就绪:保持默认 */ }
}

export function isEnabled(flag: string): boolean {
  // 环境变量最高优先(FINANCE_AGENT_FLAG_<NAME>),便于打包态/测试临时切换
  const envOverride = parseFlagValue(process.env[`FINANCE_AGENT_FLAG_${flag}`]);
  if (envOverride !== undefined) return envOverride;
  ensureDbOverridesLoaded();
  return _flags[flag] ?? false;
}

export function allFlags(): Record<string, boolean> {
  ensureDbOverridesLoaded();
  return { ..._flags };
}

/** 仅测试用:重置懒加载状态,让下一次 isEnabled 重新读 DB。 */
export function _resetFlagsForTest(): void {
  _flags = { ...DEFAULTS };
  _dbLoaded = false;
}
