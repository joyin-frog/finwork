/**
 * schema 迁移系统:PRAGMA user_version + 有序 MIGRATIONS + runMigrations
 *
 * 规则:
 * - version 1 = baseline(现有 initializeSchema):全新库 / 老库(user_version=0)先跑 initializeSchema,再设 v=1
 * - version 2+ = 后续结构变更,一律新增迁移条目
 * - 每条迁移在事务内执行;任一失败 → 事务回滚 + 抛出(禁止静默吞,红线 4)
 * - 幂等:迁移内使用 addColumnIfMissing / CREATE TABLE IF NOT EXISTS 等守卫
 * - 迁移前若 user_version < 最新 version,先调用传入的 backupFn(留退路)
 *
 * 注意:backupDatabase 以参数注入,避免与 sqlite.ts 形成循环引用。
 *
 * ⚠️  冻结纪律（v1..v6 时点快照）：
 * - schema.ts 已冻结。任何新 DDL（建表 / 加列 / 建索引 / 删表 / 改约束）
 *   一律在本文件末尾追加新的 MIGRATIONS 条目，禁止修改 schema.ts。
 * - 新增迁移示例（含破坏性变更）：
 *     { version: 7, name: "drop_old_table", up: (db) => { db.exec("DROP TABLE IF EXISTS old_table"); } }
 *     { version: 7, name: "add_xyz_column", up: (db) => { addColumnIfMissing(db, "tbl", "col", "TEXT"); } }
 * - 删表迁移必须同步更新 tests/fixtures/golden-schema.json（reviewer 可核对）。
 */

import { DatabaseSync } from "node:sqlite";
import { addColumnIfMissing, initializeSchema } from "./schema";
import { deriveCashObligations } from "../domain/cash-obligations";
import { upDeliverablesV22 } from "../deliverable/schema-v22";
import { createManualMemoryConflictKey } from "../memory-v2/manual";

export type Migration = {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
};

/**
 * MIGRATIONS 数组按 version 升序排列。
 * version 1 = baseline(initializeSchema);之后的结构变更追加到此数组末尾。
 *
 * 新增迁移示例:
 *   { version: 2, name: "add_xyz_column", up: (db) => { addColumnIfMissing(db, "table", "col", "TEXT"); } }
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline",
    up: (db) => {
      // baseline:应用全量 schema(幂等 CREATE IF NOT EXISTS + addColumnIfMissing)
      initializeSchema(db);
    },
  },
  // 后续结构变更在此追加:
  {
    version: 2,
    name: "remove_phantom_generated_attachments",
    up: (db) => {
      // 修复旧 bug:syncGeneratedAttachments 把用户上传文件误登记成 assistant(生成)分身。
      // 删除"storage_path 与同会话某条 user 附件相同"的 assistant 行(仅删行,不动物理文件——
      // 文件仍被 user 附件引用,零断链)。幂等:无分身时匹配为空、no-op。
      db.exec(`
        DELETE FROM chat_attachments
        WHERE role = 'assistant'
          AND id IN (
            SELECT a.id
            FROM chat_attachments a
            JOIN chat_messages ma ON a.message_id = ma.id
            WHERE a.role = 'assistant'
              AND EXISTS (
                SELECT 1 FROM chat_attachments u
                JOIN chat_messages mu ON u.message_id = mu.id
                WHERE u.role = 'user'
                  AND u.storage_path = a.storage_path
                  AND mu.conversation_id = ma.conversation_id
              )
          )
      `);
    },
  },
  {
    version: 3,
    name: "add_feature_events",
    up: (db) => {
      // 匿名「功能触达」计数(红线 7:只存名字+计数,无 PII)。遥测 reporter 投影成 schemaVersion 4。
      db.exec(`
        CREATE TABLE IF NOT EXISTS feature_events (
          name TEXT PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0,
          first_at INTEGER NOT NULL,
          last_at INTEGER NOT NULL
        )
      `);
    },
  },
  {
    version: 4,
    name: "add_subagent_dispatches",
    up: (db) => {
      // 子代理调度史(spec-role-registry §5):记录每次 runSubagent 的起止、结果与高风险工具阻断原因。
      db.exec(`
        CREATE TABLE IF NOT EXISTS subagent_dispatches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role_id TEXT NOT NULL,
          skill TEXT,
          label TEXT,
          trace_id TEXT,
          conversation_id TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          summary TEXT,
          blocked_reason TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          duration_ms INTEGER
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatches_role_time
          ON subagent_dispatches(role_id, started_at DESC)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatches_blocked
          ON subagent_dispatches(blocked_reason) WHERE blocked_reason IS NOT NULL
      `);
    },
  },
  {
    version: 5,
    name: "business_metrics_source_enum",
    up: (db) => {
      // 存量 source='agent' 映射为 'user_dictated'（现状该表数据全部来自对话录入）。
      // 幂等：已经是 user_dictated 的行不受影响；UPDATE WHERE 不存在匹配行时无副作用。
      db.exec(`
        UPDATE business_metrics
        SET source = 'user_dictated'
        WHERE source = 'agent'
      `);
    },
  },
  {
    version: 6,
    name: "baseline_reconcile",
    up: (db) => {
      // 一次性愈合：对 user_version < 6 的存量库把 baseline 幂等重放一遍，
      // 补齐历史上"改了 schema.ts 但未加迁移"造成的任何列漂移。
      // 对全新库（v0 依次跑 v1→v6），v1 baseline 已建全部表，此处幂等重放无副作用。
      // 此后 schema.ts 永久冻结，存量库不再需要无条件 baseline。
      initializeSchema(db);
    },
  },
  {
    version: 7,
    name: "facts_foundation",
    up: (db) => {
      // WP1a 事实库第一刀：建四张 fact_* 新表 → 数据搬迁（含精度校验）→ DROP 三张旧表
      //
      // 精度约定：元 REAL → 分 INTEGER 用 round(x*100)；
      // 每行校验 |x*100 - round(x*100)| < 0.005，超差行中止迁移（抛出异常，事务回滚）。
      // 门面出口恢复元单位（/100）由 finance-store.ts 负责。

      // ── 1. 建新表 ────────────────────────────────────────────────────────────

      db.exec(`
        CREATE TABLE IF NOT EXISTS fact_invoices (
          invoice_no          TEXT PRIMARY KEY,
          direction           TEXT,
          amount_cents        INTEGER NOT NULL,
          tax_rate            REAL,
          tax_amount_cents    INTEGER,
          certification_status TEXT,
          counterparty        TEXT,
          invoice_date        TEXT,
          category            TEXT,
          settlement_status   TEXT NOT NULL DEFAULT 'recorded',
          caliber_version     TEXT NOT NULL DEFAULT 'v1',
          source              TEXT NOT NULL,
          provenance          TEXT,
          conversation_id     INTEGER,
          recorded_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_fact_invoices_recorded_at
          ON fact_invoices(recorded_at);

        CREATE TABLE IF NOT EXISTS fact_payroll (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_name             TEXT NOT NULL,
          year                      INTEGER NOT NULL,
          month                     INTEGER NOT NULL,
          gross_pay_cents           INTEGER NOT NULL,
          social_insurance_cents    INTEGER NOT NULL,
          housing_fund_cents        INTEGER NOT NULL,
          special_deduction_cents   INTEGER NOT NULL,
          months_employed           INTEGER NOT NULL,
          gross_cum_cents           INTEGER NOT NULL,
          social_cum_cents          INTEGER NOT NULL,
          fund_cum_cents            INTEGER NOT NULL,
          special_cum_cents         INTEGER NOT NULL,
          taxable_income_cum_cents  INTEGER NOT NULL,
          tax_due_cum_cents         INTEGER NOT NULL,
          tax_current_cents         INTEGER NOT NULL,
          tax_withheld_cum_cents    INTEGER NOT NULL,
          net_pay_cents             INTEGER NOT NULL,
          settlement_status         TEXT NOT NULL DEFAULT 'draft',
          caliber_version           TEXT NOT NULL,
          source                    TEXT NOT NULL DEFAULT 'agent_derived',
          detail_json               TEXT NOT NULL,
          created_at                TEXT NOT NULL DEFAULT (datetime('now')),
          confirmed_at              TEXT,
          UNIQUE(employee_name, year, month)
        );
        CREATE INDEX IF NOT EXISTS idx_fact_payroll_period
          ON fact_payroll(year, month);

        CREATE TABLE IF NOT EXISTS fact_metrics (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          year              INTEGER NOT NULL,
          month             INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
          revenue_cents     INTEGER NOT NULL,
          cost_cents        INTEGER,
          expense_cents     INTEGER,
          profit_cents      INTEGER NOT NULL,
          note              TEXT,
          settlement_status TEXT NOT NULL DEFAULT 'stated',
          caliber_version   TEXT NOT NULL DEFAULT 'v1',
          source            TEXT NOT NULL DEFAULT 'user_dictated',
          provenance        TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(year, month)
        );
        CREATE INDEX IF NOT EXISTS idx_fact_metrics_period
          ON fact_metrics(year, month);

        CREATE TABLE IF NOT EXISTS fact_obligations (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          direction           TEXT NOT NULL,
          amount_cents        INTEGER NOT NULL,
          due_date            TEXT,
          counterparty        TEXT,
          status              TEXT NOT NULL DEFAULT 'pending',
          recurrence          TEXT,
          source_document_id  INTEGER,
          settlement_status   TEXT NOT NULL DEFAULT 'derived',
          source              TEXT NOT NULL DEFAULT 'agent_derived',
          provenance          TEXT,
          derived_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_fact_obligations_due
          ON fact_obligations(due_date);
      `);

      // ── 2. 精度转换辅助函数 ──────────────────────────────────────────────────
      // 逐行校验并返回超差行的标识；超差则抛异常（事务回滚兜底）
      function toCents(yuan: number, rowId: string): number {
        const raw = yuan * 100;
        const rounded = Math.round(raw);
        if (Math.abs(raw - rounded) >= 0.005) {
          throw new Error(
            `精度超差（迁移中止）: 行 ${rowId} 金额 ${yuan} 元，|${raw} - ${rounded}| = ${Math.abs(raw - rounded).toFixed(6)} >= 0.005 分，请修正数据后重跑迁移`
          );
        }
        return rounded;
      }

      // ── 3. 搬迁 invoice_ledger → fact_invoices ──────────────────────────────
      {
        const rows = db.prepare(
          "SELECT invoice_no, amount, invoice_date, category, conversation_id, recorded_at FROM invoice_ledger"
        ).all() as Array<{
          invoice_no: string;
          amount: number;
          invoice_date: string | null;
          category: string | null;
          conversation_id: number | null;
          recorded_at: string;
        }>;

        const insert = db.prepare(`
          INSERT OR IGNORE INTO fact_invoices
            (invoice_no, amount_cents, invoice_date, category, conversation_id, recorded_at, source)
          VALUES (?, ?, ?, ?, ?, ?, 'user_dictated')
        `);

        for (const row of rows) {
          const cents = toCents(row.amount, `invoice_ledger.${row.invoice_no}`);
          insert.run(row.invoice_no, cents, row.invoice_date, row.category, row.conversation_id, row.recorded_at);
        }
      }

      // ── 4. 搬迁 payroll_records → fact_payroll ──────────────────────────────
      {
        const rows = db.prepare(
          `SELECT id, employee_name, year, month,
                  gross_pay, social_insurance, housing_fund, special_deduction, months_employed,
                  gross_cum, social_cum, fund_cum, special_cum,
                  taxable_income_cum, tax_due_cum, tax_current, tax_withheld_cum, net_pay,
                  tax_config_version, detail_json, status, created_at, confirmed_at
           FROM payroll_records`
        ).all() as Array<{
          id: number; employee_name: string; year: number; month: number;
          gross_pay: number; social_insurance: number; housing_fund: number; special_deduction: number;
          months_employed: number; gross_cum: number; social_cum: number; fund_cum: number;
          special_cum: number; taxable_income_cum: number; tax_due_cum: number; tax_current: number;
          tax_withheld_cum: number; net_pay: number; tax_config_version: string;
          detail_json: string; status: string; created_at: string; confirmed_at: string | null;
        }>;

        const insert = db.prepare(`
          INSERT OR IGNORE INTO fact_payroll
            (employee_name, year, month,
             gross_pay_cents, social_insurance_cents, housing_fund_cents, special_deduction_cents, months_employed,
             gross_cum_cents, social_cum_cents, fund_cum_cents, special_cum_cents,
             taxable_income_cum_cents, tax_due_cum_cents, tax_current_cents, tax_withheld_cum_cents, net_pay_cents,
             settlement_status, caliber_version, detail_json, created_at, confirmed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const row of rows) {
          const id = `payroll_records.id=${row.id}`;
          insert.run(
            row.employee_name, row.year, row.month,
            toCents(Number(row.gross_pay), id),
            toCents(Number(row.social_insurance), id),
            toCents(Number(row.housing_fund), id),
            toCents(Number(row.special_deduction), id),
            row.months_employed,
            toCents(Number(row.gross_cum), id),
            toCents(Number(row.social_cum), id),
            toCents(Number(row.fund_cum), id),
            toCents(Number(row.special_cum), id),
            toCents(Number(row.taxable_income_cum), id),
            toCents(Number(row.tax_due_cum), id),
            toCents(Number(row.tax_current), id),
            toCents(Number(row.tax_withheld_cum), id),
            toCents(Number(row.net_pay), id),
            row.status,           // 'draft'/'confirmed' → settlement_status
            row.tax_config_version,  // caliber_version
            row.detail_json,
            row.created_at,
            row.confirmed_at
          );
        }
      }

      // ── 5. 搬迁 business_metrics → fact_metrics ─────────────────────────────
      {
        const rows = db.prepare(
          `SELECT year, month, revenue, cost, expense, profit, note, source, created_at, updated_at
           FROM business_metrics`
        ).all() as Array<{
          year: number; month: number; revenue: number; cost: number | null;
          expense: number | null; profit: number; note: string | null;
          source: string; created_at: string; updated_at: string;
        }>;

        const insert = db.prepare(`
          INSERT OR IGNORE INTO fact_metrics
            (year, month, revenue_cents, cost_cents, expense_cents, profit_cents, note, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const row of rows) {
          const id = `business_metrics(${row.year},${row.month})`;
          insert.run(
            row.year, row.month,
            toCents(Number(row.revenue), id),
            row.cost != null ? toCents(Number(row.cost), id) : null,
            row.expense != null ? toCents(Number(row.expense), id) : null,
            toCents(Number(row.profit), id),
            row.note,
            row.source,
            row.created_at,
            row.updated_at
          );
        }
      }

      // ── 6. DROP 三张旧表 ────────────────────────────────────────────────────
      db.exec(`
        DROP TABLE IF EXISTS invoice_ledger;
        DROP TABLE IF EXISTS payroll_records;
        DROP TABLE IF EXISTS business_metrics;
      `);
    },
  },
  {
    version: 8,
    name: "policy_rule_sets",
    up: (db) => {
      // WP5a 政策规则数据化：建表 + 个税/VAT/CIT 内置种子 + 吸收 app_settings 现存覆盖

      // ── 1. 建表 ─────────────────────────────────────────────────────────────
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

      // ── 2. 内置个税种子（个人所得税累计预扣预缴，2019-01-01 至今）─────────────
      // payload = DEFAULT_TAX_CONFIG（现内置值），effective_from 对应税改生效日
      const iitPayload = JSON.stringify({
        version: "2026-standard-v1",
        effectiveYear: 2026,
        basicDeductionMonthly: 5000,
        brackets: [
          { limit: 36000,              rate: 0.03, quickDeduction: 0      },
          { limit: 144000,             rate: 0.1,  quickDeduction: 2520   },
          { limit: 300000,             rate: 0.2,  quickDeduction: 16920  },
          { limit: 420000,             rate: 0.25, quickDeduction: 31920  },
          { limit: 660000,             rate: 0.3,  quickDeduction: 52920  },
          { limit: 960000,             rate: 0.35, quickDeduction: 85920  },
          { limit: 1.7976931348623157e+308, rate: 0.45, quickDeduction: 181920 },
        ],
      });
      db.prepare(`
        INSERT OR IGNORE INTO policy_rule_sets
          (rule_type, version, effective_from, effective_to, payload, source)
        VALUES ('iit_cumulative', '2026-standard-v1', '2019-01-01', NULL, ?, 'builtin_seed')
      `).run(iitPayload);

      // ── 3. 内置 VAT 合法税率集种子 ───────────────────────────────────────────
      const vatPayload = JSON.stringify({
        vat: ["0.13", "0.09", "0.06", "0.03"],
        cit: ["0.25", "0.20", "0.15"],
      });
      db.prepare(`
        INSERT OR IGNORE INTO policy_rule_sets
          (rule_type, version, effective_from, effective_to, payload, source)
        VALUES ('vat_rates', '2019-standard-v1', '2019-01-01', NULL, ?, 'builtin_seed')
      `).run(vatPayload);

      // ── 4. 吸收 app_settings 现存税配置覆盖（若有且合法，写成 user_override 版本）
      // 解析失败的坏值：跳过 + console.warn + 保留原 app_settings 行（不删除）
      // tax_config 覆盖 → iit_cumulative user_override
      {
        const taxConfigRow = db.prepare(
          "SELECT value FROM app_settings WHERE key = 'tax_config'"
        ).get() as { value: string } | undefined;

        if (taxConfigRow) {
          try {
            const parsed = JSON.parse(taxConfigRow.value) as {
              version?: string;
              brackets?: unknown[];
              basicDeductionMonthly?: number;
            };
            if (
              parsed.version &&
              Array.isArray(parsed.brackets) &&
              parsed.brackets.length > 0 &&
              parsed.basicDeductionMonthly != null &&
              parsed.basicDeductionMonthly > 0
            ) {
              // 写入 user_override 版本，令其从 2019-01-01 至今生效（与旧机制语义一致）。
              // 同一事务内：先将内置种子行的 effective_to 收口为 '2018-12-31'（边界不重叠），
              // 再插入覆盖行 [2019-01-01, NULL)。这样 as-of 今天的查询命中覆盖值，
              // as-of 2018 年的历史查询仍命中内置种子（若有该期间数据）。
              const overrideVersion = `user-override-${parsed.version}`;
              const existing = db.prepare(
                "SELECT id FROM policy_rule_sets WHERE rule_type = ? AND version = ?"
              ).get("iit_cumulative", overrideVersion);
              if (!existing) {
                // 步骤①：收口内置种子的 effective_to，使其不覆盖 2019-01-01 之后的区间
                db.prepare(`
                  UPDATE policy_rule_sets
                  SET effective_to = '2018-12-31'
                  WHERE rule_type = 'iit_cumulative'
                    AND source = 'builtin_seed'
                    AND (effective_to IS NULL OR effective_to > '2019-01-01')
                `).run();
                // 步骤②：插入覆盖行，真实区间 [2019-01-01, NULL)
                db.prepare(`
                  INSERT OR IGNORE INTO policy_rule_sets
                    (rule_type, version, effective_from, effective_to, payload, source)
                  VALUES ('iit_cumulative', ?, '2019-01-01', NULL, ?, 'user_override')
                `).run(overrideVersion, taxConfigRow.value);
              }
            } else {
              console.warn(
                "[v8 migration] app_settings.tax_config 解析合法 JSON 但缺少必要字段（version/brackets/basicDeductionMonthly），跳过吸收，原行保留"
              );
            }
          } catch {
            console.warn(
              "[v8 migration] app_settings.tax_config 不是合法 JSON，跳过吸收，原行保留"
            );
          }
        }
      }

      // tax_rates 覆盖 → vat_rates user_override
      {
        const taxRatesRow = db.prepare(
          "SELECT value FROM app_settings WHERE key = 'tax_rates'"
        ).get() as { value: string } | undefined;

        if (taxRatesRow) {
          try {
            const parsed = JSON.parse(taxRatesRow.value) as {
              vat?: unknown;
              cit?: unknown;
            };
            const ok = (xs: unknown): xs is string[] =>
              Array.isArray(xs) && xs.length > 0 && xs.every((r) => typeof r === "string");
            if (ok(parsed.vat) || ok(parsed.cit)) {
              const overrideVersion = "user-override-tax-rates";
              const existing = db.prepare(
                "SELECT id FROM policy_rule_sets WHERE rule_type = ? AND version = ?"
              ).get("vat_rates", overrideVersion);
              if (!existing) {
                // 步骤①：收口内置种子的 effective_to，使其不覆盖 2019-01-01 之后的区间
                db.prepare(`
                  UPDATE policy_rule_sets
                  SET effective_to = '2018-12-31'
                  WHERE rule_type = 'vat_rates'
                    AND source = 'builtin_seed'
                    AND (effective_to IS NULL OR effective_to > '2019-01-01')
                `).run();
                // 步骤②：插入覆盖行，真实区间 [2019-01-01, NULL)
                db.prepare(`
                  INSERT OR IGNORE INTO policy_rule_sets
                    (rule_type, version, effective_from, effective_to, payload, source)
                  VALUES ('vat_rates', ?, '2019-01-01', NULL, ?, 'user_override')
                `).run(overrideVersion, taxRatesRow.value);
              }
            } else {
              console.warn(
                "[v8 migration] app_settings.tax_rates 解析合法 JSON 但无有效 vat/cit 字段，跳过吸收，原行保留"
              );
            }
          } catch {
            console.warn(
              "[v8 migration] app_settings.tax_rates 不是合法 JSON，跳过吸收，原行保留"
            );
          }
        }
      }
    },
  },
  {
    version: 9,
    name: "obligations_reshape",
    up: (db) => {
      // WP1b: 重建 fact_obligations（修形状缺陷）+ 迁移内回填存量 confirmed 文档
      //
      // 形状变更：
      //   旧：direction('pay'/'receive') + amount_cents NOT NULL + 无 status_raw/source_doc/kind
      //   新：kind('pay'/'receive'/'invoice') + amount_cents NULL + status_raw + source_doc + source_document_id NOT NULL
      //
      // 处置（reviewer B1）：表非空 → console.warn + 照常 DROP（旧形状行为已无效，不中止）

      // ── 1. 表非空处置 ────────────────────────────────────────────────────────
      // 先判表是否存在（PR-B1 模式：用 PRAGMA user_version=7 伪造 v7 状态但未实际跑 v7 DDL）
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='fact_obligations'"
      ).get() as { name: string } | undefined;
      if (tableExists) {
        const countRow = db.prepare("SELECT COUNT(*) AS c FROM fact_obligations").get() as { c: number };
        if (countRow.c > 0) {
          console.warn(
            `[v9 migration] fact_obligations 有 ${countRow.c} 行旧形状数据，将被丢弃并以新形状重建（旧列 direction/amount NOT NULL 与新列 kind/amount NULL 不兼容，保留会产生语义错误）`
          );
        }
      }

      // ── 2. DROP 旧表 + 重建新表 ───────────────────────────────────────────────
      db.exec(`DROP TABLE IF EXISTS fact_obligations`);
      db.exec(`
        CREATE TABLE fact_obligations (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          kind                TEXT    NOT NULL CHECK(kind IN ('pay','receive','invoice')),
          amount_cents        INTEGER NULL,
          due_date            TEXT    NOT NULL,
          counterparty        TEXT,
          status              TEXT    NOT NULL DEFAULT 'pending',
          status_raw          TEXT    NOT NULL,
          source_doc          TEXT    NULL,
          recurrence          TEXT    NULL,
          source_document_id  INTEGER NOT NULL,
          settlement_status   TEXT    NOT NULL DEFAULT 'derived',
          source              TEXT    NOT NULL DEFAULT 'agent_derived',
          provenance          TEXT    NULL,
          derived_at          TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_fact_obligations_due
          ON fact_obligations(due_date);
        CREATE INDEX IF NOT EXISTS idx_fact_obligations_src_doc
          ON fact_obligations(source_document_id);
      `);

      // ── 3. 回填：读 confirmed 文档 → deriveCashObligations → INSERT ──────────
      // 先确认 knowledge_documents 表存在（测试可能用 PRAGMA user_version 伪造版本号而不含该表）
      const kdExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_documents'"
      ).get() as { name: string } | undefined;
      if (!kdExists) {
        // 无 knowledge_documents 表（非正常 schema），跳过回填
        return;
      }

      // listConfirmedMetaDocRows 接受 db 参数，可安全复用（无循环引用）
      const confirmedRows = db.prepare(
        "SELECT id, file_name, metadata, meta_status FROM knowledge_documents WHERE meta_status = 'confirmed' AND metadata IS NOT NULL AND archived = 0"
      ).all() as Array<{ id: number; file_name: string; metadata: string; meta_status: string }>;

      if (confirmedRows.length === 0) {
        // 无 confirmed 文档，回填 no-op
        return;
      }

      type DocMetadataRaw = {
        status?: string;
        counterparty?: string;
        amount?: number;
        keyDates?: Array<{ kind: string; date: string }>;
        recurrence?: string;
        sourceFile?: string;
      };

      const srcDocs = confirmedRows.map(r => {
        let meta: DocMetadataRaw | null = null;
        try { meta = JSON.parse(r.metadata) as DocMetadataRaw; } catch { meta = null; }
        return {
          id: r.id,
          fileName: r.file_name,
          metadata: meta as import("../domain/cash-obligations").CashObligation["recurrence"] extends infer _ ? import("../knowledge/types").DocMetadata | null : never,
          metaStatus: r.meta_status as "confirmed",
        };
      });

      const obligations = deriveCashObligations(srcDocs as Parameters<typeof deriveCashObligations>[0]);

      if (obligations.length === 0) return;

      // 精度校验辅助（与 v7 同约定）
      function toCentsNullable(yuan: number | undefined, rowId: string): number | null {
        if (typeof yuan !== "number" || !Number.isFinite(yuan)) return null;
        const raw = yuan * 100;
        const rounded = Math.round(raw);
        if (Math.abs(raw - rounded) >= 0.005) {
          throw new Error(
            `精度超差（v9 迁移回填中止）: 文档 ${rowId} 金额 ${yuan} 元，|${raw} - ${rounded}| = ${Math.abs(raw - rounded).toFixed(6)} >= 0.005 分`
          );
        }
        return rounded;
      }

      // kind 映射：付款→pay / 收款→receive / 开票→invoice
      function toKind(k: "付款" | "收款" | "开票"): "pay" | "receive" | "invoice" {
        if (k === "付款") return "pay";
        if (k === "收款") return "receive";
        return "invoice";
      }

      const insert = db.prepare(`
        INSERT INTO fact_obligations
          (kind, amount_cents, due_date, counterparty, status, status_raw, source_doc, recurrence,
           source_document_id, settlement_status, source, provenance, derived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'derived', 'agent_derived', NULL, datetime('now'))
      `);

      for (const obl of obligations) {
        const amountCents = toCentsNullable(obl.amount, `doc_id=${obl.documentId}`);
        const status = obl.done ? "settled" : "pending";
        insert.run(
          toKind(obl.kind),
          amountCents,
          obl.dueDate,
          obl.counterparty,
          status,
          obl.status,
          obl.sourceDoc ?? null,
          obl.recurrence ?? null,
          obl.documentId
        );
      }
    },
  },
  {
    version: 10,
    name: "artifacts",
    up: (db) => {
      // WP14a: 交互工件表——可勾选清单工件的持久层
      //
      // payload: JSON 字符串，格式 {items:[{id,label,detail?,severity?}]}
      // state:   JSON 字符串，格式 {itemId:'open'|'done'|'ignored'}，默认 '{}'
      // ON DELETE CASCADE：清单工件是会话内进度记录，会话删则工件随之删除；
      //   conversation_id NULL 行不受级联影响（孤儿，可接受残留面）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id              TEXT    NOT NULL PRIMARY KEY,
          kind            TEXT    NOT NULL DEFAULT 'checklist',
          conversation_id INTEGER NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
          title           TEXT    NOT NULL,
          payload         TEXT    NOT NULL,
          state           TEXT    NOT NULL DEFAULT '{}',
          created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_artifacts_conversation_id
          ON artifacts(conversation_id);
      `);
    },
  },
  {
    version: 11,
    name: "knowledge_embeddings",
    up: (db) => {
      // WP12: 语义检索——本地 embedding 落库
      // 表名刻意避开 legacy knowledge_chunks（baseline DROP 已清，不复活）
      // embedding BLOB 存 Float32 小端 512 维（2048 bytes/行）
      // UNIQUE(document_id, chunk_index) 防重复切块；ON DELETE CASCADE 跟随文档删除
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_embeddings (
          id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          text        TEXT    NOT NULL,
          embedding   BLOB    NOT NULL,
          model       TEXT    NOT NULL,
          created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(document_id, chunk_index)
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_doc
          ON knowledge_embeddings(document_id);
      `);
    },
  },
  {
    version: 12,
    name: "audit_logs_semantics",
    up: (db) => {
      // WP15: 给 audit_logs 补齐撤销语义列 + 归因列
      // - conversation_id: 哪次对话触发（不加 FK——audit 须比会话长寿）
      // - tool_name: 哪个 MCP 工具写的
      // - undo: JSON 逆操作数组（仅两种原语 delete_rows / restore_rows）
      // - undone_at: 撤销时间戳（非 null 表示已撤销）
      // - idx_audit_logs_created_at: 列表查询按时间倒序
      //
      // 防御性：某些测试绕过 initializeSchema 直接设 user_version。
      // 若 audit_logs 表不存在，先幂等建表（完整 baseline 形状）再加新列。
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT    NOT NULL,
          payload    TEXT    NOT NULL,
          created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // trace_id 是 baseline 里 addColumnIfMissing 加的；守卫性补全
      addColumnIfMissing(db, "audit_logs", "trace_id", "TEXT");
      addColumnIfMissing(db, "audit_logs", "conversation_id", "INTEGER NULL");
      addColumnIfMissing(db, "audit_logs", "tool_name", "TEXT NULL");
      addColumnIfMissing(db, "audit_logs", "undo", "TEXT NULL");
      addColumnIfMissing(db, "audit_logs", "undone_at", "TEXT NULL");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
          ON audit_logs(created_at DESC)
      `);
    },
  },
  {
    version: 13,
    name: "fact_invoices_settlement_columns",
    up: (db) => {
      // WP13b: fact_invoices 补三列支持销项回款落盘
      // - settled_at: 实收日期（YYYY-MM-DD），NULL 表示未回款
      // - settled_amount_cents: 实收金额（分），v1 单次结清，可与发票额不同
      // - settlement_note: 回款备注，自由文本
      // 三列均 NULL 允许（addColumnIfMissing 幂等，兼容已存在列）
      //
      // 防御性：某些测试绕过 initializeSchema 直接设 user_version。
      // 若 fact_invoices 表不存在，先幂等建表（完整 baseline 形状）再加新列。
      db.exec(`
        CREATE TABLE IF NOT EXISTS fact_invoices (
          invoice_no          TEXT PRIMARY KEY,
          direction           TEXT,
          amount_cents        INTEGER NOT NULL,
          tax_rate            REAL,
          tax_amount_cents    INTEGER,
          certification_status TEXT,
          counterparty        TEXT,
          invoice_date        TEXT,
          category            TEXT,
          settlement_status   TEXT NOT NULL DEFAULT 'recorded',
          caliber_version     TEXT NOT NULL DEFAULT 'v1',
          source              TEXT NOT NULL,
          provenance          TEXT,
          conversation_id     INTEGER,
          recorded_at         TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      addColumnIfMissing(db, "fact_invoices", "settled_at", "TEXT NULL");
      addColumnIfMissing(db, "fact_invoices", "settled_amount_cents", "INTEGER NULL");
      addColumnIfMissing(db, "fact_invoices", "settlement_note", "TEXT NULL");
    },
  },
  {
    version: 14,
    name: "calc_receipts_and_payroll_receipt_id",
    up: (db) => {
      // WP4b: CalcReceipt 持久化
      // calc_receipts: 独立表（无会话 FK——计算凭据须比会话长寿，同 audit_logs 设计）
      db.exec(`
        CREATE TABLE IF NOT EXISTS calc_receipts (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          tool_name       TEXT    NOT NULL,
          conversation_id INTEGER NULL,
          trace_id        TEXT    NULL,
          receipt         TEXT    NOT NULL,
          created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_calc_receipts_conversation_id
          ON calc_receipts(conversation_id);
      `);
      // fact_payroll 补 receipt_id（引用 calc_receipts，NULL 允许兼容历史行）
      // 防御性：某些测试绕过 initializeSchema 直接设 user_version，fact_payroll 可能不存在
      db.exec(`
        CREATE TABLE IF NOT EXISTS fact_payroll (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_name             TEXT NOT NULL,
          year                      INTEGER NOT NULL,
          month                     INTEGER NOT NULL,
          gross_pay_cents           INTEGER NOT NULL,
          social_insurance_cents    INTEGER NOT NULL,
          housing_fund_cents        INTEGER NOT NULL,
          special_deduction_cents   INTEGER NOT NULL,
          months_employed           INTEGER NOT NULL,
          gross_cum_cents           INTEGER NOT NULL,
          social_cum_cents          INTEGER NOT NULL,
          fund_cum_cents            INTEGER NOT NULL,
          special_cum_cents         INTEGER NOT NULL,
          taxable_income_cum_cents  INTEGER NOT NULL,
          tax_due_cum_cents         INTEGER NOT NULL,
          tax_current_cents         INTEGER NOT NULL,
          tax_withheld_cum_cents    INTEGER NOT NULL,
          net_pay_cents             INTEGER NOT NULL,
          settlement_status         TEXT NOT NULL DEFAULT 'draft',
          caliber_version           TEXT NOT NULL,
          source                    TEXT NOT NULL DEFAULT 'agent_derived',
          detail_json               TEXT NOT NULL,
          created_at                TEXT NOT NULL DEFAULT (datetime('now')),
          confirmed_at              TEXT,
          UNIQUE(employee_name, year, month)
        )
      `);
      addColumnIfMissing(db, "fact_payroll", "receipt_id", "INTEGER NULL");
    },
  },
  // ⚠ 撞号史：本条目两度撞号（11→13→15，strange-mendel/PR #37 占用 11-14 且共享 dev 库
  //   已被推到 14）。后续加迁移前必须核对 ①main 链尾 ②所有开放 worktree 的
  //   migrations.ts 链尾 ③共享库 PRAGMA user_version，取三者最高 +1，否则被静默跳过。
  {
    version: 15,
    name: "task-dispatch-objectify",
    up: (db) => {
      // spec-task-templates: 派发对象化——为 subagent_dispatches 增加五列
      // 幂等：addColumnIfMissing 用 IF NOT EXISTS 语义
      //
      // 表存在性守卫（与 v9 同模式）：
      // 少数测试用 initializeSchema(v1 快照) + 手动 user_version 绕过 v4 DDL，
      // 导致 subagent_dispatches 实际未建——此时本迁移应静默跳过，
      // 待完整迁移链（v4 建表 → v15 加列）在真实数据库上正确执行。
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_dispatches'"
      ).get();
      if (tableExists) {
        addColumnIfMissing(db, "subagent_dispatches", "task_template_id", "TEXT");
        addColumnIfMissing(db, "subagent_dispatches", "business_object",  "TEXT");
        addColumnIfMissing(db, "subagent_dispatches", "period",           "TEXT");
        addColumnIfMissing(db, "subagent_dispatches", "review_status",    "TEXT");
        addColumnIfMissing(db, "subagent_dispatches", "locked_at",        "TEXT");
      }

      // 撞号愈合：本条目曾以 v13 之名把共享 dev 库推到 13，导致 PR #37 真正的
      // v13（fact_invoices 回款三列）在该库上被静默跳过。此处幂等补齐——
      // 全新库经 v13 已建三列，addColumnIfMissing 为 no-op；被撞库在此愈合。
      const invoicesExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='fact_invoices'"
      ).get();
      if (invoicesExists) {
        addColumnIfMissing(db, "fact_invoices", "settled_at", "TEXT NULL");
        addColumnIfMissing(db, "fact_invoices", "settled_amount_cents", "INTEGER NULL");
        addColumnIfMissing(db, "fact_invoices", "settlement_note", "TEXT NULL");
      }
    },
  },
  {
    version: 16,
    name: "dispatch-files",
    up: (db) => {
      // 看板视觉刀：为 subagent_dispatches 增加 files 列（JSON 数组字符串，NULL 允许）
      // 表存在性守卫（与 v15 同模式）：少数测试用 user_version 伪造版本号但未建表
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_dispatches'"
      ).get();
      if (tableExists) {
        addColumnIfMissing(db, "subagent_dispatches", "files", "TEXT");
      }
    },
  },
  {
    version: 17,
    name: "idx_fact_invoices_invoice_date",
    up: (db) => {
      // WP-G 台账索引：按发票日期查询是最常见的过滤条件，补上 B-Tree 索引加速。
      // CREATE INDEX IF NOT EXISTS 幂等，连跑两次无副作用。
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_fact_invoices_invoice_date ON fact_invoices(invoice_date)"
      );
    },
  },
  {
    version: 18,
    name: "role_memory",
    up: (db) => {
      // 智能体 IA · C 刀：每角色独立记忆表（按 role_id 隔离，即隐私边界）。
      // content = 一条口径/约定；source = 来源标注（手动添加为 NULL，自动沉淀刀再填任务来源）。
      // CREATE TABLE/INDEX IF NOT EXISTS 幂等，连跑两次无副作用。
      db.exec(`
        CREATE TABLE IF NOT EXISTS role_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role_id TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_role_memory_role ON role_memory(role_id, created_at DESC)"
      );
    },
  },
  {
    version: 19,
    name: "conversation_role_id",
    up: (db) => {
      // 智能体 IA · E 刀（专员会话）：会话加角色维度。
      // NULL = 主管会话（现状全部会话，零改动）；非 NULL = 绕过主管直接与该专员的会话。
      // addColumnIfMissing 幂等；表存在性守卫应对测试构造的局部库（真实库 baseline 必有此表）。
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_conversations'"
      ).get();
      if (tableExists) {
        addColumnIfMissing(db, "chat_conversations", "role_id", "TEXT");
      }
    },
  },
  {
    version: 20,
    name: "transfer_queue_instructions",
    up: (db) => {
      // 智能体 IA · D 刀（越权转交排队）：subagent_dispatches 加 instructions 列，
      // 存储转交卡携带的完整任务指令，供「现在开始」端点构建 SubagentTask 使用。
      // status='queued' 是本刀引入的新状态值；SQLite 无枚举约束，无需 DDL 变更，
      // 已有 status TEXT NOT NULL DEFAULT 'running' 列足以存储新值。
      // 表存在性守卫与 v15 同模式：测试可能绕过 v4 DDL，此时静默跳过。
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_dispatches'"
      ).get();
      if (tableExists) {
        addColumnIfMissing(db, "subagent_dispatches", "instructions", "TEXT");
      }
    },
  },
  // CR-R1：持久 Run 账本。三查（2026-07-22）：链尾原为 20；共享 Finwork 库 user_version=20。
  //   v22 由 CR-Q1 deliverable registry 占用（并行落地，保持连续）。
  {
    version: 21,
    name: "agent_runs_and_run_events",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_runs (
          run_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          conversation_id INTEGER,
          status TEXT NOT NULL,
          termination_reason TEXT,
          quality_status TEXT NOT NULL DEFAULT 'not_applicable',
          session_id TEXT,
          model_used TEXT,
          model_role TEXT,
          execution_tier TEXT,
          model_fallback_reason TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          ended_at TEXT,
          heartbeat_at TEXT,
          turns_used INTEGER NOT NULL DEFAULT 0,
          active_ms INTEGER NOT NULL DEFAULT 0,
          waiting_ms INTEGER NOT NULL DEFAULT 0,
          last_event_id INTEGER,
          latest_checkpoint_json TEXT,
          error_code TEXT,
          error_message TEXT
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id, started_at DESC)"
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, updated_at DESC)"
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_trace ON agent_runs(trace_id)"
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS run_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          conversation_id INTEGER,
          instance_id TEXT,
          event_type TEXT NOT NULL,
          event_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, id)"
      );
      // 每 Run 恰好一条 canonical settled（AR2a outcome 三值不变）
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_settled_once ON run_events(run_id) WHERE event_type = 'run_settled'"
      );
    },
  },
  // CR-Q1：deliverable registry + completion_evidence（依赖 R1 v21 已在链上）。
  {
    version: 22,
    name: "deliverable_registry",
    up: (db) => {
      upDeliverablesV22(db);
    },
  },
  {
    version: 23,
    name: "neutral_runtime_session_locator",
    up: (db) => {
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_conversations'"
      ).get();
      if (!table) return;
      const columns = new Set(
        (db.prepare("PRAGMA table_info(chat_conversations)").all() as Array<{ name: string }>)
          .map((column) => column.name)
      );
      if (columns.has("claude_session_id") && !columns.has("runtime_session_id")) {
        db.exec(
          "ALTER TABLE chat_conversations RENAME COLUMN claude_session_id TO runtime_session_id"
        );
      }
      if (
        columns.has("claude_session_updated_at") &&
        !columns.has("runtime_session_updated_at")
      ) {
        db.exec(
          "ALTER TABLE chat_conversations RENAME COLUMN claude_session_updated_at TO runtime_session_updated_at"
        );
      }
    },
  },
  {
    version: 24,
    name: "capability_kernel",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS capability_definitions (
          capability_id       TEXT NOT NULL,
          version             TEXT NOT NULL,
          title               TEXT NOT NULL,
          input_schema_id     TEXT NOT NULL,
          output_schema_id    TEXT NOT NULL,
          manifest_json       TEXT NOT NULL,
          checksum            TEXT NOT NULL,
          status              TEXT NOT NULL CHECK(status IN ('available','unavailable','deprecated')),
          unavailable_reason  TEXT,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (capability_id, version),
          CHECK(
            (status = 'unavailable' AND unavailable_reason IS NOT NULL)
            OR (status <> 'unavailable' AND unavailable_reason IS NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS idx_capability_definitions_status
          ON capability_definitions(status, capability_id, version);

        CREATE TABLE IF NOT EXISTS capability_aliases (
          alias          TEXT PRIMARY KEY,
          capability_id  TEXT NOT NULL,
          version        TEXT NOT NULL,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (capability_id, version)
            REFERENCES capability_definitions(capability_id, version) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_capability_aliases_target
          ON capability_aliases(capability_id, version);

        CREATE TABLE IF NOT EXISTS capability_instances (
          instance_id       TEXT PRIMARY KEY,
          capability_id     TEXT NOT NULL,
          version           TEXT NOT NULL,
          provider_id       TEXT NOT NULL,
          status            TEXT NOT NULL CHECK(status IN ('available','unavailable','degraded')),
          dependency_health TEXT NOT NULL DEFAULT '{}',
          preflight_json     TEXT,
          checked_at        TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (capability_id, version)
            REFERENCES capability_definitions(capability_id, version) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_capability_instances_lookup
          ON capability_instances(capability_id, version, status);

        CREATE TABLE IF NOT EXISTS capability_attempts (
          attempt_id       TEXT PRIMARY KEY,
          invocation_id    TEXT NOT NULL,
          run_id           TEXT NOT NULL,
          case_id          TEXT,
          capability_id    TEXT NOT NULL,
          version          TEXT NOT NULL,
          attempt_no       INTEGER NOT NULL CHECK(attempt_no > 0),
          input_hash       TEXT NOT NULL,
          idempotency_key  TEXT,
          status           TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','canceled')),
          failure_kind     TEXT,
          failure_json     TEXT,
          output_json      TEXT,
          started_at       TEXT NOT NULL,
          ended_at         TEXT,
          UNIQUE(invocation_id, attempt_no)
        );
        CREATE INDEX IF NOT EXISTS idx_capability_attempts_invocation
          ON capability_attempts(invocation_id, attempt_no);
        CREATE INDEX IF NOT EXISTS idx_capability_attempts_run
          ON capability_attempts(run_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_capability_attempts_idempotency
          ON capability_attempts(capability_id, version, idempotency_key, status);
      `);
    },
  },
  {
    version: 25,
    name: "task_case_orchestration",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_contracts (
          task_id        TEXT PRIMARY KEY,
          contract_version INTEGER NOT NULL CHECK(contract_version = 3),
          contract_json  TEXT NOT NULL,
          contract_hash  TEXT NOT NULL,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS cases (
          case_id              TEXT PRIMARY KEY,
          task_id              TEXT NOT NULL REFERENCES task_contracts(task_id),
          run_id               TEXT,
          state                TEXT NOT NULL CHECK(state IN (
            'draft','waiting_for_input','preflight','planned','running','waiting_for_human',
            'validating','repairing','finalizing','delivered','failed','canceled'
          )),
          plan_version         INTEGER NOT NULL DEFAULT 1,
          latest_checkpoint_id TEXT,
          failure_json         TEXT,
          created_at           TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at             TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cases_task ON cases(task_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cases_state ON cases(state, updated_at DESC);

        CREATE TABLE IF NOT EXISTS case_nodes (
          node_id            TEXT PRIMARY KEY,
          case_id            TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          capability_id      TEXT NOT NULL,
          capability_version TEXT NOT NULL,
          status             TEXT NOT NULL CHECK(status IN (
            'pending','ready','running','waiting_for_human','validating','succeeded','failed','skipped','canceled'
          )),
          input_json         TEXT NOT NULL,
          input_hash         TEXT NOT NULL,
          output_json        TEXT,
          idempotency_key    TEXT,
          ordinal            INTEGER NOT NULL,
          started_at         TEXT,
          ended_at           TEXT,
          UNIQUE(case_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_case_nodes_case_status
          ON case_nodes(case_id, status, ordinal);

        CREATE TABLE IF NOT EXISTS case_edges (
          case_id       TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          from_node_id  TEXT NOT NULL REFERENCES case_nodes(node_id) ON DELETE CASCADE,
          to_node_id    TEXT NOT NULL REFERENCES case_nodes(node_id) ON DELETE CASCADE,
          edge_type     TEXT NOT NULL DEFAULT 'depends_on' CHECK(edge_type IN ('depends_on','data','control')),
          PRIMARY KEY (case_id, from_node_id, to_node_id, edge_type),
          CHECK(from_node_id <> to_node_id)
        );
        CREATE INDEX IF NOT EXISTS idx_case_edges_to ON case_edges(case_id, to_node_id);

        CREATE TABLE IF NOT EXISTS case_step_attempts (
          step_attempt_id TEXT PRIMARY KEY,
          case_id         TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          node_id         TEXT NOT NULL REFERENCES case_nodes(node_id) ON DELETE CASCADE,
          attempt_no      INTEGER NOT NULL CHECK(attempt_no > 0),
          capability_attempt_id TEXT,
          status          TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','canceled')),
          failure_json    TEXT,
          started_at      TEXT NOT NULL,
          ended_at        TEXT,
          UNIQUE(node_id, attempt_no)
        );

        CREATE TABLE IF NOT EXISTS case_checkpoints (
          checkpoint_id  TEXT PRIMARY KEY,
          case_id        TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          sequence_no    INTEGER NOT NULL CHECK(sequence_no > 0),
          state          TEXT NOT NULL,
          snapshot_json  TEXT NOT NULL,
          snapshot_hash  TEXT NOT NULL,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(case_id, sequence_no)
        );
        CREATE INDEX IF NOT EXISTS idx_case_checkpoints_latest
          ON case_checkpoints(case_id, sequence_no DESC);

        CREATE TABLE IF NOT EXISTS case_human_decisions (
          decision_id    TEXT PRIMARY KEY,
          case_id        TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          spec_id        TEXT NOT NULL,
          status         TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','canceled')),
          prompt         TEXT NOT NULL,
          answer_json    TEXT,
          requested_at   TEXT NOT NULL,
          resolved_at    TEXT,
          UNIQUE(case_id, spec_id)
        );
      `);
    },
  },
  {
    version: 26,
    name: "artifact_graph_and_cas",
    up: (db) => {
      const legacyArtifacts = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'"
      ).get();
      const checklistArtifacts = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='checklist_artifacts'"
      ).get();
      if (legacyArtifacts && !checklistArtifacts) {
        const columns = new Set(
          (db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>).map((column) => column.name)
        );
        if (columns.has("payload") && columns.has("state")) {
          db.exec("ALTER TABLE artifacts RENAME TO checklist_artifacts");
          db.exec("DROP INDEX IF EXISTS idx_artifacts_conversation_id");
          db.exec(
            "CREATE INDEX IF NOT EXISTS idx_checklist_artifacts_conversation_id ON checklist_artifacts(conversation_id)"
          );
        }
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          artifact_id       TEXT PRIMARY KEY,
          kind              TEXT NOT NULL,
          logical_name      TEXT NOT NULL,
          owner_case_id     TEXT REFERENCES cases(case_id),
          classification    TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','restricted')),
          lifecycle_state   TEXT NOT NULL CHECK(lifecycle_state IN ('staging','candidate','delivered','archived','tombstoned')),
          current_version_id TEXT,
          retention_json    TEXT NOT NULL,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_artifacts_case_state
          ON artifacts(owner_case_id, lifecycle_state, updated_at DESC);

        CREATE TABLE IF NOT EXISTS artifact_versions (
          version_id       TEXT PRIMARY KEY,
          artifact_id      TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
          version_no       INTEGER NOT NULL CHECK(version_no > 0),
          sha256           TEXT NOT NULL,
          size_bytes       INTEGER NOT NULL CHECK(size_bytes >= 0),
          media_type       TEXT NOT NULL,
          cas_uri          TEXT NOT NULL,
          state            TEXT NOT NULL CHECK(state IN ('staging','candidate','delivered','archived','tombstoned')),
          producer_json    TEXT NOT NULL,
          metadata_json    TEXT NOT NULL DEFAULT '{}',
          created_at       TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(artifact_id, version_no),
          UNIQUE(sha256, artifact_id)
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_versions_hash ON artifact_versions(sha256);
        CREATE INDEX IF NOT EXISTS idx_artifact_versions_state ON artifact_versions(state, created_at DESC);

        CREATE TABLE IF NOT EXISTS artifact_refs (
          ref_id               TEXT PRIMARY KEY,
          artifact_version_id  TEXT NOT NULL REFERENCES artifact_versions(version_id) ON DELETE CASCADE,
          ref_type             TEXT NOT NULL CHECK(ref_type IN ('case_input','case_output','evidence','citation','memory','knowledge','delivery')),
          owner_id             TEXT NOT NULL,
          locator_json         TEXT,
          created_at           TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(artifact_version_id, ref_type, owner_id, locator_json)
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_refs_owner ON artifact_refs(ref_type, owner_id);

        CREATE TABLE IF NOT EXISTS artifact_edges (
          edge_id          TEXT PRIMARY KEY,
          from_version_id  TEXT NOT NULL REFERENCES artifact_versions(version_id),
          to_version_id    TEXT NOT NULL REFERENCES artifact_versions(version_id),
          relation         TEXT NOT NULL CHECK(relation IN ('derived_from','transformed_from','validated_by','supersedes','contains')),
          metadata_json    TEXT NOT NULL DEFAULT '{}',
          created_at       TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(from_version_id, to_version_id, relation),
          CHECK(from_version_id <> to_version_id)
        );

        CREATE TABLE IF NOT EXISTS artifact_leases (
          lease_id             TEXT PRIMARY KEY,
          artifact_version_id  TEXT NOT NULL REFERENCES artifact_versions(version_id) ON DELETE CASCADE,
          holder               TEXT NOT NULL,
          purpose              TEXT NOT NULL,
          expires_at           TEXT NOT NULL,
          released_at          TEXT,
          created_at           TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_leases_active
          ON artifact_leases(artifact_version_id, expires_at) WHERE released_at IS NULL;
      `);
    },
  },
  {
    version: 27,
    name: "evidence_ledger",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS evidence_records (
          evidence_id         TEXT PRIMARY KEY,
          case_id             TEXT NOT NULL REFERENCES cases(case_id),
          evidence_type       TEXT NOT NULL CHECK(evidence_type IN ('source','extraction','transform','assertion','delivery')),
          artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(version_id),
          locator_json        TEXT,
          producer_json       TEXT NOT NULL,
          input_refs_json     TEXT NOT NULL DEFAULT '[]',
          output_hash         TEXT NOT NULL,
          confidence          REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
          uncertainty_json    TEXT,
          policy_decision_id  TEXT NOT NULL,
          created_at          TEXT NOT NULL,
          CHECK(evidence_type <> 'source' OR locator_json IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_records_case
          ON evidence_records(case_id, evidence_type, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_records_artifact
          ON evidence_records(artifact_version_id, evidence_type);

        CREATE TABLE IF NOT EXISTS claims (
          claim_id          TEXT PRIMARY KEY,
          case_id           TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          statement         TEXT NOT NULL,
          structured_json   TEXT,
          status            TEXT NOT NULL CHECK(status IN ('candidate','verified','contradicted','superseded')),
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_claims_case_status ON claims(case_id, status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS claim_evidence (
          claim_id     TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
          evidence_id  TEXT NOT NULL REFERENCES evidence_records(evidence_id),
          role         TEXT NOT NULL DEFAULT 'supports' CHECK(role IN ('supports','contradicts','context')),
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (claim_id, evidence_id, role)
        );

        CREATE TABLE IF NOT EXISTS citation_records (
          citation_id         TEXT PRIMARY KEY,
          claim_id            TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
          artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(version_id),
          locator_json        TEXT NOT NULL,
          quote_hash          TEXT NOT NULL,
          created_at          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_citation_records_claim ON citation_records(claim_id, created_at);

        CREATE TABLE IF NOT EXISTS assertion_results (
          assertion_id        TEXT NOT NULL,
          case_id             TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          validator_id        TEXT NOT NULL,
          status              TEXT NOT NULL CHECK(status IN ('passed','failed','unverified','not_applicable')),
          blocking            INTEGER NOT NULL CHECK(blocking IN (0,1)),
          evidence_id         TEXT REFERENCES evidence_records(evidence_id),
          details_json        TEXT NOT NULL DEFAULT '{}',
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (case_id, assertion_id)
        );
        CREATE INDEX IF NOT EXISTS idx_assertion_results_gate
          ON assertion_results(case_id, blocking, status);
      `);
    },
  },
  {
    version: 28,
    name: "governed_memory_v2",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_records_v2 (
          memory_id             TEXT PRIMARY KEY,
          kind                  TEXT NOT NULL CHECK(kind IN ('working','episodic','semantic','procedural','feedback')),
          scope_json            TEXT NOT NULL,
          scope_tenant_id       TEXT,
          scope_principal_id    TEXT,
          scope_case_id         TEXT,
          scope_role_id         TEXT,
          entity_refs_json      TEXT NOT NULL DEFAULT '[]',
          effective_period_json TEXT,
          period_start          TEXT,
          period_end            TEXT,
          content_json          TEXT NOT NULL,
          conflict_key          TEXT NOT NULL,
          source_evidence_json  TEXT NOT NULL,
          confidence            REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
          sensitivity           TEXT NOT NULL CHECK(sensitivity IN ('public','internal','confidential','restricted')),
          approval_status       TEXT NOT NULL CHECK(approval_status IN ('candidate','approved','rejected','expired')),
          supersedes_json       TEXT NOT NULL DEFAULT '[]',
          conflicts_with_json   TEXT NOT NULL DEFAULT '[]',
          created_at            TEXT NOT NULL,
          last_used_at          TEXT,
          expires_at            TEXT,
          owner_json            TEXT NOT NULL,
          content_hash          TEXT NOT NULL,
          revision              INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
          CHECK(scope_tenant_id IS NOT NULL OR scope_principal_id IS NOT NULL OR scope_case_id IS NOT NULL OR scope_role_id IS NOT NULL),
          CHECK((period_start IS NULL AND period_end IS NULL) OR (period_start IS NOT NULL AND period_end IS NOT NULL)),
          CHECK(expires_at IS NULL OR expires_at > created_at)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_v2_scope_status
          ON memory_records_v2(scope_tenant_id, scope_principal_id, scope_role_id, approval_status, kind);
        CREATE INDEX IF NOT EXISTS idx_memory_v2_case_status
          ON memory_records_v2(scope_case_id, approval_status, kind);
        CREATE INDEX IF NOT EXISTS idx_memory_v2_conflict
          ON memory_records_v2(conflict_key, approval_status, period_start, period_end);
        CREATE INDEX IF NOT EXISTS idx_memory_v2_expiry
          ON memory_records_v2(approval_status, expires_at) WHERE expires_at IS NOT NULL;

        CREATE TABLE IF NOT EXISTS memory_relations_v2 (
          from_memory_id TEXT NOT NULL REFERENCES memory_records_v2(memory_id) ON DELETE CASCADE,
          to_memory_id   TEXT NOT NULL REFERENCES memory_records_v2(memory_id) ON DELETE CASCADE,
          relation       TEXT NOT NULL CHECK(relation IN ('supersedes','conflicts_with')),
          created_at     TEXT NOT NULL,
          PRIMARY KEY(from_memory_id, to_memory_id, relation),
          CHECK(from_memory_id <> to_memory_id)
        );

        CREATE TABLE IF NOT EXISTS memory_access_log_v2 (
          access_id       TEXT PRIMARY KEY,
          memory_id       TEXT NOT NULL,
          principal_json  TEXT NOT NULL,
          action          TEXT NOT NULL CHECK(action IN ('created','selected','approved','rejected','expired','corrected','deletion_requested','deleted','retained')),
          reason          TEXT,
          evidence_json   TEXT NOT NULL DEFAULT '[]',
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_access_log_memory
          ON memory_access_log_v2(memory_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS memory_deletion_requests_v2 (
          request_id        TEXT PRIMARY KEY,
          memory_id         TEXT NOT NULL,
          requester_json    TEXT NOT NULL,
          status            TEXT NOT NULL CHECK(status IN ('completed','retained')),
          retention_reason  TEXT,
          deletion_proof    TEXT,
          requested_at      TEXT NOT NULL,
          completed_at      TEXT,
          CHECK(
            (status = 'completed' AND deletion_proof IS NOT NULL AND completed_at IS NOT NULL AND retention_reason IS NULL)
            OR
            (status = 'retained' AND retention_reason IS NOT NULL AND deletion_proof IS NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS idx_memory_deletion_requests_memory
          ON memory_deletion_requests_v2(memory_id, requested_at DESC);

        CREATE TABLE IF NOT EXISTS memory_migration_log_v2 (
          source_kind      TEXT NOT NULL,
          source_id        TEXT NOT NULL,
          memory_id        TEXT NOT NULL REFERENCES memory_records_v2(memory_id) ON DELETE CASCADE,
          source_hash      TEXT NOT NULL,
          migrated_at     TEXT NOT NULL,
          PRIMARY KEY(source_kind, source_id)
        );
      `);
    },
  },
  {
    version: 29,
    name: "retrieval_v2",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS retrieval_documents (
          document_id          TEXT PRIMARY KEY,
          artifact_id          TEXT NOT NULL REFERENCES artifacts(artifact_id),
          artifact_version_id  TEXT NOT NULL REFERENCES artifact_versions(version_id),
          content_hash         TEXT NOT NULL,
          title                TEXT NOT NULL,
          document_type        TEXT NOT NULL,
          entity_refs_json     TEXT NOT NULL DEFAULT '[]',
          period_start         TEXT,
          period_end           TEXT,
          effective_date       TEXT,
          classification       TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','restricted')),
          parser_version       TEXT NOT NULL,
          chunker_version      TEXT NOT NULL,
          embedding_model      TEXT NOT NULL,
          permission_revision  INTEGER NOT NULL DEFAULT 1 CHECK(permission_revision > 0),
          index_status         TEXT NOT NULL CHECK(index_status IN ('queued','indexing','ready','failed','stale','revoked')),
          error_code           TEXT,
          error_message        TEXT,
          indexed_at           TEXT,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL,
          UNIQUE(artifact_version_id, parser_version, chunker_version, embedding_model),
          CHECK((period_start IS NULL AND period_end IS NULL) OR (period_start IS NOT NULL AND period_end IS NOT NULL)),
          CHECK(
            (index_status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL)
            OR
            (index_status <> 'failed' AND error_code IS NULL AND error_message IS NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS idx_retrieval_documents_filter
          ON retrieval_documents(index_status, document_type, effective_date, period_start, period_end);
        CREATE INDEX IF NOT EXISTS idx_retrieval_documents_hash
          ON retrieval_documents(content_hash, parser_version, chunker_version, embedding_model);

        CREATE TABLE IF NOT EXISTS retrieval_document_acl (
          document_id    TEXT NOT NULL REFERENCES retrieval_documents(document_id) ON DELETE CASCADE,
          principal_type TEXT NOT NULL CHECK(principal_type IN ('user','agent','service')),
          principal_id   TEXT NOT NULL,
          tenant_id      TEXT NOT NULL DEFAULT '',
          granted_at     TEXT NOT NULL,
          revoked_at     TEXT,
          PRIMARY KEY(document_id, principal_type, principal_id, tenant_id)
        );
        CREATE INDEX IF NOT EXISTS idx_retrieval_acl_active
          ON retrieval_document_acl(principal_type, principal_id, tenant_id, document_id)
          WHERE revoked_at IS NULL;

        CREATE TABLE IF NOT EXISTS retrieval_ingestion_jobs (
          job_id          TEXT PRIMARY KEY,
          document_id     TEXT NOT NULL REFERENCES retrieval_documents(document_id) ON DELETE CASCADE,
          status          TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','retryable','canceled')),
          attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
          lease_owner     TEXT,
          lease_expires_at TEXT,
          error_code      TEXT,
          error_message   TEXT,
          queued_at       TEXT NOT NULL,
          started_at      TEXT,
          completed_at    TEXT,
          updated_at      TEXT NOT NULL,
          CHECK(
            (status IN ('failed','retryable') AND error_code IS NOT NULL AND error_message IS NOT NULL)
            OR
            (status NOT IN ('failed','retryable') AND error_code IS NULL AND error_message IS NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS idx_retrieval_jobs_claim
          ON retrieval_ingestion_jobs(status, queued_at, lease_expires_at);

        CREATE TABLE IF NOT EXISTS retrieval_chunks (
          chunk_id            TEXT PRIMARY KEY,
          document_id         TEXT NOT NULL REFERENCES retrieval_documents(document_id) ON DELETE CASCADE,
          artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(version_id),
          parent_chunk_id      TEXT REFERENCES retrieval_chunks(chunk_id) ON DELETE CASCADE,
          ordinal              INTEGER NOT NULL CHECK(ordinal >= 0),
          node_type            TEXT NOT NULL CHECK(node_type IN ('document','section','paragraph','list','table','table_row','sheet','sheet_range','page','code')),
          depth                INTEGER NOT NULL DEFAULT 0 CHECK(depth >= 0),
          heading              TEXT,
          text                 TEXT NOT NULL,
          text_hash            TEXT NOT NULL,
          locator_json         TEXT NOT NULL,
          char_start           INTEGER NOT NULL CHECK(char_start >= 0),
          char_end             INTEGER NOT NULL CHECK(char_end > char_start),
          token_count          INTEGER NOT NULL CHECK(token_count >= 0),
          embedding            BLOB,
          embedding_dim        INTEGER CHECK(embedding_dim IS NULL OR embedding_dim > 0),
          active               INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
          created_at           TEXT NOT NULL,
          UNIQUE(document_id, ordinal),
          CHECK((embedding IS NULL AND embedding_dim IS NULL) OR (embedding IS NOT NULL AND embedding_dim IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_document
          ON retrieval_chunks(document_id, active, ordinal);
        CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_parent
          ON retrieval_chunks(parent_chunk_id, active);

        CREATE TABLE IF NOT EXISTS retrieval_chunk_edges (
          from_chunk_id TEXT NOT NULL REFERENCES retrieval_chunks(chunk_id) ON DELETE CASCADE,
          to_chunk_id   TEXT NOT NULL REFERENCES retrieval_chunks(chunk_id) ON DELETE CASCADE,
          relation      TEXT NOT NULL CHECK(relation IN ('parent','next','previous','table_header','same_section')),
          PRIMARY KEY(from_chunk_id, to_chunk_id, relation),
          CHECK(from_chunk_id <> to_chunk_id)
        );

        CREATE TABLE IF NOT EXISTS retrieval_lexical_terms (
          term       TEXT NOT NULL,
          chunk_id   TEXT NOT NULL REFERENCES retrieval_chunks(chunk_id) ON DELETE CASCADE,
          term_freq  INTEGER NOT NULL CHECK(term_freq > 0),
          PRIMARY KEY(term, chunk_id)
        );
        CREATE INDEX IF NOT EXISTS idx_retrieval_lexical_chunk
          ON retrieval_lexical_terms(chunk_id);

        CREATE TABLE IF NOT EXISTS retrieval_ann_buckets (
          model       TEXT NOT NULL,
          band_no     INTEGER NOT NULL CHECK(band_no >= 0),
          bucket_hash TEXT NOT NULL,
          chunk_id    TEXT NOT NULL REFERENCES retrieval_chunks(chunk_id) ON DELETE CASCADE,
          PRIMARY KEY(model, band_no, bucket_hash, chunk_id)
        );
        CREATE INDEX IF NOT EXISTS idx_retrieval_ann_chunk
          ON retrieval_ann_buckets(chunk_id);

        CREATE TABLE IF NOT EXISTS retrieval_query_cache (
          cache_key              TEXT PRIMARY KEY,
          principal_fingerprint  TEXT NOT NULL,
          permission_fingerprint TEXT NOT NULL,
          query_hash             TEXT NOT NULL,
          result_json            TEXT NOT NULL,
          created_at             TEXT NOT NULL,
          expires_at             TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_retrieval_cache_expiry
          ON retrieval_query_cache(expires_at);
      `);
    },
  },
  {
    version: 30,
    name: "business_case_graph",
    up: (db) => {
      addColumnIfMissing(db, "cases", "case_kind", "TEXT NOT NULL DEFAULT 'financial_consolidation'");
      db.exec(`
        CREATE TABLE IF NOT EXISTS case_business_nodes (
          node_id              TEXT PRIMARY KEY,
          case_id              TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          node_kind            TEXT NOT NULL CHECK(node_kind IN (
            'entity','period','contract','invoice','voucher','obligation','assumption','approval','risk'
          )),
          title                TEXT NOT NULL,
          status               TEXT NOT NULL CHECK(status IN ('active','resolved','superseded','canceled')),
          data_json            TEXT NOT NULL,
          artifact_versions_json TEXT NOT NULL DEFAULT '[]',
          evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_case_business_nodes_kind
          ON case_business_nodes(case_id, node_kind, status);

        CREATE TABLE IF NOT EXISTS case_business_edges (
          case_id          TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          from_node_id     TEXT NOT NULL REFERENCES case_business_nodes(node_id) ON DELETE CASCADE,
          to_node_id       TEXT NOT NULL REFERENCES case_business_nodes(node_id) ON DELETE CASCADE,
          relation         TEXT NOT NULL,
          evidence_ids_json TEXT NOT NULL DEFAULT '[]',
          created_at       TEXT NOT NULL,
          PRIMARY KEY(case_id, from_node_id, to_node_id, relation),
          CHECK(from_node_id <> to_node_id)
        );

        CREATE TABLE IF NOT EXISTS case_run_bindings (
          case_id            TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          run_id             TEXT NOT NULL,
          role_id            TEXT NOT NULL,
          capability_ids_json TEXT NOT NULL,
          state              TEXT NOT NULL CHECK(state IN ('queued','running','waiting_user','succeeded','failed','canceled')),
          started_at         TEXT NOT NULL,
          ended_at           TEXT,
          PRIMARY KEY(case_id, run_id)
        );
        CREATE INDEX IF NOT EXISTS idx_case_run_bindings_state
          ON case_run_bindings(case_id, state, started_at);

        CREATE TABLE IF NOT EXISTS case_deadlines (
          deadline_id        TEXT PRIMARY KEY,
          case_id            TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          obligation_node_id TEXT NOT NULL REFERENCES case_business_nodes(node_id) ON DELETE CASCADE,
          due_at              TEXT NOT NULL,
          remind_at           TEXT,
          status              TEXT NOT NULL CHECK(status IN ('scheduled','notified','completed','canceled','overdue')),
          timezone            TEXT NOT NULL,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_case_deadlines_due
          ON case_deadlines(status, remind_at, due_at);

        CREATE TABLE IF NOT EXISTS case_history_events (
          event_id          TEXT PRIMARY KEY,
          case_id           TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          sequence_no       INTEGER NOT NULL CHECK(sequence_no > 0),
          event_type        TEXT NOT NULL,
          reason            TEXT NOT NULL,
          actor_json        TEXT NOT NULL,
          run_id            TEXT,
          decision_id       TEXT,
          evidence_ids_json TEXT NOT NULL DEFAULT '[]',
          payload_json      TEXT NOT NULL,
          previous_hash     TEXT,
          event_hash        TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          UNIQUE(case_id, sequence_no)
        );
        CREATE INDEX IF NOT EXISTS idx_case_history_sequence
          ON case_history_events(case_id, sequence_no);
      `);
    },
  },
  {
    version: 31,
    name: "research_evidence_foundation",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_plans (
          plan_id       TEXT PRIMARY KEY,
          case_id       TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          provider_id   TEXT NOT NULL,
          plan_json     TEXT NOT NULL,
          status        TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
          error_message TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          CHECK((status='failed' AND error_message IS NOT NULL) OR status<>'failed')
        );
        CREATE INDEX IF NOT EXISTS idx_research_plans_case ON research_plans(case_id, created_at);

        CREATE TABLE IF NOT EXISTS research_snapshots (
          snapshot_id        TEXT PRIMARY KEY,
          plan_id            TEXT NOT NULL REFERENCES research_plans(plan_id) ON DELETE CASCADE,
          candidate_id       TEXT NOT NULL,
          artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(version_id),
          requested_url      TEXT NOT NULL,
          final_url          TEXT NOT NULL,
          fetched_at         TEXT NOT NULL,
          http_status        INTEGER NOT NULL,
          headers_json       TEXT NOT NULL,
          locale             TEXT NOT NULL,
          content_type       TEXT NOT NULL,
          license            TEXT,
          robots_allowed     INTEGER NOT NULL CHECK(robots_allowed IN (0,1)),
          source_class       TEXT NOT NULL,
          rating_json        TEXT NOT NULL,
          taints_json        TEXT NOT NULL,
          content_hash       TEXT NOT NULL,
          UNIQUE(plan_id, candidate_id)
        );
        CREATE INDEX IF NOT EXISTS idx_research_snapshots_plan ON research_snapshots(plan_id, fetched_at);

        CREATE TABLE IF NOT EXISTS research_claim_bindings (
          claim_id       TEXT PRIMARY KEY REFERENCES claims(claim_id) ON DELETE CASCADE,
          evidence_id    TEXT NOT NULL REFERENCES evidence_records(evidence_id),
          citation_id    TEXT NOT NULL REFERENCES citation_records(citation_id),
          snapshot_id    TEXT NOT NULL REFERENCES research_snapshots(snapshot_id),
          topic          TEXT NOT NULL CHECK(topic IN (
            'entity','ownership','people','litigation','penalty','finance','media','related_parties'
          )),
          locator_json   TEXT NOT NULL,
          quote_hash     TEXT NOT NULL,
          status         TEXT NOT NULL CHECK(status IN ('candidate','verified','contradicted'))
        );
        CREATE INDEX IF NOT EXISTS idx_research_claims_snapshot ON research_claim_bindings(snapshot_id, topic);

        CREATE TABLE IF NOT EXISTS research_reports (
          plan_id              TEXT PRIMARY KEY REFERENCES research_plans(plan_id) ON DELETE CASCADE,
          conflicts_json       TEXT NOT NULL,
          coverage_json        TEXT NOT NULL,
          unknowns_json        TEXT NOT NULL,
          rejected_sources_json TEXT NOT NULL,
          created_at           TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 32,
    name: "security_kernel",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS security_acl_grants (
          grant_id            TEXT PRIMARY KEY,
          principal_id        TEXT NOT NULL,
          principal_type      TEXT NOT NULL CHECK(principal_type IN ('user','agent','service')),
          tenant_id           TEXT NOT NULL,
          case_id             TEXT,
          artifact_version_id TEXT,
          capability_id       TEXT,
          actions_json        TEXT NOT NULL,
          grant_json          TEXT NOT NULL,
          expires_at          TEXT,
          revoked_at          TEXT,
          created_at          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_security_acl_match
          ON security_acl_grants(principal_id, principal_type, tenant_id, case_id, capability_id, revoked_at, expires_at);

        CREATE TABLE IF NOT EXISTS security_egress_grants (
          grant_id       TEXT PRIMARY KEY,
          principal_id   TEXT NOT NULL,
          tenant_id      TEXT NOT NULL,
          case_id        TEXT,
          capability_id  TEXT NOT NULL,
          domain         TEXT NOT NULL,
          grant_json     TEXT NOT NULL,
          expires_at     TEXT NOT NULL,
          revoked_at     TEXT,
          created_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_security_egress_match
          ON security_egress_grants(principal_id, tenant_id, case_id, capability_id, domain, revoked_at, expires_at);

        CREATE TABLE IF NOT EXISTS secret_leases (
          lease_id            TEXT PRIMARY KEY,
          secret_id           TEXT NOT NULL,
          principal_json      TEXT NOT NULL,
          capability_id       TEXT NOT NULL,
          destination_domain  TEXT NOT NULL,
          expires_at          TEXT NOT NULL,
          remaining_uses      INTEGER NOT NULL CHECK(remaining_uses >= 0),
          revoked_at          TEXT,
          created_at          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_secret_leases_active
          ON secret_leases(secret_id, capability_id, destination_domain, expires_at, revoked_at);

        CREATE TABLE IF NOT EXISTS quarantine_items (
          quarantine_id      TEXT PRIMARY KEY,
          artifact_id        TEXT NOT NULL,
          artifact_version_id TEXT NOT NULL,
          source_path_hash   TEXT NOT NULL,
          verdict            TEXT NOT NULL CHECK(verdict IN ('pending','clean','malicious','scan_failed')),
          scanner_id         TEXT,
          reason_code        TEXT,
          created_at         TEXT NOT NULL,
          scanned_at         TEXT,
          released_at        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_quarantine_verdict ON quarantine_items(verdict, created_at);

        CREATE TABLE IF NOT EXISTS external_export_requests (
          request_id          TEXT PRIMARY KEY,
          principal_json      TEXT NOT NULL,
          tenant_id           TEXT NOT NULL,
          case_id             TEXT,
          artifact_version_id TEXT NOT NULL,
          capability_id       TEXT NOT NULL,
          destination_domain  TEXT NOT NULL,
          classification      TEXT NOT NULL,
          findings_json       TEXT NOT NULL,
          status              TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','completed')),
          approver_json       TEXT,
          reason              TEXT,
          expires_at          TEXT NOT NULL,
          created_at          TEXT NOT NULL,
          decided_at          TEXT,
          completed_at        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_external_export_authorize
          ON external_export_requests(artifact_version_id, capability_id, destination_domain, status, expires_at);

        CREATE TABLE IF NOT EXISTS security_audit_events (
          event_id       TEXT PRIMARY KEY,
          sequence_no    INTEGER NOT NULL UNIQUE CHECK(sequence_no > 0),
          event_type     TEXT NOT NULL,
          principal_json TEXT NOT NULL,
          tenant_id      TEXT NOT NULL,
          case_id        TEXT,
          capability_id  TEXT,
          payload_json   TEXT NOT NULL,
          previous_hash  TEXT,
          event_hash     TEXT NOT NULL,
          created_at     TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 33,
    name: "artifact_lifecycle_gc",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifact_holds (
          hold_id              TEXT PRIMARY KEY,
          artifact_version_id  TEXT NOT NULL REFERENCES artifact_versions(version_id) ON DELETE CASCADE,
          hold_type            TEXT NOT NULL CHECK(hold_type IN ('legal_hold','pin')),
          owner_id             TEXT NOT NULL,
          reason               TEXT NOT NULL,
          expires_at           TEXT,
          released_at          TEXT,
          created_at           TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_holds_active
          ON artifact_holds(artifact_version_id, hold_type, expires_at, released_at);

        CREATE TABLE IF NOT EXISTS artifact_gc_runs (
          run_id            TEXT PRIMARY KEY,
          mode              TEXT NOT NULL CHECK(mode IN ('dry_run','tombstone','physical_delete')),
          status            TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
          policy_json       TEXT NOT NULL,
          stats_json        TEXT NOT NULL DEFAULT '{}',
          error_message     TEXT,
          started_at        TEXT NOT NULL,
          completed_at      TEXT
        );

        CREATE TABLE IF NOT EXISTS artifact_gc_candidates (
          run_id                TEXT NOT NULL REFERENCES artifact_gc_runs(run_id) ON DELETE CASCADE,
          artifact_version_id   TEXT NOT NULL,
          artifact_id           TEXT NOT NULL,
          sha256                TEXT NOT NULL,
          size_bytes            INTEGER NOT NULL CHECK(size_bytes >= 0),
          reason                TEXT NOT NULL,
          status                TEXT NOT NULL CHECK(status IN ('planned','tombstoned','deleting','deleted','restored','failed')),
          tombstoned_at         TEXT,
          delete_after          TEXT,
          error_message         TEXT,
          PRIMARY KEY(run_id, artifact_version_id)
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_gc_candidates_status
          ON artifact_gc_candidates(status, delete_after);

        CREATE TABLE IF NOT EXISTS artifact_lifecycle_events (
          event_id              TEXT PRIMARY KEY,
          artifact_id           TEXT NOT NULL,
          artifact_version_id   TEXT,
          event_type            TEXT NOT NULL CHECK(event_type IN ('hold','release','gc_plan','tombstone','restore','physical_delete','delete_failed')),
          actor_id              TEXT NOT NULL,
          details_json          TEXT NOT NULL DEFAULT '{}',
          created_at            TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_lifecycle_events_artifact
          ON artifact_lifecycle_events(artifact_id, created_at DESC);
      `);
    },
  },
  {
    version: 34,
    name: "resource_governance",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS resource_budget_scopes (
          scope_id       TEXT PRIMARY KEY,
          scope_type     TEXT NOT NULL CHECK(scope_type IN ('global','case','run')),
          scope_key      TEXT NOT NULL,
          budget_json    TEXT NOT NULL,
          usage_json     TEXT NOT NULL DEFAULT '{}',
          active_count   INTEGER NOT NULL DEFAULT 0 CHECK(active_count >= 0),
          revision       INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
          updated_at     TEXT NOT NULL,
          UNIQUE(scope_type, scope_key)
        );

        CREATE TABLE IF NOT EXISTS resource_reservations (
          reservation_id TEXT PRIMARY KEY,
          run_id          TEXT NOT NULL,
          case_id         TEXT,
          capability_id   TEXT NOT NULL,
          request_json    TEXT NOT NULL,
          usage_json      TEXT NOT NULL DEFAULT '{}',
          status          TEXT NOT NULL CHECK(status IN ('active','released','exhausted','cancelled')),
          created_at      TEXT NOT NULL,
          released_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_resource_reservations_active
          ON resource_reservations(status, run_id, case_id);

        CREATE TABLE IF NOT EXISTS resource_usage_events (
          event_id        TEXT PRIMARY KEY,
          reservation_id TEXT REFERENCES resource_reservations(reservation_id) ON DELETE SET NULL,
          run_id          TEXT NOT NULL,
          case_id         TEXT,
          metric          TEXT NOT NULL,
          delta           INTEGER NOT NULL,
          sampled_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_resource_usage_scope
          ON resource_usage_events(run_id, case_id, metric, sampled_at DESC);

        CREATE TABLE IF NOT EXISTS worker_jobs (
          job_id          TEXT PRIMARY KEY,
          pool_name       TEXT NOT NULL,
          run_id          TEXT NOT NULL,
          case_id         TEXT,
          priority        INTEGER NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','timed_out')),
          payload_hash    TEXT NOT NULL,
          enqueued_at     TEXT NOT NULL,
          started_at      TEXT,
          heartbeat_at    TEXT,
          ended_at        TEXT,
          error_message   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_worker_jobs_queue
          ON worker_jobs(pool_name, status, priority DESC, enqueued_at ASC);

        CREATE TABLE IF NOT EXISTS incremental_cache_entries (
          cache_key           TEXT PRIMARY KEY,
          namespace           TEXT NOT NULL,
          artifact_version_id TEXT REFERENCES artifact_versions(version_id) ON DELETE SET NULL,
          value_json          TEXT,
          size_bytes          INTEGER NOT NULL CHECK(size_bytes >= 0),
          authorization_hash  TEXT NOT NULL,
          created_at          TEXT NOT NULL,
          accessed_at         TEXT NOT NULL,
          expires_at          TEXT,
          hit_count           INTEGER NOT NULL DEFAULT 0 CHECK(hit_count >= 0)
        );
        CREATE INDEX IF NOT EXISTS idx_incremental_cache_lru
          ON incremental_cache_entries(namespace, accessed_at ASC);

        CREATE TABLE IF NOT EXISTS resource_metric_snapshots (
          snapshot_id     TEXT PRIMARY KEY,
          run_id          TEXT,
          case_id         TEXT,
          metrics_json    TEXT NOT NULL,
          captured_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_resource_metrics_time
          ON resource_metric_snapshots(captured_at DESC);
      `);
    },
  },
  {
    version: 35,
    name: "evaluation_observability_and_rollout",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS evaluation_manifests (
          manifest_id     TEXT NOT NULL,
          version         TEXT NOT NULL,
          case_kind       TEXT NOT NULL,
          manifest_json   TEXT NOT NULL,
          manifest_hash   TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          PRIMARY KEY(manifest_id, version)
        );

        CREATE TABLE IF NOT EXISTS evaluation_runs (
          eval_run_id     TEXT PRIMARY KEY,
          manifest_id     TEXT NOT NULL,
          manifest_version TEXT NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('running','passed','failed','error')),
          fault_domain    TEXT CHECK(fault_domain IS NULL OR fault_domain IN
            ('model','capability','dependency','validator','policy','resource','evaluator')),
          result_json     TEXT NOT NULL DEFAULT '{}',
          started_at      TEXT NOT NULL,
          ended_at        TEXT,
          FOREIGN KEY(manifest_id, manifest_version)
            REFERENCES evaluation_manifests(manifest_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_evaluation_runs_manifest
          ON evaluation_runs(manifest_id, manifest_version, started_at DESC);

        CREATE TABLE IF NOT EXISTS evaluation_scorecards (
          scorecard_id    TEXT PRIMARY KEY,
          eval_run_id     TEXT NOT NULL REFERENCES evaluation_runs(eval_run_id) ON DELETE CASCADE,
          dimension       TEXT NOT NULL CHECK(dimension IN ('contract','artifact','evidence','memory','rag','security','performance')),
          score           REAL NOT NULL CHECK(score >= 0 AND score <= 1),
          passed          INTEGER NOT NULL CHECK(passed IN (0,1)),
          details_json    TEXT NOT NULL DEFAULT '{}',
          created_at      TEXT NOT NULL,
          UNIQUE(eval_run_id, dimension)
        );

        CREATE TABLE IF NOT EXISTS foundation_diagnostics (
          snapshot_id     TEXT PRIMARY KEY,
          snapshot_json   TEXT NOT NULL,
          captured_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_foundation_diagnostics_time
          ON foundation_diagnostics(captured_at DESC);

        CREATE TABLE IF NOT EXISTS capability_rollout_epochs (
          epoch           INTEGER PRIMARY KEY AUTOINCREMENT,
          mode            TEXT NOT NULL CHECK(mode IN ('shadow','cutover','rollback')),
          authority       TEXT NOT NULL CHECK(authority IN ('legacy','new')),
          state           TEXT NOT NULL CHECK(state IN ('active','retired')),
          reason          TEXT NOT NULL,
          created_at      TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_rollout_single_active
          ON capability_rollout_epochs(state) WHERE state = 'active';

        CREATE TABLE IF NOT EXISTS capability_shadow_comparisons (
          comparison_id   TEXT PRIMARY KEY,
          case_id         TEXT,
          run_id          TEXT,
          legacy_hash     TEXT NOT NULL,
          new_hash        TEXT NOT NULL,
          equivalent      INTEGER NOT NULL CHECK(equivalent IN (0,1)),
          outcome         TEXT NOT NULL CHECK(outcome IN ('matched','mismatched','inconclusive')),
          details_json    TEXT NOT NULL DEFAULT '{}',
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_capability_shadow_case
          ON capability_shadow_comparisons(case_id, created_at DESC);
      `);
    },
  },
  {
    version: 36,
    name: "knowledge_retrieval_v2_binding",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_retrieval_bindings (
          knowledge_document_id INTEGER PRIMARY KEY
            REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          artifact_id           TEXT NOT NULL REFERENCES artifacts(artifact_id),
          artifact_version_id   TEXT NOT NULL UNIQUE REFERENCES artifact_versions(version_id),
          retrieval_document_id TEXT NOT NULL UNIQUE REFERENCES retrieval_documents(document_id),
          source_content_hash   TEXT NOT NULL,
          indexed_at            TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_artifact
          ON knowledge_retrieval_bindings(artifact_id, artifact_version_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_source_hash
          ON knowledge_retrieval_bindings(source_content_hash);
      `);
    },
  },
  {
    version: 37,
    name: "resource_soak_and_temp_workspace_lifecycle",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS resource_soak_runs (
          run_id                 TEXT PRIMARY KEY,
          contract_hash          TEXT NOT NULL,
          mode                   TEXT NOT NULL CHECK(mode IN ('real','accelerated')),
          status                 TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
          target_wall_ms         INTEGER NOT NULL CHECK(target_wall_ms > 0),
          accumulated_wall_ms    INTEGER NOT NULL DEFAULT 0 CHECK(accumulated_wall_ms >= 0),
          baseline_rss_bytes     INTEGER NOT NULL CHECK(baseline_rss_bytes > 0),
          peak_rss_bytes         INTEGER NOT NULL CHECK(peak_rss_bytes > 0),
          peak_heap_bytes        INTEGER NOT NULL CHECK(peak_heap_bytes >= 0),
          peak_temp_bytes        INTEGER NOT NULL DEFAULT 0 CHECK(peak_temp_bytes >= 0),
          peak_queue_depth       INTEGER NOT NULL DEFAULT 0 CHECK(peak_queue_depth >= 0),
          iterations             INTEGER NOT NULL DEFAULT 0 CHECK(iterations >= 0),
          resume_count           INTEGER NOT NULL DEFAULT 0 CHECK(resume_count >= 0),
          lease_owner_id         TEXT,
          lease_expires_at       TEXT,
          started_at             TEXT NOT NULL,
          last_resumed_at        TEXT NOT NULL,
          last_checkpoint_at     TEXT NOT NULL,
          completed_at           TEXT,
          failure_json           TEXT,
          final_evidence_hash    TEXT
        );

        CREATE TABLE IF NOT EXISTS resource_soak_checkpoints (
          checkpoint_id          TEXT PRIMARY KEY,
          run_id                 TEXT NOT NULL REFERENCES resource_soak_runs(run_id) ON DELETE CASCADE,
          sequence_no            INTEGER NOT NULL CHECK(sequence_no >= 0),
          elapsed_wall_ms        INTEGER NOT NULL CHECK(elapsed_wall_ms >= 0),
          metrics_json           TEXT NOT NULL,
          invariants_json        TEXT NOT NULL,
          prior_checkpoint_hash  TEXT,
          checkpoint_hash        TEXT NOT NULL,
          captured_at            TEXT NOT NULL,
          UNIQUE(run_id, sequence_no),
          UNIQUE(run_id, checkpoint_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_resource_soak_checkpoint_time
          ON resource_soak_checkpoints(run_id, sequence_no DESC);

        CREATE TABLE IF NOT EXISTS resource_temp_workspaces (
          workspace_id       TEXT PRIMARY KEY,
          owner_run_id       TEXT NOT NULL,
          path               TEXT NOT NULL UNIQUE,
          state              TEXT NOT NULL CHECK(state IN ('active','tombstoned','deleted','failed')),
          created_at         TEXT NOT NULL,
          heartbeat_at       TEXT NOT NULL,
          delete_after       TEXT,
          deleted_at         TEXT,
          last_size_bytes    INTEGER NOT NULL DEFAULT 0 CHECK(last_size_bytes >= 0),
          error_message      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_resource_temp_workspace_sweep
          ON resource_temp_workspaces(state, delete_after);
      `);
    },
  },
  {
    version: 38,
    name: "governed_memory_archive_lifecycle",
    up: (db) => {
      addColumnIfMissing(db, "memory_records_v2", "lifecycle_status", "TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_status IN ('active','archived'))");
      addColumnIfMissing(db, "memory_records_v2", "archived_at", "TEXT");
      addColumnIfMissing(db, "memory_records_v2", "archived_reason", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_v2_lifecycle
          ON memory_records_v2(lifecycle_status, approval_status, created_at DESC);
        CREATE TABLE IF NOT EXISTS memory_lifecycle_events_v2 (
          event_id        TEXT PRIMARY KEY,
          memory_id       TEXT NOT NULL,
          principal_json  TEXT NOT NULL,
          action          TEXT NOT NULL CHECK(action IN ('archived','restored')),
          reason          TEXT NOT NULL,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_events_memory
          ON memory_lifecycle_events_v2(memory_id, created_at DESC);
      `);
    },
  },
  {
    version: 39,
    name: "rebuild_manual_memory_conflict_keys",
    up: (db) => {
      type ManualMemoryRow = {
        memory_id: string;
        kind: "working" | "episodic" | "semantic" | "procedural" | "feedback";
        scope_tenant_id: string | null;
        scope_principal_id: string | null;
        scope_case_id: string | null;
        scope_role_id: string | null;
        entity_refs_json: string;
        period_start: string | null;
        period_end: string | null;
        content_json: string;
        content_hash: string;
        approval_status: string;
        lifecycle_status: string;
        conflicts_with_json: string;
        created_at: string;
      };
      const allRows = db.prepare("SELECT * FROM memory_records_v2 ORDER BY memory_id").all() as unknown as ManualMemoryRow[];
      const manualRows = allRows.flatMap((row) => {
        try {
          const content = JSON.parse(row.content_json) as { topic?: unknown };
          if (typeof content.topic !== "string" || !content.topic.trim()) return [];
          return [{ ...row, conflictKey: createManualMemoryConflictKey(row.kind, content.topic) }];
        } catch {
          return [];
        }
      });
      if (manualRows.length === 0) return;

      const manualIds = new Set(manualRows.map((row) => row.memory_id));
      const updateKey = db.prepare("UPDATE memory_records_v2 SET conflict_key = ? WHERE memory_id = ?");
      for (const row of manualRows) updateKey.run(row.conflictKey, row.memory_id);

      db.exec("CREATE TEMP TABLE IF NOT EXISTS memory_conflict_rebuild_ids(memory_id TEXT PRIMARY KEY)");
      db.exec("DELETE FROM memory_conflict_rebuild_ids");
      const insertAffected = db.prepare("INSERT INTO memory_conflict_rebuild_ids(memory_id) VALUES (?)");
      for (const id of manualIds) insertAffected.run(id);
      db.exec(`
        DELETE FROM memory_relations_v2
        WHERE relation = 'conflicts_with'
          AND (
            from_memory_id IN (SELECT memory_id FROM memory_conflict_rebuild_ids)
            OR to_memory_id IN (SELECT memory_id FROM memory_conflict_rebuild_ids)
          );
      `);

      const updateConflicts = db.prepare(
        "UPDATE memory_records_v2 SET conflicts_with_json = ?, revision = revision + 1 WHERE memory_id = ?",
      );
      for (const row of allRows) {
        let current: string[] = [];
        try {
          const parsed = JSON.parse(row.conflicts_with_json || "[]") as unknown;
          if (Array.isArray(parsed)) current = parsed.filter((item): item is string => typeof item === "string");
        } catch {
          current = [];
        }
        const next = current.filter((id) => !manualIds.has(id));
        if (manualIds.has(row.memory_id) || next.length !== current.length) {
          updateConflicts.run(JSON.stringify(next), row.memory_id);
        }
      }

      const scopeOverlaps = (left: string | null, right: string | null) => left === null || right === null || left === right;
      const entitiesOverlap = (leftJson: string, rightJson: string) => {
        const left = JSON.parse(leftJson) as string[];
        const right = JSON.parse(rightJson) as string[];
        if (left.length === 0 && right.length === 0) return true;
        if (left.length === 0 || right.length === 0) return false;
        const rightSet = new Set(right);
        return left.some((id) => rightSet.has(id));
      };
      const periodsOverlap = (left: ManualMemoryRow, right: ManualMemoryRow) => {
        if (!left.period_start || !left.period_end || !right.period_start || !right.period_end) return true;
        return left.period_start <= right.period_end && right.period_start <= left.period_end;
      };
      const active = manualRows.filter((row) => (
        row.lifecycle_status === "active"
        && (row.approval_status === "candidate" || row.approval_status === "approved")
      ));
      const conflicts = new Map<string, Set<string>>(manualRows.map((row) => [row.memory_id, new Set()]));
      const insertRelation = db.prepare(`
        INSERT OR IGNORE INTO memory_relations_v2(from_memory_id, to_memory_id, relation, created_at)
        VALUES (?, ?, 'conflicts_with', ?)
      `);
      for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
        const left = active[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
          const right = active[rightIndex];
          if (left.conflictKey !== right.conflictKey || left.content_hash === right.content_hash) continue;
          if (!scopeOverlaps(left.scope_tenant_id, right.scope_tenant_id)) continue;
          if (!scopeOverlaps(left.scope_principal_id, right.scope_principal_id)) continue;
          if (!scopeOverlaps(left.scope_case_id, right.scope_case_id)) continue;
          if (!scopeOverlaps(left.scope_role_id, right.scope_role_id)) continue;
          if (!periodsOverlap(left, right) || !entitiesOverlap(left.entity_refs_json, right.entity_refs_json)) continue;
          conflicts.get(left.memory_id)?.add(right.memory_id);
          conflicts.get(right.memory_id)?.add(left.memory_id);
          const createdAt = left.created_at >= right.created_at ? left.created_at : right.created_at;
          insertRelation.run(left.memory_id, right.memory_id, createdAt);
          insertRelation.run(right.memory_id, left.memory_id, createdAt);
        }
      }
      for (const [memoryId, ids] of conflicts) {
        updateConflicts.run(JSON.stringify([...ids].sort()), memoryId);
      }
      db.exec("DROP TABLE memory_conflict_rebuild_ids");
    },
  },
  {
    version: 40,
    name: "persist_security_policy_decisions",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS security_policy_decisions (
          decision_id         TEXT PRIMARY KEY,
          principal_id       TEXT NOT NULL,
          principal_type     TEXT NOT NULL CHECK(principal_type IN ('user','agent','service')),
          tenant_id          TEXT NOT NULL,
          case_id            TEXT,
          capability_id      TEXT NOT NULL,
          action             TEXT NOT NULL CHECK(action IN ('read','write','delete','execute','network','export','admin')),
          artifact_version_id TEXT,
          decision           TEXT NOT NULL CHECK(decision IN ('allow','deny','require_approval')),
          request_json       TEXT NOT NULL,
          decision_json      TEXT NOT NULL,
          audit_event_id     TEXT NOT NULL REFERENCES security_audit_events(event_id),
          created_at         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_security_policy_decision_scope
          ON security_policy_decisions(case_id, capability_id, artifact_version_id, decision, created_at);

        INSERT OR IGNORE INTO security_acl_grants
          (grant_id, principal_id, principal_type, tenant_id, case_id, artifact_version_id,
           capability_id, actions_json, grant_json, expires_at, created_at)
        VALUES
          ('builtin-local-agent-turn-write', 'local-user', 'user', 'local', NULL, NULL,
           'agent.turn', '["write"]',
           '{"actions":["write"],"capabilityId":"agent.turn","createdAt":"2026-08-12T00:00:00.000Z","id":"builtin-local-agent-turn-write","principal":{"id":"local-user","tenantId":"local","type":"user"},"tenantId":"local"}',
           NULL, '2026-08-12T00:00:00.000Z'),
          ('builtin-local-memory-source-write', 'local-user', 'user', 'local', NULL, NULL,
           'memory.capture-user-statement', '["write"]',
           '{"actions":["write"],"capabilityId":"memory.capture-user-statement","createdAt":"2026-08-12T00:00:00.000Z","id":"builtin-local-memory-source-write","principal":{"id":"local-user","tenantId":"local","type":"user"},"tenantId":"local"}',
           NULL, '2026-08-12T00:00:00.000Z'),
          ('builtin-local-research-evidence-write', 'local-user', 'user', 'local', NULL, NULL,
           'research.web', '["write"]',
           '{"actions":["write"],"capabilityId":"research.web","createdAt":"2026-08-12T00:00:00.000Z","id":"builtin-local-research-evidence-write","principal":{"id":"local-user","tenantId":"local","type":"user"},"tenantId":"local"}',
           NULL, '2026-08-12T00:00:00.000Z');
      `);
    },
  },
  {
    version: 41,
    name: "research_publication_gate",
    up: (db) => {
      addColumnIfMissing(db, "research_snapshots", "published_at", "TEXT");
      addColumnIfMissing(db, "research_snapshots", "effective_from", "TEXT");
      addColumnIfMissing(db, "research_snapshots", "effective_to", "TEXT");
      addColumnIfMissing(db, "research_reports", "publication_gate_json", "TEXT NOT NULL DEFAULT '{}'");
    },
  },
  {
    version: 42,
    name: "quarantine_file_safety_manifest",
    up: (db) => {
      db.exec(`
        ALTER TABLE quarantine_items RENAME TO quarantine_items_v41;
        CREATE TABLE quarantine_items (
          quarantine_id       TEXT PRIMARY KEY,
          artifact_id         TEXT NOT NULL,
          artifact_version_id TEXT NOT NULL,
          source_path_hash    TEXT NOT NULL,
          verdict             TEXT NOT NULL CHECK(verdict IN ('pending','clean','malicious','scan_failed','policy_blocked')),
          scanner_id          TEXT,
          reason_code         TEXT,
          inspection_json     TEXT,
          created_at          TEXT NOT NULL,
          scanned_at          TEXT,
          released_at         TEXT
        );
        INSERT INTO quarantine_items
          (quarantine_id, artifact_id, artifact_version_id, source_path_hash, verdict,
           scanner_id, reason_code, inspection_json, created_at, scanned_at, released_at)
        SELECT quarantine_id, artifact_id, artifact_version_id, source_path_hash, verdict,
               scanner_id, reason_code, NULL, created_at, scanned_at, released_at
        FROM quarantine_items_v41;
        DROP TABLE quarantine_items_v41;
        CREATE INDEX idx_quarantine_verdict ON quarantine_items(verdict, created_at);
      `);
    },
  },
  {
    version: 43,
    name: "encrypted_file_workspace",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_roots (
          root_id             TEXT PRIMARY KEY,
          display_name        TEXT NOT NULL,
          locator_ciphertext  TEXT NOT NULL,
          locator_nonce       TEXT NOT NULL,
          locator_tag         TEXT NOT NULL,
          locator_hmac        TEXT NOT NULL UNIQUE,
          permission          TEXT NOT NULL CHECK(permission IN ('read','read_write')),
          write_policy        TEXT NOT NULL CHECK(write_policy IN ('output_subdir','confirm_replace')),
          output_subdir       TEXT NOT NULL DEFAULT 'Finwork 输出',
          status              TEXT NOT NULL CHECK(status IN ('active','unavailable','revoked')) DEFAULT 'active',
          created_at          TEXT NOT NULL,
          last_seen_at        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_chunks (
          chunk_id        TEXT PRIMARY KEY,
          size_bytes      INTEGER NOT NULL CHECK(size_bytes >= 0),
          storage_path    TEXT NOT NULL UNIQUE,
          created_at      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_blobs (
          blob_id         TEXT PRIMARY KEY,
          content_hmac    TEXT NOT NULL UNIQUE,
          size_bytes      INTEGER NOT NULL CHECK(size_bytes >= 0),
          media_type      TEXT NOT NULL,
          chunk_count     INTEGER NOT NULL CHECK(chunk_count >= 0),
          created_at      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_blob_chunks (
          blob_id       TEXT NOT NULL REFERENCES workspace_blobs(blob_id) ON DELETE CASCADE,
          ordinal       INTEGER NOT NULL CHECK(ordinal >= 0),
          chunk_id      TEXT NOT NULL REFERENCES workspace_chunks(chunk_id),
          PRIMARY KEY(blob_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_blob_chunks_chunk ON workspace_blob_chunks(chunk_id);

        CREATE TABLE IF NOT EXISTS workspace_assets (
          asset_id           TEXT PRIMARY KEY,
          source_kind        TEXT NOT NULL CHECK(source_kind IN ('managed','external','generated')),
          display_name       TEXT NOT NULL,
          media_type         TEXT NOT NULL,
          workspace_root_id  TEXT REFERENCES workspace_roots(root_id) ON DELETE SET NULL,
          relative_path      TEXT,
          batch_id           TEXT,
          current_version_id TEXT,
          lifecycle_status   TEXT NOT NULL CHECK(lifecycle_status IN ('active','archived','tombstoned')) DEFAULT 'active',
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          UNIQUE(workspace_root_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_assets_name ON workspace_assets(display_name, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workspace_assets_batch ON workspace_assets(batch_id, created_at);

        CREATE TABLE IF NOT EXISTS workspace_asset_versions (
          version_id             TEXT PRIMARY KEY,
          asset_id               TEXT NOT NULL REFERENCES workspace_assets(asset_id) ON DELETE CASCADE,
          version_no             INTEGER NOT NULL CHECK(version_no > 0),
          blob_id                TEXT REFERENCES workspace_blobs(blob_id),
          parent_version_id      TEXT REFERENCES workspace_asset_versions(version_id),
          source_fingerprint_json TEXT NOT NULL DEFAULT '{}',
          created_at             TEXT NOT NULL,
          UNIQUE(asset_id, version_no)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_asset_versions_blob ON workspace_asset_versions(blob_id);

        CREATE TABLE IF NOT EXISTS task_file_refs (
          ref_id       TEXT PRIMARY KEY,
          run_id       TEXT NOT NULL,
          asset_id     TEXT NOT NULL REFERENCES workspace_assets(asset_id),
          version_id   TEXT NOT NULL REFERENCES workspace_asset_versions(version_id),
          role         TEXT NOT NULL CHECK(role IN ('input','output','baseline','evidence')),
          created_at   TEXT NOT NULL,
          UNIQUE(run_id, asset_id, version_id, role)
        );
        CREATE INDEX IF NOT EXISTS idx_task_file_refs_run ON task_file_refs(run_id, role, created_at);

        CREATE TABLE IF NOT EXISTS file_changesets (
          changeset_id       TEXT PRIMARY KEY,
          run_id             TEXT NOT NULL,
          asset_id           TEXT NOT NULL REFERENCES workspace_assets(asset_id),
          base_version_id    TEXT REFERENCES workspace_asset_versions(version_id),
          candidate_version_id TEXT NOT NULL REFERENCES workspace_asset_versions(version_id),
          diff_kind          TEXT NOT NULL,
          diff_json          TEXT NOT NULL,
          validation_json    TEXT NOT NULL,
          status             TEXT NOT NULL CHECK(status IN ('pending','approved','applied','rejected','failed')),
          created_at         TEXT NOT NULL,
          resolved_at        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_file_changesets_run ON file_changesets(run_id, status, created_at);

        CREATE TABLE IF NOT EXISTS chat_message_workspace_roots (
          message_id  INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
          root_id     TEXT NOT NULL REFERENCES workspace_roots(root_id),
          created_at  TEXT NOT NULL,
          PRIMARY KEY(message_id, root_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_message_workspace_roots_root
          ON chat_message_workspace_roots(root_id, message_id);
      `);
      const hasChatAttachments = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='chat_attachments'").get();
      if (hasChatAttachments) {
        addColumnIfMissing(db, "chat_attachments", "asset_id", "TEXT REFERENCES workspace_assets(asset_id)");
        addColumnIfMissing(db, "chat_attachments", "asset_version_id", "TEXT REFERENCES workspace_asset_versions(version_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_chat_attachments_asset ON chat_attachments(asset_id, asset_version_id)");
      }
    },
  },
  {
    version: 44,
    name: "script_execution_provenance",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS script_executions (
          execution_id       TEXT PRIMARY KEY,
          run_id             TEXT NOT NULL,
          script_asset_id    TEXT NOT NULL REFERENCES workspace_assets(asset_id),
          script_version_id  TEXT NOT NULL REFERENCES workspace_asset_versions(version_id),
          sandbox_kind       TEXT NOT NULL,
          args_json          TEXT NOT NULL DEFAULT '[]',
          input_refs_json    TEXT NOT NULL DEFAULT '[]',
          output_manifest_json TEXT NOT NULL DEFAULT '[]',
          status             TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
          exit_code          INTEGER,
          error_message      TEXT,
          started_at         TEXT NOT NULL,
          completed_at       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_script_executions_run
          ON script_executions(run_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_script_executions_script
          ON script_executions(script_asset_id, script_version_id);
      `);
    },
  },
  {
    version: 45,
    name: "work_plan_runtime",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS case_plan_versions (
          plan_id       TEXT PRIMARY KEY,
          case_id       TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          version       INTEGER NOT NULL CHECK(version > 0),
          goal          TEXT NOT NULL,
          reason        TEXT NOT NULL,
          status        TEXT NOT NULL CHECK(status IN
            ('active','superseded','completed','failed','canceled','interrupted')),
          created_by    TEXT NOT NULL CHECK(created_by IN ('deterministic','model','user','recovery')),
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          UNIQUE(case_id, version)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_case_plan_one_active
          ON case_plan_versions(case_id) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_case_plan_case
          ON case_plan_versions(case_id, version DESC);

        CREATE TABLE IF NOT EXISTS case_plan_steps (
          step_id          TEXT PRIMARY KEY,
          plan_id          TEXT NOT NULL REFERENCES case_plan_versions(plan_id) ON DELETE CASCADE,
          step_key         TEXT NOT NULL,
          title            TEXT NOT NULL,
          expected_outcome TEXT NOT NULL,
          status           TEXT NOT NULL CHECK(status IN
            ('pending','ready','running','waiting_user','blocked','verifying',
             'succeeded','failed','skipped','canceled','interrupted')),
          ordinal          INTEGER NOT NULL CHECK(ordinal >= 0),
          user_visible     INTEGER NOT NULL DEFAULT 1 CHECK(user_visible IN (0,1)),
          blocking         INTEGER NOT NULL DEFAULT 1 CHECK(blocking IN (0,1)),
          result_summary   TEXT,
          started_at       TEXT,
          ended_at         TEXT,
          updated_at       TEXT NOT NULL,
          UNIQUE(plan_id, step_key),
          UNIQUE(plan_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_case_plan_steps_status
          ON case_plan_steps(plan_id, status, ordinal);

        CREATE TABLE IF NOT EXISTS case_plan_step_nodes (
          plan_id TEXT NOT NULL REFERENCES case_plan_versions(plan_id) ON DELETE CASCADE,
          step_id TEXT NOT NULL REFERENCES case_plan_steps(step_id) ON DELETE CASCADE,
          node_id TEXT NOT NULL REFERENCES case_nodes(node_id) ON DELETE CASCADE,
          PRIMARY KEY(plan_id, step_id, node_id),
          UNIQUE(plan_id, node_id)
        );

        CREATE TABLE IF NOT EXISTS case_preflight_results (
          preflight_id           TEXT PRIMARY KEY,
          case_id                TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          capability_id          TEXT NOT NULL,
          required               INTEGER NOT NULL CHECK(required IN (0,1)),
          status                 TEXT NOT NULL CHECK(status IN ('available','missing','blocked')),
          candidate_tools_json   TEXT NOT NULL DEFAULT '[]',
          reason                 TEXT NOT NULL,
          checked_at             TEXT NOT NULL,
          UNIQUE(case_id, capability_id)
        );
        CREATE INDEX IF NOT EXISTS idx_case_preflight_case
          ON case_preflight_results(case_id, status, capability_id);
      `);
      const active = db.prepare(`
        SELECT mode,authority FROM capability_rollout_epochs WHERE state='active' LIMIT 1
      `).get() as { mode: string; authority: string } | undefined;
      if (!active || active.mode !== "cutover" || active.authority !== "new") {
        db.prepare("UPDATE capability_rollout_epochs SET state='retired' WHERE state='active'").run();
        db.prepare(`
          INSERT INTO capability_rollout_epochs(mode,authority,state,reason,created_at)
          VALUES ('cutover','new','active',?,?)
        `).run(
          "v45 one-way production authority cutover",
          new Date().toISOString(),
        );
      }
    },
  },
  {
    version: 46,
    name: "bm25_lexical_retrieval",
    up: (db) => {
      const documentColumns = new Set(
        (db.prepare("PRAGMA table_info(retrieval_documents)").all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (documentColumns.has("embedding_model") && !documentColumns.has("index_profile")) {
        db.exec("ALTER TABLE retrieval_documents RENAME COLUMN embedding_model TO index_profile");
      }
      db.exec(`
        UPDATE retrieval_documents SET index_profile='bm25-lexical-v1';

        DROP TABLE IF EXISTS retrieval_chunks_fts;

        CREATE TEMP TABLE retrieval_chunks_v45_backup AS
          SELECT chunk_id,document_id,artifact_version_id,parent_chunk_id,ordinal,node_type,
                 depth,heading,text,text_hash,locator_json,char_start,char_end,token_count,active,created_at
          FROM retrieval_chunks;
        CREATE TEMP TABLE retrieval_edges_v45_backup AS SELECT * FROM retrieval_chunk_edges;
        CREATE TEMP TABLE retrieval_terms_v45_backup AS SELECT * FROM retrieval_lexical_terms;

        DROP TABLE retrieval_chunk_edges;
        DROP TABLE retrieval_lexical_terms;
        DROP TABLE IF EXISTS retrieval_ann_buckets;
        DROP TABLE retrieval_chunks;

        CREATE TABLE retrieval_chunks (
          chunk_id            TEXT PRIMARY KEY,
          document_id         TEXT NOT NULL REFERENCES retrieval_documents(document_id) ON DELETE CASCADE,
          artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(version_id),
          parent_chunk_id      TEXT REFERENCES retrieval_chunks(chunk_id) ON DELETE CASCADE,
          ordinal              INTEGER NOT NULL CHECK(ordinal >= 0),
          node_type            TEXT NOT NULL CHECK(node_type IN ('document','section','paragraph','list','table','table_row','sheet','sheet_range','page','code')),
          depth                INTEGER NOT NULL DEFAULT 0 CHECK(depth >= 0),
          heading              TEXT,
          text                 TEXT NOT NULL,
          text_hash            TEXT NOT NULL,
          locator_json         TEXT NOT NULL,
          char_start           INTEGER NOT NULL CHECK(char_start >= 0),
          char_end             INTEGER NOT NULL CHECK(char_end > char_start),
          token_count          INTEGER NOT NULL CHECK(token_count >= 0),
          active               INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
          created_at           TEXT NOT NULL,
          UNIQUE(document_id, ordinal)
        );
        INSERT INTO retrieval_chunks
          SELECT * FROM retrieval_chunks_v45_backup;
        CREATE INDEX idx_retrieval_chunks_document ON retrieval_chunks(document_id, active, ordinal);
        CREATE INDEX idx_retrieval_chunks_parent ON retrieval_chunks(parent_chunk_id, active);

        CREATE TABLE retrieval_chunk_edges (
          from_chunk_id TEXT NOT NULL REFERENCES retrieval_chunks(chunk_id) ON DELETE CASCADE,
          to_chunk_id   TEXT NOT NULL REFERENCES retrieval_chunks(chunk_id) ON DELETE CASCADE,
          relation      TEXT NOT NULL CHECK(relation IN ('parent','next','previous','table_header','same_section')),
          PRIMARY KEY(from_chunk_id, to_chunk_id, relation),
          CHECK(from_chunk_id <> to_chunk_id)
        );
        INSERT INTO retrieval_chunk_edges SELECT * FROM retrieval_edges_v45_backup;

        CREATE TABLE retrieval_lexical_terms (
          term       TEXT NOT NULL,
          chunk_id   TEXT NOT NULL REFERENCES retrieval_chunks(chunk_id) ON DELETE CASCADE,
          term_freq  INTEGER NOT NULL CHECK(term_freq > 0),
          PRIMARY KEY(term, chunk_id)
        );
        CREATE INDEX idx_retrieval_lexical_chunk ON retrieval_lexical_terms(chunk_id);
        INSERT INTO retrieval_lexical_terms SELECT * FROM retrieval_terms_v45_backup;

        DROP TABLE retrieval_chunks_v45_backup;
        DROP TABLE retrieval_edges_v45_backup;
        DROP TABLE retrieval_terms_v45_backup;

        CREATE VIRTUAL TABLE retrieval_chunks_fts USING fts5(
          chunk_id UNINDEXED,
          body_terms,
          title_terms,
          tokenize='unicode61 remove_diacritics 2'
        );
        INSERT INTO retrieval_chunks_fts(chunk_id, body_terms, title_terms)
        SELECT
          c.chunk_id,
          COALESCE(group_concat(lt.term, ' '), ''),
          lower(
            CASE WHEN c.ordinal=0 OR c.node_type IN ('document','section','sheet','page') THEN d.title || ' ' ELSE '' END
            || COALESCE(c.heading, '')
          )
        FROM retrieval_chunks c
        JOIN retrieval_documents d ON d.document_id=c.document_id
        LEFT JOIN retrieval_lexical_terms lt ON lt.chunk_id=c.chunk_id
        GROUP BY c.chunk_id;

        DROP TABLE IF EXISTS knowledge_embeddings;
        DELETE FROM retrieval_query_cache;
      `);
    },
  },
];

/** 当前代码所知的最新 schema version */
export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * 读取当前 user_version
 */
export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * 设置 user_version(必须用字符串拼接,PRAGMA 不支持 ? 占位)
 */
function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * 幂等地将数据库从当前 user_version 迁移到最新 version。
 *
 * 步骤:
 * 1. 读 user_version
 * 2. 若 < 最新 → 先调用 backupFn(可回滚)
 * 3. 逐条对 version > current 的迁移:事务内 up() + 更新 user_version
 * 4. 任一失败 → 事务回滚 + 抛出(禁止静默吞,红线 4)
 *
 * @param db        已打开的 DatabaseSync 实例
 * @param dbPath    数据库文件绝对路径(传给 backupFn)
 * @param backupFn  备份函数(注入 backupDatabase,解循环引用)
 */
export function runMigrations(
  db: DatabaseSync,
  dbPath: string,
  backupFn: (db: DatabaseSync, dbPath: string) => string | null
): void {
  const current = getUserVersion(db);

  if (current >= LATEST_VERSION) {
    // 已是最新或超前(不降级),no-op
    return;
  }

  // 迁移前先备份(退路)—— backupFn 失败只告警不抛,与现有约定一致
  backupFn(db, dbPath);

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  );

  for (const migration of pending) {
    // 在事务内执行迁移,失败自动回滚
    try {
      db.exec("BEGIN");
      migration.up(db);
      setUserVersion(db, migration.version);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // rollback 失败也要把原错抛出
      }
      throw new Error(
        `迁移 v${migration.version}(${migration.name})失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// 重新导出供外部测试直接使用
export { addColumnIfMissing };
