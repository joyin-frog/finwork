import assert from "node:assert/strict";
import { createLogger } from "../lib/runtime/logger.ts";

export const loggerTestPromise = (async () => {
  const originalLevel = process.env.FINANCE_AGENT_LOG_LEVEL;
  const originalBootId = process.env.FINANCE_AGENT_BOOT_ID;
  const originalConsole = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const output: Record<"debug" | "info" | "warn" | "error", string[]> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };

  console.debug = (...args: unknown[]) => output.debug.push(args.join(" "));
  console.info = (...args: unknown[]) => output.info.push(args.join(" "));
  console.warn = (...args: unknown[]) => output.warn.push(args.join(" "));
  console.error = (...args: unknown[]) => output.error.push(args.join(" "));

  try {
    process.env.FINANCE_AGENT_LOG_LEVEL = "info";
    process.env.FINANCE_AGENT_BOOT_ID = "boot-test";
    const logger = createLogger("logger-test");

    logger.debug("hidden");
    assert.equal(output.debug.length, 0, "info level should filter debug logs");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.info("contact user@example.com", {
      traceId: "trace-test",
      nested: { phone: "13812345678" },
      error: new Error("failed for owner@example.com"),
      circular,
    });

    const info = JSON.parse(output.info[0]) as {
      timestamp: string;
      level: string;
      scope: string;
      message: string;
      bootId: string;
      context: {
        traceId: string;
        nested: { phone: string };
        error: { name: string; message: string; stack: string };
        circular: { self: string };
      };
    };
    assert.ok(!Number.isNaN(Date.parse(info.timestamp)), "timestamp should be ISO-8601");
    assert.equal(info.level, "info");
    assert.equal(info.scope, "logger-test");
    assert.equal(info.bootId, "boot-test");
    assert.equal(info.context.traceId, "trace-test");
    assert.equal(info.message, "contact [已脱敏:邮箱]");
    assert.equal(info.context.nested.phone, "[已脱敏:手机号]");
    assert.equal(info.context.error.name, "Error");
    assert.equal(info.context.error.message, "failed for [已脱敏:邮箱]");
    assert.ok(info.context.error.stack.includes("[已脱敏:邮箱]"), "error stack should be redacted");
    assert.equal(info.context.circular.self, "[Circular]", "circular context should serialize safely");

    const shared = { email: "shared@example.com" };
    logger.info("bounded", {
      first: shared,
      second: shared,
      metric: 42,
      numericPhone: 13812345678,
      many: Array.from({ length: 105 }, (_, index) => index),
      wide: Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`key${index}`, index])),
    });
    const bounded = JSON.parse(output.info[1]).context as {
      first: { email: string };
      second: { email: string };
      metric: number;
      numericPhone: string;
      many: unknown[];
      wide: Record<string, unknown>;
    };
    assert.deepEqual(bounded.first, bounded.second, "repeated siblings are not circular");
    assert.equal(bounded.first.email, "[已脱敏:邮箱]");
    assert.equal(bounded.metric, 42, "structured numeric metrics remain numbers");
    assert.equal(bounded.numericPhone, "[已脱敏:手机号]", "numeric PII is redacted");
    assert.equal(bounded.many.length, 101, "arrays are conservatively capped with a marker");
    assert.equal(bounded.many[100], "[Truncated 5 items]");
    assert.equal(Object.keys(bounded.wide).length, 101, "object breadth is conservatively capped");
    assert.equal(bounded.wide["[Truncated]"], "5 properties");

    process.env.FINANCE_AGENT_LOG_LEVEL = "error";
    logger.warn("filtered");
    logger.error("kept", { traceId: "trace-test" });
    assert.equal(output.warn.length, 0, "error level should filter warnings");
    assert.equal(JSON.parse(output.error[0]).level, "error");
  } finally {
    console.debug = originalConsole.debug;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    if (originalLevel === undefined) delete process.env.FINANCE_AGENT_LOG_LEVEL;
    else process.env.FINANCE_AGENT_LOG_LEVEL = originalLevel;
    if (originalBootId === undefined) delete process.env.FINANCE_AGENT_BOOT_ID;
    else process.env.FINANCE_AGENT_BOOT_ID = originalBootId;
  }

  console.log("logger: all checks passed ✓");
})();
