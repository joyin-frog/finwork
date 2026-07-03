import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect } from "./fixtures";
import { sendChat } from "./helpers";

// Tier-2:用量配额护栏(docs/spec/spec-usage-limit.md)。花钱护栏的两个方向都要守:
// - 超限必拦:任何 LLM 花费前返回 blocked,对话内提示恢复时刻(设计上是硬锁,无逃生口);
// - 限额内必放行:护栏不许误伤正常使用。
// 种子:直接往隔离 mock 库写一条超限 trace —— mock Agent 不上报 usage,无法从 UI 侧堆到超限。
// 库是 WAL + busy_timeout,跨进程写安全;用固定 trace_id,finally 里必清,不给后续用例留"全员被拦"的毒状态。

const DB_PATH = path.join(process.cwd(), ".claude", "e2e-mock", "appdata", "finance-agent.db");
const SEED_TRACE_ID = "e2e-usage-seed";
const WINDOW_KEYS = ["usage.window_start_5h", "usage.window_start_week"];

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

/** 注入成本加权后超过 5h 上限(1000 万)的 trace:未知模型归推理档、output 权重 5 → 300 万 output = 1500 万。 */
function seedOverLimit() {
  const now = Date.now();
  withDb((db) => {
    db.prepare("INSERT OR REPLACE INTO agent_traces(trace_id, started_at, model_usage_json) VALUES(?,?,?)").run(
      SEED_TRACE_ID,
      new Date(now - 60_000).toISOString(),
      JSON.stringify({ "e2e-heavy-model": { outputTokens: 3_000_000 } })
    );
    // 两窗口起点锚到 1 小时前(仍是活动窗,不会被懒重锚),让种子 trace 落进窗内
    for (const key of WINDOW_KEYS) {
      db.prepare(
        "INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(key, String(now - 3_600_000));
    }
  });
}

function cleanupSeed() {
  withDb((db) => {
    db.prepare("DELETE FROM agent_traces WHERE trace_id=?").run(SEED_TRACE_ID);
    db.prepare(`DELETE FROM app_settings WHERE key IN (${WINDOW_KEYS.map(() => "?").join(",")})`).run(...WINDOW_KEYS);
  });
}

test("用量超限 → 发送被拦 + 对话内提示;清除后恢复放行", async ({ page }) => {
  // 先打一次 /api/usage:确保服务器已建库建表(种子写入的前置)
  expect((await page.request.get("/api/usage")).ok()).toBe(true);

  seedOverLimit();
  try {
    // 拦截路径:HTTP 200(流式 meta→done,不跑 router/agent),对话里出现超限提示
    const status = await sendChat(page, "帮我分析一下经营情况");
    expect(status).toBe(200);
    await expect(page.getByText(/用量已达上限/).first()).toBeVisible();
    // 被拦截的回合不产生 mock 回复(证明确实没跑 agent)
    await expect(page.getByText("本地模拟 Agent")).toHaveCount(0);
  } finally {
    cleanupSeed();
  }

  // 限额内恢复放行:同样的发送正常拿到 mock 回复
  await sendChat(page, "现在恢复了吗");
  await expect(page.getByText("本地模拟 Agent").first()).toBeVisible();
});
