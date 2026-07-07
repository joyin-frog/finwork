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
