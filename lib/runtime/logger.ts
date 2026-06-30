import { redact } from "@/lib/safety/pii";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

export type ScopedLogger = {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
};

const MAX_COLLECTION_ITEMS = 100;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const value = process.env.FINANCE_AGENT_LOG_LEVEL?.toLowerCase();
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

function sanitize(value: unknown, ancestors: WeakSet<object>, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    const redacted = redact(String(value));
    return redacted === String(value) ? value : redacted;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return redact(String(value));
  }
  if (value === undefined) return "[undefined]";
  if (depth >= 8) return "[MaxDepth]";
  if (typeof value !== "object") return redact(String(value));
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);

  try {
  if (value instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: redact(value.name),
      message: redact(value.message),
      stack: value.stack ? redact(value.stack) : undefined,
    };
    if (value.cause !== undefined) serialized.cause = sanitize(value.cause, ancestors, depth + 1);
    return serialized;
  }

  if (Array.isArray(value)) {
    const serialized = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => sanitize(item, ancestors, depth + 1));
    if (value.length > MAX_COLLECTION_ITEMS) serialized.push(`[Truncated ${value.length - MAX_COLLECTION_ITEMS} items]`);
    return serialized;
  }

  const serialized: Record<string, unknown> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_COLLECTION_ITEMS)) {
    try {
      serialized[key] = sanitize((value as Record<string, unknown>)[key], ancestors, depth + 1);
    } catch {
      serialized[key] = "[Unserializable]";
    }
  }
  if (keys.length > MAX_COLLECTION_ITEMS) {
    serialized["[Truncated]"] = `${keys.length - MAX_COLLECTION_ITEMS} properties`;
  }
  return serialized;
  } finally {
    ancestors.delete(value);
  }
}

export function formatLogEntry(
  level: LogLevel,
  scope: string,
  message: string,
  context?: LogContext,
): string {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    scope: redact(scope),
    message: redact(message),
  };
  const bootId = process.env.FINANCE_AGENT_BOOT_ID;
  if (bootId) entry.bootId = redact(bootId);
  try {
    if (context && Object.keys(context).length > 0) {
      entry.context = sanitize(context, new WeakSet<object>());
    }
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({
      timestamp: entry.timestamp,
      level,
      scope: entry.scope,
      message: entry.message,
      ...(entry.bootId ? { bootId: entry.bootId } : {}),
      context: "[Unserializable]",
    });
  }
}

function write(level: LogLevel, scope: string, message: string, context?: LogContext): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[configuredLevel()]) return;
  console[level](formatLogEntry(level, scope, message, context));
}

export function createLogger(scope: string): ScopedLogger {
  return {
    debug: (message, context) => write("debug", scope, message, context),
    info: (message, context) => write("info", scope, message, context),
    warn: (message, context) => write("warn", scope, message, context),
    error: (message, context) => write("error", scope, message, context),
  };
}
