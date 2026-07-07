import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// flags 的 DB/env 覆盖机制 + 路由器关闭时本地问候直答仍在
export const flagsDbOverrideTestPromise = (async () => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "flags-test-"));
  process.env.FINANCE_AGENT_APP_DATA_DIR = baseDir;
  process.env.FINANCE_AGENT_DB_PATH = path.join(baseDir, "flags.db");
  delete process.env.FINANCE_AGENT_FLAG_ROUTER_ENABLED;

  const { openFinanceDatabase, initializeFinanceDatabase, setAppSetting, deleteAppSetting } =
    await import("../lib/db/sqlite.ts");
  initializeFinanceDatabase(openFinanceDatabase(process.env.FINANCE_AGENT_DB_PATH));

  const { isEnabled, _resetFlagsForTest } = await import("../lib/runtime/flags.ts");

  // F1: 默认值 — 无覆盖时 ROUTER_ENABLED=true
  _resetFlagsForTest();
  assert.equal(isEnabled("ROUTER_ENABLED"), true, "F1 FAIL: 默认应为 true");

  // F2: DB 行覆盖 flag:ROUTER_ENABLED=0 → false
  setAppSetting("flag:ROUTER_ENABLED", "0");
  _resetFlagsForTest();
  assert.equal(isEnabled("ROUTER_ENABLED"), false, "F2 FAIL: DB 覆盖 0 应为 false");

  // F3: 删除行恢复默认
  deleteAppSetting("flag:ROUTER_ENABLED");
  _resetFlagsForTest();
  assert.equal(isEnabled("ROUTER_ENABLED"), true, "F3 FAIL: 删除覆盖后应回默认 true");

  // F4: 环境变量优先于 DB
  setAppSetting("flag:ROUTER_ENABLED", "1");
  process.env.FINANCE_AGENT_FLAG_ROUTER_ENABLED = "0";
  _resetFlagsForTest();
  assert.equal(isEnabled("ROUTER_ENABLED"), false, "F4 FAIL: env=0 应压过 DB=1");
  delete process.env.FINANCE_AGENT_FLAG_ROUTER_ENABLED;
  deleteAppSetting("flag:ROUTER_ENABLED");
  _resetFlagsForTest();

  // F5: 非法值忽略,回默认
  setAppSetting("flag:ROUTER_ENABLED", "banana");
  _resetFlagsForTest();
  assert.equal(isEnabled("ROUTER_ENABLED"), true, "F5 FAIL: 非法值应忽略");
  deleteAppSetting("flag:ROUTER_ENABLED");
  _resetFlagsForTest();

  // F6(源码契约): query 管线在路由器关闭分支仍接了 matchTrivialMessage 本地直答
  // WP10a 后拼接范围扩为 [route.ts, query-stages.ts]，断言字符串不变
  const routeSrc = [
    readFileSync(path.join(process.cwd(), "app/api/agent/query/route.ts"), "utf-8"),
    readFileSync(path.join(process.cwd(), "lib/agent/query-stages.ts"), "utf-8"),
  ].join("\n");
  assert.ok(
    routeSrc.includes("matchTrivialMessage(lastUserContent)"),
    "F6 FAIL: query 管线应在 ROUTER_ENABLED 关闭时走 matchTrivialMessage 本地直答"
  );

  // F7: matchTrivialMessage 问候有 directAnswer,业务消息返回 null
  const { matchTrivialMessage } = await import("../lib/agent/router.ts");
  const hi = matchTrivialMessage("你好");
  assert.ok(hi?.directAnswer, "F7 FAIL: 问候应有 directAnswer");
  assert.equal(matchTrivialMessage("帮我把这批单据做成凭证"), null, "F7 FAIL: 业务消息不应被拦");

  console.log("flags-db-override: F1-F7 全部通过 ✓");
})();
