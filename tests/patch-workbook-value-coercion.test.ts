/**
 * 单测:patch_workbook 对字符串 value 的数值强制转换。
 *
 * 真实事故(2026-08-06,HISTORY-002):模型往 TB表 输入列写金额时序列化成了
 * JSON 字符串("2850.8" 而不是 2850.8),被忠实写成 Excel 文本类型——SUM/ROUND
 * 等公式会静默跳过文本单元格,合计结果比实际少且不报任何错。这是红线2
 * (数值正确性)里最危险的一类:不报错、肉眼在 Excel 里也不容易发现。
 *
 * 已知边界(记录不是回避):6 位以上、无前导零的纯数字字符串(如科目代码
 * "911010")语法上与金额完全无法区分,会被同样转成数值。真实数据里科目
 * 代码是模板自带的静态文本,从未通过这条写入路径被触碰过(这次改动全部
 * 落在数值输入列),所以是已知的理论风险,不是已观测到的损害;如果未来
 * 场景变化,需要给调用方加一个显式的「保持文本」开关。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPythonPath } from "../lib/runtime/paths.ts";

const { equal } = assert;
const WORKER = path.join(process.cwd(), "workers", "finance_worker.py");

function patch(src: string, dst: string, edits: unknown): void {
  execFileSync(getPythonPath(), [WORKER, "patch-workbook", src, dst, JSON.stringify(edits)], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function cellValue(file: string, address: string): { value: unknown; pyType: string } {
  const script = [
    "import json,sys,openpyxl",
    "wb=openpyxl.load_workbook(sys.argv[1],data_only=False)",
    "sn,ad=sys.argv[2].split('!')",
    "v=wb[sn][ad].value",
    "print(json.dumps({'value':v,'pyType':type(v).__name__},ensure_ascii=False))",
  ].join("\n");
  return JSON.parse(
    execFileSync(getPythonPath(), ["-c", script, file, address], { encoding: "utf-8" }),
  );
}

export const patchWorkbookValueCoercionTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "patch-value-coercion-test-"));
  try {
    const seed = path.join(dir, "seed.xlsx");
    execFileSync(
      getPythonPath(),
      ["-c", "import sys,openpyxl\nwb=openpyxl.Workbook(); wb.active['A1']=1\nwb.save(sys.argv[1])", seed],
      { encoding: "utf-8" },
    );

    const out = path.join(dir, "out.xlsx");
    patch(seed, out, [
      { sheet: "Sheet", cell: "B1", value: "2850.8" },
      { sheet: "Sheet", cell: "B2", value: "18156695.88" },
      { sheet: "Sheet", cell: "B3", value: "1,234,567.89" },
      { sheet: "Sheet", cell: "B4", value: "-99.5" },
      { sheet: "Sheet", cell: "B5", value: "0" },
      { sheet: "Sheet", cell: "C1", value: "007" },
      { sheet: "Sheet", cell: "C2", value: "备注:2850.8元" },
      { sheet: "Sheet", cell: "C3", value: true },
      // 18 位纯数字字符串(身份证号数字部分/长单号常见位数,无前导零)——
      // float 只能精确表示到约 16 位,数值化会静默丢精度并改变原始语义。
      { sheet: "Sheet", cell: "D1", value: "110101199001011234" },
    ]);

    // 金额类字符串必须转成数值——这是本次修复要解决的真实事故。
    const b1 = cellValue(out, "Sheet!B1");
    equal(b1.pyType, "float", `数值转换 FAIL: "2850.8" 应写成数值 —— ${JSON.stringify(b1)}`);
    equal(b1.value, 2850.8);

    const b2 = cellValue(out, "Sheet!B2");
    equal(b2.value, 18156695.88, "数值转换 FAIL: 大额数字应保持精度");

    const b3 = cellValue(out, "Sheet!B3");
    equal(b3.pyType, "float", "数值转换 FAIL: 千分位逗号应被识别为数字");
    equal(b3.value, 1234567.89);

    const b4 = cellValue(out, "Sheet!B4");
    equal(b4.value, -99.5, "数值转换 FAIL: 负数应正确解析");

    const b5 = cellValue(out, "Sheet!B5");
    equal(b5.pyType, "int", "数值转换 FAIL: 纯零应转成数值 0");
    equal(b5.value, 0);

    // 前导零字符串必须保持文本——这是账户代码/单号最常见的形态,
    // 数值化会丢掉前导零,是需要主动避免的误伤。
    const c1 = cellValue(out, "Sheet!C1");
    equal(c1.pyType, "str", `前导零保护 FAIL: "007" 不得被转成数值 —— ${JSON.stringify(c1)}`);
    equal(c1.value, "007");

    // 含中文/标点的文本不受影响。
    const c2 = cellValue(out, "Sheet!C2");
    equal(c2.pyType, "str");
    equal(c2.value, "备注:2850.8元");

    // 布尔值不经过字符串转换路径,不受影响。
    const c3 = cellValue(out, "Sheet!C3");
    equal(c3.pyType, "bool");
    equal(c3.value, true);

    // 超长纯数字(18 位)必须保持文本——数值化会丢精度(float 只精确到约 16 位)
    // 且改变身份证号/长单号的原始语义。
    const d1 = cellValue(out, "Sheet!D1");
    equal(d1.pyType, "str", `长数字保护 FAIL: 18 位数字不得被转成数值 —— ${JSON.stringify(d1)}`);
    equal(d1.value, "110101199001011234");

    console.log("patch-workbook-value-coercion: all 9 checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
