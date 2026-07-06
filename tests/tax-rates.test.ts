import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import { loadTaxRates } from "../lib/db/finance-store.ts";
import { DEFAULT_TAX_RATES } from "../lib/domain/tax-config.ts";
import { createFinanceTools } from "../lib/agent/mcp-tools/finance-tools.ts";
import { insertPolicyRule } from "../lib/db/rule-store.ts";

// #3 增值税/企业所得税法定税率集配置化:从工具枚举写死改为 tax-config 默认 + app_settings 覆盖。
// WP5a 修订：T1 语义从"常量兜底"变"种子命中"；T2/T3 替换为 rule-store 行为测试；T4/T5 保留不变。

/** 创建完整迁移 db（含 v8 种子） */
function makeFullDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

/** 创建只有 policy_rule_sets 表的最小 db（不含 v8 种子） */
function makeMinimalDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_rule_sets (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type      TEXT    NOT NULL,
      version        TEXT    NOT NULL,
      effective_from TEXT    NOT NULL,
      effective_to   TEXT,
      payload        TEXT    NOT NULL,
      source         TEXT    NOT NULL DEFAULT 'builtin_seed',
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(rule_type, version)
    );
    CREATE INDEX IF NOT EXISTS idx_policy_rules_type_from
      ON policy_rule_sets(rule_type, effective_from);
  `);
  return db;
}

export const taxRatesTestPromise = (async () => {

  // ── T1: v8 种子在库时 loadTaxRates() 返回种子值（与 DEFAULT_TAX_RATES 相等）──
  // 语义从"常量兜底"变"种子命中"（断言不变）
  {
    const db = makeFullDb();
    db.prepare("DELETE FROM app_settings WHERE key = 'tax_rates'").run();

    const def = loadTaxRates(db);
    assert.deepEqual(def.vat, DEFAULT_TAX_RATES.vat, "T1 FAIL: 默认 VAT 集");
    assert.deepEqual(def.cit, DEFAULT_TAX_RATES.cit, "T1 FAIL: 默认 CIT 集");
    db.close();
  }

  // ── T2: rule-store 插入 user_override 版本后 as-of 取到覆盖值 ────────────────
  // 替代旧 T2（setAppSetting 覆盖）
  {
    const db = makeMinimalDb();

    // 插入一条 vat_rates 规则（无与其他规则冲突）
    insertPolicyRule(db, {
      rule_type: "vat_rates",
      version: "vat-user-override-2000",
      effective_from: "2000-01-01",
      effective_to: "2019-01-01",
      payload: JSON.stringify({ vat: ["0.13", "0.05"], cit: ["0.25"] }),
      source: "user_override",
    });

    // as-of 查询 2010-01-01 → 应取 override 版本
    const rates = loadTaxRates(db, "2010-01-01");
    assert.deepEqual(rates.vat, ["0.13", "0.05"], "T2 FAIL: VAT 覆盖");
    assert.deepEqual(rates.cit, ["0.25"], "T2 FAIL: CIT 覆盖");
    db.close();
  }

  // ── T3: rule-store 写入非法 payload（如 vat:"坏值"）被拒绝入库并抛错 ────────
  // 替代旧 T3（坏值按字段回落默认）——写入时校验取代读取时回落
  {
    const db = makeMinimalDb();

    assert.throws(
      () => insertPolicyRule(db, {
        rule_type: "vat_rates",
        version: "bad-vat",
        effective_from: "2030-01-01",
        effective_to: null,
        payload: "不是合法 JSON",
        source: "user_override",
      }),
      /payload|无效|invalid|JSON/i,
      "T3 FAIL: 非法 payload 应被拒绝并抛错（写入时校验取代读取时回落）"
    );

    db.close();
  }

  // ── T4/T5: 工具按配置集校验税率（保留不改断言）────────────────────────────
  {
    const handlers = new Map<string, (a: unknown) => Promise<unknown>>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockSdk: any = {
      tool: (name: string, _d: string, _s: unknown, h: (a: unknown) => unknown) => {
        handlers.set(name, h);
        return { name };
      },
    };
    createFinanceTools(mockSdk, "/tmp");
    const tax = handlers.get("tax_calculator")!;

    // T4: 不在集合的税率 → isError(校验拦在调脚本前)
    const bad = (await tax({ type: "vat", amount: 1000, vatParams: { direction: "from_tax_exclusive", rate: "0.99" } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.equal(bad.isError, true, "T4 FAIL: 非法税率应 isError");
    assert.ok(bad.content[0].text.includes("不在合法税率集"), "T4 FAIL: 错误应说明非法");

    // T5: 合法税率 → 走脚本算出税额
    const ok = (await tax({ type: "vat", amount: 1000, vatParams: { direction: "from_tax_exclusive", rate: "0.13" } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.ok(!ok.isError, "T5 FAIL: 合法税率不应 isError");
    assert.ok(ok.content[0].text.includes("130.00"), "T5 FAIL: 1000×13% 应=130.00");
  }

  console.log("tax-rates: 税率集配置化(种子命中 / rule-store覆盖 / 写入校验 / 工具按集校验)✓");
})();
