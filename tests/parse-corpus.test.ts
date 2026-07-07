/**
 * parse-corpus.test.ts — 解析回归资产（WP11）
 *
 * 策略：
 * - 可解析样本：断言关键内容出现在解析输出（回归锚点，现状即绿）
 * - 拒绝样本：断言抛出且错误含中文引导（先红后绿，GBK 与 column_warnings 两组需先修复才绿）
 * - PII 门控：遍历全部文本类语料，redact(text) === text
 *
 * 标注说明：
 * - [回归锚点] 现状即绿的断言，记录当前解析行为防止退化
 * - [TDD-红] 修复前必须先红的断言（GBK 编码检测、column_warnings）
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseDocument, buildSpreadsheetMirror } from "../lib/knowledge/parsers/index.ts";
import { redact } from "../lib/safety/pii.ts";
import { getPythonPath } from "../lib/runtime/paths.ts";

const CORPUS = path.join(import.meta.dirname, "fixtures/corpus");
const WORKER = path.join(process.cwd(), "workers", "finance_worker.py");

function runAnalyzeCsv(csvPath: string): {
  row_count: number;
  by_category: Record<string, number>;
  warnings: unknown[];
  column_warnings?: string[];
} {
  const pythonPath = getPythonPath();
  const stdout = execFileSync(pythonPath, [WORKER, "analyze-csv", csvPath], { encoding: "utf-8" });
  return JSON.parse(stdout);
}

export const parseCorpusTestPromise = (async () => {
  // ─────────────────────────────────────────────────────────────────────────
  // SECTION A: xlsx 样本（回归锚点——现状即绿）
  // ─────────────────────────────────────────────────────────────────────────

  // [回归锚点] xlsx-offrow-header: 歪表头，数据从第 3 行起
  // buildSpreadsheetMirror 把第 1 行（标题区）当表头，后续行按"表头: 值"格式输出
  // 这意味着第 2 行的列名（"金额/类目/发票号"）会出现在"表头: 值"的值部分
  // 症状记录：第 2 行原本是列名，被当作数据处理（歪表头的解析缺陷锚点）
  {
    const filePath = path.join(CORPUS, "xlsx-offrow-header.xlsx");
    const { text } = await buildSpreadsheetMirror(filePath);
    assert.ok(text.includes("报销明细"), "xlsx-offrow-header: 应包含工作表名'报销明细'");
    // 第 2 行的"金额"列名被当作数据出现，记录歪表头症状
    assert.ok(text.includes("金额"), "xlsx-offrow-header: 应包含第 2 行列名'金额'（被当作数据，歪表头症状锚点）");
    // 第 3 行数值出现在输出中
    assert.ok(text.includes("100") || text.includes("250"), "xlsx-offrow-header: 应包含第 3 行数值");
    console.log("parse-corpus: xlsx-offrow-header ✓");
  }

  // [回归锚点] xlsx-merged-cells: 合并单元格，"财务部"跨两行
  {
    const filePath = path.join(CORPUS, "xlsx-merged-cells.xlsx");
    const { text } = await buildSpreadsheetMirror(filePath);
    assert.ok(text.includes("财务部"), "xlsx-merged-cells: 应包含合并单元格值'财务部'");
    assert.ok(text.includes("INV-2026-010"), "xlsx-merged-cells: 应包含发票号 INV-2026-010");
    assert.ok(text.includes("INV-2026-011"), "xlsx-merged-cells: 应包含发票号 INV-2026-011");
    console.log("parse-corpus: xlsx-merged-cells ✓");
  }

  // [回归锚点] xlsx-multisheet-first-empty: 首 sheet 空，数据在第二 sheet
  {
    const filePath = path.join(CORPUS, "xlsx-multisheet-first-empty.xlsx");
    const { text } = await buildSpreadsheetMirror(filePath);
    assert.ok(text.includes("实际数据"), "xlsx-multisheet-first-empty: 应包含第二工作表名'实际数据'");
    assert.ok(text.includes("INV-2026-020"), "xlsx-multisheet-first-empty: 应包含第二 sheet 数据");
    assert.ok(text.includes("招待费"), "xlsx-multisheet-first-empty: 应包含类目'招待费'");
    console.log("parse-corpus: xlsx-multisheet-first-empty ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION B: 拒绝路径样本（parseDocument 层）
  // ─────────────────────────────────────────────────────────────────────────

  // [TDD-红→绿] csv-gbk-encoding: GBK 编码，UTF-8 读出含 U+FFFD，应抛中文引导错误含"编码"
  // 修复前红：parseDocument text/* 分支直接 readFileSync，不检测 U+FFFD，会静默返回乱码
  {
    const filePath = path.join(CORPUS, "csv-gbk-encoding.csv");
    let threw = false;
    let errorMsg = "";
    try {
      await parseDocument(filePath, "text/csv");
    } catch (e) {
      threw = true;
      errorMsg = (e as Error).message;
    }
    assert.ok(threw, "csv-gbk-encoding: 应抛出错误（GBK 字节 UTF-8 读出含 U+FFFD）");
    assert.ok(
      errorMsg.includes("编码"),
      `csv-gbk-encoding: 错误信息应含"编码"（实际：${errorMsg}）`
    );
    console.log("parse-corpus: csv-gbk-encoding (GBK 编码检测) ✓");
  }

  // [回归锚点] xls-legacy-format: 旧版 .xls，传 mimeType application/vnd.ms-excel
  {
    const filePath = path.join(CORPUS, "xls-legacy-format.xls");
    let threw = false;
    let errorMsg = "";
    try {
      await parseDocument(filePath, "application/vnd.ms-excel");
    } catch (e) {
      threw = true;
      errorMsg = (e as Error).message;
    }
    assert.ok(threw, "xls-legacy-format: 应抛出错误");
    assert.ok(
      errorMsg.includes("不支持") || errorMsg.includes("暂不支持"),
      `xls-legacy-format: 错误应含"不支持"（实际：${errorMsg}）`
    );
    console.log("parse-corpus: xls-legacy-format (拒绝路径) ✓");
  }

  // [回归锚点] unknown-format: 未知扩展名，传 mimeType application/octet-stream
  {
    const filePath = path.join(CORPUS, "unknown-format.bin");
    let threw = false;
    let errorMsg = "";
    try {
      await parseDocument(filePath, "application/octet-stream");
    } catch (e) {
      threw = true;
      errorMsg = (e as Error).message;
    }
    assert.ok(threw, "unknown-format: 应抛出错误");
    assert.ok(
      errorMsg.includes("不支持"),
      `unknown-format: 错误应含"不支持"（实际：${errorMsg}）`
    );
    console.log("parse-corpus: unknown-format (拒绝路径) ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION C: analyze_csv 样本
  // ─────────────────────────────────────────────────────────────────────────

  // [回归锚点] csv-alias-columns: 中文列名，analyze_csv 应视为列名不匹配
  {
    const filePath = path.join(CORPUS, "csv-alias-columns.csv");
    const result = runAnalyzeCsv(filePath);
    // 当前行为：列名不匹配时金额归 0，类目为"未分类"
    assert.equal(result.row_count, 2, "csv-alias-columns: row_count 应为 2");
    // by_category 应为空或全 0（列名不匹配）
    const total = Object.values(result.by_category).reduce((a, b) => a + (b as number), 0);
    assert.equal(total, 0, "csv-alias-columns: 列名不匹配时金额合计应为 0");
    console.log("parse-corpus: csv-alias-columns (alias 列名) ✓");
  }

  // [TDD-红→绿] csv-unmatched-columns: 列名完全不匹配，应有 column_warnings 非空
  // 修复前红：analyze_csv 无 column_warnings 字段
  {
    const filePath = path.join(CORPUS, "csv-unmatched-columns.csv");
    const result = runAnalyzeCsv(filePath);
    assert.equal(result.row_count, 2, "csv-unmatched-columns: row_count 应为 2");
    // by_category 应为空或全 0（列名完全不匹配）
    const total = Object.values(result.by_category).reduce((a, b) => a + (b as number), 0);
    assert.equal(total, 0, "csv-unmatched-columns: 列名不匹配时金额合计应为 0");
    // column_warnings 必须存在且非空
    assert.ok(
      Array.isArray(result.column_warnings) && result.column_warnings.length > 0,
      `csv-unmatched-columns: 应有 column_warnings 非空（实际：${JSON.stringify(result.column_warnings)}）`
    );
    console.log("parse-corpus: csv-unmatched-columns (column_warnings) ✓");
  }

  // [回归锚点] csv-thousand-sep-currency: 千分位+货币符号，analyze_csv 解析应失败（worker 报错退出）
  {
    const filePath = path.join(CORPUS, "csv-thousand-sep-currency.csv");
    let threw = false;
    try {
      runAnalyzeCsv(filePath);
    } catch {
      threw = true;
    }
    assert.ok(threw, "csv-thousand-sep-currency: 千分位货币符号导致 float() 失败，worker 应报错退出");
    console.log("parse-corpus: csv-thousand-sep-currency (parse error) ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION D: PII 门控（遍历全部文本类语料）
  // ─────────────────────────────────────────────────────────────────────────
  // 遍历 corpus 目录内所有 .csv 和 .md 文件（文本可读格式），
  // 以及生成脚本 gen/*.py / gen/*.mjs
  // 对每个文件执行 redact(text) === text，如果不同则说明含 PII

  const textExtensions = new Set([".csv", ".md", ".py", ".mjs", ".ts"]);

  function collectTextFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        results.push(...collectTextFiles(fullPath));
      } else if (textExtensions.has(path.extname(entry).toLowerCase())) {
        results.push(fullPath);
      }
    }
    return results;
  }

  // GBK csv 必须跳过（字节读为 UTF-8 会产生 U+FFFD，不是 PII，但 redact 不会改它）
  // 实际上 GBK 内容读为 UTF-8 后仍然 redact(text) === text，因为 U+FFFD 不是 PII 模式
  // 但要明确标注：我们读的是字节解码文本，不是原始 GBK 内容
  const textFiles = collectTextFiles(CORPUS);
  let piiCheckCount = 0;
  for (const filePath of textFiles) {
    const text = readFileSync(filePath, "utf-8");
    const redacted = redact(text);
    assert.equal(
      redacted,
      text,
      `PII 门控失败：${path.relative(CORPUS, filePath)} 含 PII 模式（redact 改写了内容）`
    );
    piiCheckCount++;
  }
  assert.ok(piiCheckCount > 0, "PII 门控：应至少检查一个文本文件");

  // xlsx 语料经 mirror 文本纳入门控（spec §1：未来样本的防线，与文本类同一判据；
  // buildSpreadsheetMirror 用文件顶部既有 import）
  for (const entry of readdirSync(CORPUS)) {
    if (path.extname(entry).toLowerCase() !== ".xlsx") continue;
    const mirror = (await buildSpreadsheetMirror(path.join(CORPUS, entry))).text;
    assert.equal(
      redact(mirror),
      mirror,
      `PII 门控失败：${entry} 的 mirror 文本含 PII 模式`
    );
    piiCheckCount++;
  }
  console.log(`parse-corpus: PII 门控通过（检查了 ${piiCheckCount} 个文件，含 xlsx mirror）✓`);

  console.log("parse-corpus: 全部断言通过 ✓");
})();
