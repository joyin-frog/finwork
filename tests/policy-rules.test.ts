/**
 * policy-rules 测试（spec-tax-rules-store WP5a §1 成功标准）
 *
 * 覆盖：
 *  PR1  as-of 命中正确版本（两个版本不同 effectiveYear，asOf 落在各自区间）
 *  PR2  两版本边界日（effective_from 当天归属新版本，前一天归属旧版本）
 *  PR3  查无规则时显式抛错（非静默回退 DEFAULT）
 *  PR4  补算历史期间用历史版本（插入未来规则，历史 asOf 仍取历史版本）
 *  PR5  区间重叠写入拒绝（应用层同事务 SELECT 校验）
 *  PR6  v8 种子：loadTaxConfig() 无参默认取今天，命中内置种子
 *  PR7  loadTaxRates() 命中 VAT/CIT 种子（T2 替代测试）
 *  PR8  rule-store 写入非法 payload 被拒绝并抛错（T3 替代测试）
 *
 * 测试策略：PR1-PR5 使用只建表（不走完整迁移种子）的临时 db，
 * 避免 v8 内置种子的开放区间干扰手工插入的测试数据。
 * PR6-PR7 使用完整迁移 db，验证 v8 种子的实际行为。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import { loadTaxConfig, loadTaxRates } from "../lib/db/finance-store.ts";
import { insertPolicyRule, queryPolicyRule } from "../lib/db/rule-store.ts";

/** 创建只有 policy_rule_sets 表的最小 db（不含 v8 种子，用于手工插入测试） */
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

/** 创建完整迁移 db（含 v8 种子，用于验证 loadTaxConfig/loadTaxRates） */
function makeFullDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

export const policyRulesTestPromise = (async () => {

  // ── PR1: as-of 命中正确版本 ──────────────────────────────────────────────────
  {
    const db = makeMinimalDb();

    // 插入两条 iit_cumulative 规则，区间不重叠
    insertPolicyRule(db, {
      rule_type: "iit_cumulative",
      version: "2018-standard-v1",
      effective_from: "2018-10-01",
      effective_to: "2019-01-01",
      payload: JSON.stringify({
        version: "2018-standard-v1",
        effectiveYear: 2018,
        basicDeductionMonthly: 3500,
        brackets: [
          { limit: 18000, rate: 0.03, quickDeduction: 0 },
          { limit: 1.7976931348623157e+308, rate: 0.1, quickDeduction: 450 },
        ],
      }),
      source: "builtin_seed",
    });
    insertPolicyRule(db, {
      rule_type: "iit_cumulative",
      version: "2019-standard-v1",
      effective_from: "2019-01-01",
      effective_to: null,
      payload: JSON.stringify({
        version: "2019-standard-v1",
        effectiveYear: 2019,
        basicDeductionMonthly: 5000,
        brackets: [
          { limit: 36000, rate: 0.03, quickDeduction: 0 },
          { limit: 1.7976931348623157e+308, rate: 0.1, quickDeduction: 2520 },
        ],
      }),
      source: "builtin_seed",
    });

    // asOf = 2018-11-01 → 取 2018 版本
    const cfg2018 = queryPolicyRule(db, "iit_cumulative", "2018-11-01");
    assert.ok(cfg2018 !== null, "PR1 FAIL: 2018-11-01 应命中规则");
    const parsed2018 = JSON.parse(cfg2018!.payload) as { basicDeductionMonthly: number };
    assert.equal(parsed2018.basicDeductionMonthly, 3500, "PR1 FAIL: 2018 版本应是 3500 元起征点");

    // asOf = 2019-03-01 → 取 2019 版本
    const cfg2019 = queryPolicyRule(db, "iit_cumulative", "2019-03-01");
    assert.ok(cfg2019 !== null, "PR1 FAIL: 2019-03-01 应命中规则");
    const parsed2019 = JSON.parse(cfg2019!.payload) as { basicDeductionMonthly: number };
    assert.equal(parsed2019.basicDeductionMonthly, 5000, "PR1 FAIL: 2019 版本应是 5000 元起征点");

    db.close();
    console.log("PR1 PASS: as-of 命中正确版本 ✓");
  }

  // ── PR2: 边界日归属 ──────────────────────────────────────────────────────────
  {
    const db = makeMinimalDb();

    insertPolicyRule(db, {
      rule_type: "iit_cumulative",
      version: "test-2018",
      effective_from: "2018-10-01",
      effective_to: "2019-01-01",
      payload: JSON.stringify({ basicDeductionMonthly: 3500 }),
      source: "builtin_seed",
    });
    insertPolicyRule(db, {
      rule_type: "iit_cumulative",
      version: "test-2019",
      effective_from: "2019-01-01",
      effective_to: null,
      payload: JSON.stringify({ basicDeductionMonthly: 5000 }),
      source: "builtin_seed",
    });

    // effective_to = '2019-01-01'，条件 effective_to > asOf（严格大于）
    // '2018-12-31' < '2019-01-01' → 旧版本 effective_to='2019-01-01' > '2018-12-31' → 命中旧版本
    const r2018 = queryPolicyRule(db, "iit_cumulative", "2018-12-31");
    assert.ok(r2018 !== null && r2018.version === "test-2018", "PR2 FAIL: 2018-12-31 应归属 2018 版本");

    // '2019-01-01' 的旧版本：effective_to='2019-01-01' > '2019-01-01' 为 false → 不命中旧版本
    // '2019-01-01' 的新版本：effective_from='2019-01-01' <= '2019-01-01' AND effective_to=NULL → 命中新版本
    const r2019 = queryPolicyRule(db, "iit_cumulative", "2019-01-01");
    assert.ok(r2019 !== null && r2019.version === "test-2019", "PR2 FAIL: 2019-01-01 应归属 2019 版本");

    db.close();
    console.log("PR2 PASS: 边界日归属 ✓");
  }

  // ── PR3: 查无规则显式抛错 ────────────────────────────────────────────────────
  {
    const db = makeMinimalDb();

    // 只有 2019 之后的规则，查 2018 年的 asOf → queryPolicyRule 返回 null
    insertPolicyRule(db, {
      rule_type: "iit_cumulative",
      version: "test-2019-only",
      effective_from: "2019-01-01",
      effective_to: null,
      payload: JSON.stringify({
        basicDeductionMonthly: 5000,
        brackets: [{ limit: 1.7976931348623157e+308, rate: 0.03, quickDeduction: 0 }],
        version: "test-2019-only",
        effectiveYear: 2019
      }),
      source: "builtin_seed",
    });

    // loadTaxConfig 查无规则应显式抛错（传 db 参数，不用 getDb 单例）
    assert.throws(
      () => loadTaxConfig(db, "2018-06-01"),
      /无.*规则|no.*rule|找不到|not found|asOf/i,
      "PR3 FAIL: 查无规则应抛错"
    );

    db.close();
    console.log("PR3 PASS: 查无规则显式抛错 ✓");
  }

  // ── PR4: 补算历史期间用历史版本（未来规则不影响历史 asOf）──────────────────
  {
    const db = makeMinimalDb();

    insertPolicyRule(db, {
      rule_type: "iit_cumulative",
      version: "past-2019",
      effective_from: "2019-01-01",
      effective_to: "2027-01-01",
      payload: JSON.stringify({
        basicDeductionMonthly: 5000,
        brackets: [{ limit: 1.7976931348623157e+308, rate: 0.03, quickDeduction: 0 }],
        version: "past-2019",
        effectiveYear: 2019
      }),
      source: "builtin_seed",
    });
    // 插入一条未来生效的假规则（2027 年）
    insertPolicyRule(db, {
      rule_type: "iit_cumulative",
      version: "future-2027",
      effective_from: "2027-01-01",
      effective_to: null,
      payload: JSON.stringify({
        basicDeductionMonthly: 7000,
        brackets: [{ limit: 1.7976931348623157e+308, rate: 0.03, quickDeduction: 0 }],
        version: "future-2027",
        effectiveYear: 2027
      }),
      source: "builtin_seed",
    });

    // 历史 asOf = 2026-05-01 → 应取 past-2019 版本（basicDeductionMonthly=5000）
    const historical = queryPolicyRule(db, "iit_cumulative", "2026-05-01");
    assert.ok(historical !== null && historical.version === "past-2019", "PR4 FAIL: 历史 asOf 应取历史版本");
    const parsedH = JSON.parse(historical!.payload) as { basicDeductionMonthly: number };
    assert.equal(parsedH.basicDeductionMonthly, 5000, "PR4 FAIL: 历史版本的 basicDeductionMonthly 应为 5000");

    // 未来 asOf = 2027-06-01 → 应取 future-2027 版本（basicDeductionMonthly=7000）
    const future = queryPolicyRule(db, "iit_cumulative", "2027-06-01");
    assert.ok(future !== null && future.version === "future-2027", "PR4 FAIL: 未来 asOf 应取未来版本");

    db.close();
    console.log("PR4 PASS: 补算历史期间用历史版本 ✓");
  }

  // ── PR5: 区间重叠写入拒绝 ────────────────────────────────────────────────────
  {
    const db = makeMinimalDb();

    insertPolicyRule(db, {
      rule_type: "iit_cumulative",
      version: "overlap-base",
      effective_from: "2019-01-01",
      effective_to: null,
      payload: JSON.stringify({ basicDeductionMonthly: 5000 }),
      source: "builtin_seed",
    });

    // 尝试写入与上面重叠的版本（同一 rule_type，区间从 2020 开始，与上面的 [2019-01-01, NULL) 重叠）
    assert.throws(
      () => insertPolicyRule(db, {
        rule_type: "iit_cumulative",
        version: "overlap-conflict",
        effective_from: "2020-01-01",
        effective_to: null,
        payload: JSON.stringify({ basicDeductionMonthly: 5500 }),
        source: "user_override",
      }),
      /重叠|overlap|区间冲突/i,
      "PR5 FAIL: 区间重叠应被拒绝并抛错"
    );

    db.close();
    console.log("PR5 PASS: 区间重叠写入拒绝 ✓");
  }

  // ── PR6: v8 种子：loadTaxConfig() 无参 → 今天日期命中内置种子 ────────────────
  {
    const db = makeFullDb();
    // v8 迁移已在 runMigrations 中执行，内置种子应已写入
    const cfg = loadTaxConfig(db);
    assert.ok(cfg.version, "PR6 FAIL: loadTaxConfig() 应返回有 version 的配置");
    assert.ok(cfg.basicDeductionMonthly > 0, "PR6 FAIL: basicDeductionMonthly 应 > 0");
    assert.ok(Array.isArray(cfg.brackets) && cfg.brackets.length > 0, "PR6 FAIL: brackets 应是非空数组");
    // 验证 Infinity 恢复正确
    const lastBracket = cfg.brackets[cfg.brackets.length - 1];
    assert.ok(lastBracket.limit === Number.POSITIVE_INFINITY, "PR6 FAIL: 最后档 limit 应恢复为 Infinity");
    db.close();
    console.log("PR6 PASS: v8 种子 loadTaxConfig() 命中 ✓");
  }

  // ── PR7: loadTaxRates() 命中 VAT/CIT 种子（T2 替代测试）────────────────────
  {
    const db = makeFullDb();
    // 清除 app_settings 覆盖（若有），验证走 rule-store 路径
    db.prepare("DELETE FROM app_settings WHERE key IN ('tax_config','tax_rates')").run();
    const rates = loadTaxRates(db);
    assert.ok(Array.isArray(rates.vat) && rates.vat.length > 0, "PR7 FAIL: vat 应是非空数组");
    assert.ok(rates.vat.includes("0.13"), "PR7 FAIL: vat 应包含 0.13");
    assert.ok(Array.isArray(rates.cit) && rates.cit.length > 0, "PR7 FAIL: cit 应是非空数组");
    assert.ok(rates.cit.includes("0.25"), "PR7 FAIL: cit 应包含 0.25");
    db.close();
    console.log("PR7 PASS: loadTaxRates() 命中 VAT/CIT 种子 ✓");
  }

  // ── PR8: 写入非法 payload 被拒绝并抛错（T3 替代测试）──────────────────────
  {
    const db = makeMinimalDb();

    assert.throws(
      () => insertPolicyRule(db, {
        rule_type: "vat_rates",
        version: "bad-payload",
        effective_from: "2019-01-01",
        effective_to: null,
        payload: "坏值，不是合法 JSON",
        source: "user_override",
      }),
      /payload|无效|invalid|JSON/i,
      "PR8 FAIL: 非法 payload 写入应被拒绝并抛错"
    );

    db.close();
    console.log("PR8 PASS: 非法 payload 写入拒绝 ✓");
  }

  // ── PR-B1: v8 吸收 app_settings 旧覆盖 → as-of 今天仍命中覆盖值 ─────────────
  // 构造一个 v7 结构的 db（有 app_settings 表 + 合法 tax_config/tax_rates 覆盖），
  // 然后跑 v8 迁移，验证 loadTaxConfig/loadTaxRates(today) 返回覆盖值而非内置种子。
  {
    // 构造一个只有 v7 schema 的 db（停在 v7 之前的基础上，v8 还没跑）
    // 用 runMigrations 跑到 v7（migrations array 只传前 7 个）
    // 但 runMigrations 接受整个 db，我们改用 sqlite 直接建出 v7 结构 + app_settings
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // 建出 v7 所需的最小结构：app_settings 表
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // 写入合法的 tax_config 覆盖（覆盖值：basicDeductionMonthly=8000 以示区别）
    const overrideConfig = JSON.stringify({
      version: "user-custom-v1",
      effectiveYear: 2024,
      basicDeductionMonthly: 8000,
      brackets: [
        { limit: 36000,                    rate: 0.03, quickDeduction: 0      },
        { limit: 1.7976931348623157e+308,  rate: 0.1,  quickDeduction: 2520   },
      ],
    });
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('tax_config', ?)").run(overrideConfig);

    // 写入合法的 tax_rates 覆盖（包含自定义 VAT 税率以示区别）
    const overrideRates = JSON.stringify({
      vat: ["0.99", "0.88"],
      cit: ["0.25"],
    });
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('tax_rates', ?)").run(overrideRates);

    // 设置 user_version = 7（模拟 v7 完成状态）
    db.exec("PRAGMA user_version = 7");

    // 跑完整迁移（会执行 v8）
    runMigrations(db, ":memory:", () => null);

    // as-of 今天：loadTaxConfig 应返回覆盖值（basicDeductionMonthly=8000）
    const today = new Date().toISOString().slice(0, 10);
    const cfg = loadTaxConfig(db, today);
    assert.equal(
      cfg.basicDeductionMonthly, 8000,
      `PR-B1 FAIL: 升级后 loadTaxConfig(today) 应命中覆盖值 8000，实际 ${cfg.basicDeductionMonthly}`
    );
    assert.equal(
      cfg.version, "user-custom-v1",
      `PR-B1 FAIL: 升级后 loadTaxConfig(today) version 应为 user-custom-v1，实际 ${cfg.version}`
    );

    // as-of 今天：loadTaxRates 应返回覆盖值（vat 包含 0.99）
    const rates = loadTaxRates(db, today);
    assert.ok(
      rates.vat.includes("0.99"),
      `PR-B1 FAIL: 升级后 loadTaxRates(today) vat 应包含 0.99（覆盖值），实际 ${JSON.stringify(rates.vat)}`
    );

    db.close();
    console.log("PR-B1 PASS: v8 吸收覆盖后 as-of 今天命中覆盖值 ✓");
  }

  // ── PR-B2: loadTaxRates payload 损坏时抛错（禁止回落 DEFAULT）────────────────
  {
    // 手工插入一条 vat_rates 规则，payload 是合法 JSON 但 vat/cit 字段全缺
    // 然后让 loadTaxRates 解析它——应抛错而非回落 DEFAULT_TAX_RATES
    const db = makeMinimalDb();

    // 先插入一条正常规则（让 queryPolicyRule 能命中，但 payload 损坏）
    db.prepare(`
      INSERT INTO policy_rule_sets
        (rule_type, version, effective_from, effective_to, payload, source)
      VALUES ('vat_rates', 'corrupt-v1', '2019-01-01', NULL, '{"broken": true}', 'builtin_seed')
    `).run();

    // loadTaxRates 应抛错（"vat_rates 规则 payload 损坏"）
    assert.throws(
      () => loadTaxRates(db, "2020-01-01"),
      /payload.*损坏|损坏.*payload|vat_rates|数据完整性/i,
      "PR-B2 FAIL: loadTaxRates payload 损坏时应抛错而非回落 DEFAULT_TAX_RATES"
    );

    db.close();
    console.log("PR-B2 PASS: loadTaxRates payload 损坏时抛错 ✓");
  }

  console.log("policy-rules: all 10 checks passed ✓");
})();
