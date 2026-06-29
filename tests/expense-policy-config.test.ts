import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { initializeFinanceDatabase, openFinanceDatabase, setAppSetting } from "../lib/db/sqlite.ts";
import { createFinanceTools } from "../lib/agent/mcp-tools/finance-tools.ts";

// WP4 / AC4.2: 报销制度文件路径可配置。本(公开)仓库不内置示例制度文件,故未导入贵司制度时
// 不静默成功,而是显式给出导入指引并标 isError;导入贵司制度后读真实内容、不再有示例提示。
// 直接构造并调用 read_expense_policy handler(行为测试,非源码匹配)。
export const expensePolicyConfigTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-policy-test-"));
  const dbPath = path.join(dir, "test.db");
  const origDb = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;

  // 捕获 sdk.tool 注册的 handler
  const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = {
    tool: (name: string, _desc: string, _schema: unknown, handler: (args: unknown) => unknown) => {
      handlers.set(name, handler as never);
      return { name };
    }
  };

  try {
    initializeFinanceDatabase(openFinanceDatabase(dbPath));
    createFinanceTools(mockSdk, dir);
    const readPolicy = handlers.get("read_expense_policy");
    assert.ok(readPolicy, "AC4.2 FAIL: read_expense_policy 未注册");

    // 默认(未导入贵司制度,且本仓库不内置示例制度文件)→ 不静默成功,显式给出导入指引并标 isError
    const def = await readPolicy!({ section: "全部" });
    const defText = def.content.map((c) => c.text).join("");
    assert.ok(def.isError === true, "AC4.2 FAIL: 缺省未导入制度时应标记 isError");
    assert.ok(defText.includes("尚未导入") && defText.includes("制度"), "AC4.2 FAIL: 缺省应提示导入贵司报销制度");

    // 导入贵司制度后 → 用配置文件内容,且不再有示例提示、不标 isError
    const companyPolicy = path.join(dir, "我司报销制度.txt");
    writeFileSync(companyPolicy, "第一条 差旅住宿每晚不超过 600 元。", "utf-8");
    setAppSetting("expense_policy_path", companyPolicy);
    const real = await readPolicy!({ section: "全部" });
    const realText = real.content.map((c) => c.text).join("");
    assert.ok(realText.includes("每晚不超过 600 元"), "AC4.2 FAIL: 应读配置的贵司制度内容");
    assert.ok(!realText.includes("示例报销制度"), "AC4.2 FAIL: 已导入贵司制度后不应再提示示例");
    assert.ok(!real.isError, "AC4.2 FAIL: 正常读取贵司制度不应标 isError");

    // 配置路径指向不存在的文件 → 同样不静默失败,给出导入指引并标 isError
    setAppSetting("expense_policy_path", path.join(dir, "不存在.txt"));
    const fallback = await readPolicy!({ section: "全部" });
    const fbText = fallback.content.map((c) => c.text).join("");
    assert.ok(fallback.isError === true, "AC4.2 FAIL: 配置文件不存在时应标 isError");
    assert.ok(fbText.includes("尚未导入") || fbText.includes("不存在"), "AC4.2 FAIL: 配置文件不存在时应给出导入指引");

    console.log("expense-policy-config: all checks passed ✓");
  } finally {
    if (origDb === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = origDb;
    rmSync(dir, { recursive: true, force: true });
  }
})();
