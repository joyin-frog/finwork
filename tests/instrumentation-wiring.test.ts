import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 启动维护的接线校验:purgeStaleOutputDirs / purgeOldServerLogs 必须在 instrumentation.register
// 里被调用(此前 purgeStaleOutputDirs 定义了却无调用方 → tmpdir 输出目录无限积累)。
// 真跑 register() 会初始化 sqlite 单例污染其它测试,故按 ci-workflow.test.ts 先例做源码断言;
// 两个函数自身的行为分别由 cleanup.test.ts / server-log.test.ts 功能测试覆盖。
export const instrumentationWiringTestPromise = (async () => {
  const src = readFileSync("instrumentation.ts", "utf-8");

  assert.ok(src.includes("purgeStaleOutputDirs()"), "register 应调用 purgeStaleOutputDirs(清理陈旧输出目录)");
  assert.ok(src.includes("purgeOldServerLogs()"), "register 应调用 purgeOldServerLogs(清理过期 server-*.log)");

  console.log("instrumentation-wiring: all checks passed ✓");
})();
