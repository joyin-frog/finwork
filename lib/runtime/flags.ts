/**
 * Feature flags for gradual rollout.
 * Values are read from app_settings table at startup, with these defaults.
 * Each flag can be toggled in the settings UI (advanced mode).
 */

const DEFAULTS: Record<string, boolean> = {
  PROMPT_CACHE_ENABLED: true,              // [wired] lib/agent/claude-adapter.ts:203
  ROUTER_ENABLED: true,                    // [wired] app/api/agent/query/route.ts:102
  RAG_RERANK_ENABLED: true,               // [defined, not wired] — feature not implemented
  MEMORY_AUTO_EXTRACT_ENABLED: true,      // [defined, not wired] — feature not implemented
  TOOL_IDEMPOTENCY_ENABLED: true,         // [defined, not wired] — feature not implemented
  SDK_RETRY_ENABLED: true,                // [defined, not wired] — feature not implemented
  SESSION_LIVENESS_CHECK_ENABLED: true,   // [wired] app/api/agent/query/route.ts:84
};

let _flags: Record<string, boolean> = { ...DEFAULTS };

export function initFlags(dbOverrides?: Record<string, boolean>): void {
  _flags = { ...DEFAULTS, ...dbOverrides };
}

export function loadFlags(overrides?: Record<string, boolean>): void {
  _flags = { ...DEFAULTS, ...overrides };
}

export function isEnabled(flag: string): boolean {
  return _flags[flag] ?? false;
}

export function allFlags(): Record<string, boolean> {
  return { ..._flags };
}
