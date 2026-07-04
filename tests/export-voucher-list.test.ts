import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// C. export_voucher_list MCP 工具:三 sheet xlsx 生成 + 借贷平衡校验拒绝 + 维度校验
// 通过 mockSdk 捕获 handler,直接调用;不依赖运行中的 MCP server。

// 与工具同源解析解释器(env 优先,回落 workers/.venv):裸 "python3" 在 CI 上没有 openpyxl
import { getPythonPath } from "../lib/runtime/paths";
const PYTHON_PATH = getPythonPath();
const PROJECT_ROOT = path.resolve(new URL("../", import.meta.url).pathname);

export const exportVoucherListTestPromise = (async () => {
  // ── 构建 mockSdk,捕获所有注册的工具 handler ──
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const mockSdk = {
    tool: (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, handler);
      return {};
    },
  };

  // 用临时输出目录(经 createKingdeeTools 闭包注入,与生产 buildFinanceMcpServers 同路径)
  const outputDir = path.join(os.tmpdir(), `evl-test-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // 动态导入 createKingdeeTools,让它注册 export_voucher_list
  const { createKingdeeTools } = await import("../lib/agent/mcp-tools/kingdee-tools.ts");
  createKingdeeTools(mockSdk as never, outputDir);

  const handler = handlers.get("export_voucher_list");
  assert.ok(handler, "C0 FAIL: export_voucher_list 工具未注册");

  // 准备测试凭证数据
  const vouchers = [
    {
      file: "结息单.pdf",
      date: "2024-06-30",
      status: "auto",
      lines: [
        { summary: "利息收入", account: "6603.02", accountName: "财务费用-利息收入", creditYuan: 26.34 },
        { summary: "收款", account: "1002.01", accountName: "银行存款-浦发", dimensionType: "银行账号", dimensionValue: "浦发银行闸北支行", debitYuan: 26.34 },
      ],
    },
    {
      file: "差旅报销.pdf",
      date: "2024-06-28",
      status: "auto",
      lines: [
        { summary: "住宿费", account: "6602.04", accountName: "管理费用-旅差费", dimensionType: "部门", dimensionValue: "综合部", debitYuan: 3700 },
        { summary: "付款", account: "1002", accountName: "银行存款", creditYuan: 3700 },
      ],
    },
    {
      // needs_confirm 不得混入对照清单/汇总口径,只进「待确认与跳过」sheet(H2);
      // 且故意不平衡(50≠40):待确认凭证本就不完整,不应阻断确认凭证的导出(P2 评论)
      file: "待确认单.pdf",
      date: "2024-06-29",
      status: "needs_confirm",
      issues: ["科目待确认:「测试摘要」"],
      lines: [
        { summary: "测试摘要", account: "", debitYuan: 50 },
        { summary: "付款", account: "1002", accountName: "银行存款", creditYuan: 40 },
      ],
    },
  ];

  const skipped = [
    { file: "不明单据.jpg", reason: "金额无法识别", summary: "来源不明", amountYuan: 0 },
  ];

  const chart = [
    { code: "6603.02", name: "财务费用-利息收入", type: "费用" },
    { code: "1002.01", name: "银行存款-浦发", type: "资产", dimension: "银行账号" },
    { code: "6602.04", name: "管理费用-旅差费", type: "费用", dimension: "部门" },
    { code: "1002", name: "银行存款", type: "资产" },
  ];

  const fileName = "测试凭证清单.xlsx";

  try {
    // ── C1: 正常路径 → 生成 xlsx,三 sheet 存在 ──
    const result = await handler({
      vouchers,
      skipped,
      chart,
      fileName,
    }) as { content: Array<{ text: string }>; isError?: boolean };

    // 不应返回 isError
    assert.ok(!result.isError, `C1 FAIL: 正常路径不应返回 isError。内容:${result.content?.[0]?.text?.slice(0, 300)}`);

    // 找到生成的 xlsx 文件路径
    const parsed = JSON.parse(result.content[0].text) as { filePath?: string; fileName?: string };
    const xlsxPath = parsed.filePath;
    assert.ok(xlsxPath && existsSync(xlsxPath), `C1 FAIL: xlsx 文件不存在:${xlsxPath}`);

    // 用 openpyxl 读回验证三个 sheet
    const verifyCode = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(r"${xlsxPath}")
sheets = wb.sheetnames
# 读第一 sheet 前3行
ws1 = wb[sheets[0]]
rows = list(ws1.iter_rows(values_only=True))
sheet1_text = "|".join(str(c) for r in rows for c in r if c is not None)
ws3 = wb["待确认与跳过"]
sheet3_text = "|".join(str(c) for r in ws3.iter_rows(values_only=True) for c in r if c is not None)
print(json.dumps({"sheets": sheets, "sheet1_rows": len(rows), "sheet1_header": list(rows[0]) if rows else [], "sheet1_text": sheet1_text, "sheet3_text": sheet3_text}))
`;
    const verifyOut = execFileSync(PYTHON_PATH, ["-c", verifyCode], {
      encoding: "utf-8",
      env: { ...process.env, PYTHONUTF8: "1" },
    }).trim();
    const { sheets, sheet1_rows, sheet1_text, sheet3_text } = JSON.parse(verifyOut) as {
      sheets: string[]; sheet1_rows: number; sheet1_text: string; sheet3_text: string;
    };

    assert.ok(sheets.includes("对照清单"), `C1 FAIL: 缺少「对照清单」sheet,实际 sheets:${JSON.stringify(sheets)}`);
    assert.ok(sheets.includes("汇总"), `C1 FAIL: 缺少「汇总」sheet`);
    assert.ok(sheets.includes("待确认与跳过"), `C1 FAIL: 缺少「待确认与跳过」sheet`);
    assert.ok(sheet1_rows >= 3, `C1 FAIL: 对照清单至少有表头+2凭证行,实际${sheet1_rows}行`);
    // H2: needs_confirm 凭证不进对照清单,只进待确认 sheet
    assert.ok(!sheet1_text.includes("待确认单.pdf"), "C1-H2 FAIL: needs_confirm 凭证不应出现在对照清单");
    assert.ok(sheet3_text.includes("待确认单.pdf"), "C1-H2 FAIL: needs_confirm 凭证应出现在待确认与跳过 sheet");

    // ── C2: 借贷不平衡 → isError,不落文件 ──
    const unbalancedVouchers = [
      {
        file: "不平衡.pdf",
        date: "2024-06-30",
        status: "auto",
        lines: [
          { summary: "费用", account: "6602.04", debitYuan: 100 },
          { summary: "付款", account: "1002", creditYuan: 99 }, // 故意不平
        ],
      },
    ];
    const c2Result = await handler({
      vouchers: unbalancedVouchers,
      fileName: "不平衡测试.xlsx",
    }) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(c2Result.isError, "C2 FAIL: 借贷不平衡应返回 isError");
    assert.ok(c2Result.content[0].text.includes("不平衡"), `C2 FAIL: 错误信息应含「不平衡」,实际:${c2Result.content[0].text.slice(0, 200)}`);

    // ── C3: 维度错误(无核算维度科目填了维度)→ isError ──
    const dimErrVouchers = [
      {
        file: "维度错.pdf",
        date: "2024-06-30",
        status: "auto",
        lines: [
          { summary: "利息收入", account: "6603.02", dimensionType: "部门", dimensionValue: "财务部", creditYuan: 26.34 },
          { summary: "收款", account: "1002.01", debitYuan: 26.34 },
        ],
      },
    ];
    const c3Result = await handler({
      vouchers: dimErrVouchers,
      chart,
      fileName: "维度错.xlsx",
    }) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(c3Result.isError, "C3 FAIL: 维度错误应返回 isError");
    assert.ok(c3Result.content[0].text.includes("6603.02"), `C3 FAIL: 错误信息应含违规科目 6603.02`);

    // ── C4: 同名重复导出 → 版本化 _v2,不原地覆盖上一份交付物(P2 评论) ──
    const c4Result = await handler({ vouchers, skipped, chart, fileName }) as {
      isError?: boolean; content: Array<{ text: string }>;
    };
    assert.ok(!c4Result.isError, `C4 FAIL: 重复导出不应报错:${c4Result.content?.[0]?.text?.slice(0, 200)}`);
    const c4Parsed = JSON.parse(c4Result.content[0].text) as { filePath: string; fileName: string };
    assert.ok(c4Parsed.fileName.includes("_v2"), `C4 FAIL: 第二次导出应版本化 _v2,实际 ${c4Parsed.fileName}`);
    assert.ok(existsSync(c4Parsed.filePath), "C4 FAIL: _v2 文件应存在");
    assert.ok(existsSync(path.join(outputDir, fileName)), "C4 FAIL: 第一份文件不应被覆盖删除");

  } finally {
    // 清理临时目录
    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log("export-voucher-list: 三 sheet 生成/平衡校验拒绝/维度校验拒绝 ✓");
})();
