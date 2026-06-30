import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { getPythonPath, getBundledPluginRoot } from "@/lib/runtime/paths";
import { getAppSetting } from "@/lib/db/sqlite";
import { loadTaxRates } from "@/lib/db/finance-store";
import { makeCalcReceipt, type CalcReceipt } from "@/lib/domain/receipt";
import { redact } from "@/lib/safety/pii";

import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

// Excel/PPT/PDF 的探查与生成已迁到 SDK 原生 skill(agent-skills/) + run_python;
// 这里只保留无法用通用代码替代的确定性财务工具:报销制度读取、税额计算。
export function createFinanceTools(sdk: Sdk, _outputDir: string) {
  void _outputDir;

  const readExpensePolicy = sdk.tool(
    "read_expense_policy",
    "读取公司报销管理制度文件。处理任何报销审核、标准查询、合规判断前必须先调用此工具，不得凭记忆回答报销标准。",
    {
      section: z
        .enum(["全部", "差旅", "餐饮", "招待", "发票", "审批流程"])
        .default("全部")
        .describe("要读取的章节，不确定时传'全部'")
    },
    async (args: { section: "全部" | "差旅" | "餐饮" | "招待" | "发票" | "审批流程" }) => {
      const { policyPath, isExample } = resolveExpensePolicyPath();

      if (!fs.existsSync(policyPath)) {
        return {
          content: [{
            type: "text" as const,
            text: isExample
              ? "尚未导入贵司报销制度，且示例制度文件缺失。请在『设置 → 知识库/制度』导入贵司报销制度，或将 报销管理制度.txt 放到 docs/ 目录下。"
              : `配置的报销制度文件不存在：${policyPath}。请在设置中重新指定，或导入贵司报销制度。`
          }],
          isError: true
        };
      }

      // 未导入贵司制度时用的是示例文件,结论可能与实际标准不符——必须显式告知,不能让用户误以为是自家口径。
      const exampleNotice = isExample
        ? "⚠ 当前使用的是「示例报销制度」，结论可能与贵司实际标准不符。请在『设置 → 知识库/制度』导入贵司制度后再据此判断。\n\n"
        : "";

      const fullText = fs.readFileSync(policyPath, "utf-8");

      if (args.section === "全部") {
        return { content: [{ type: "text" as const, text: exampleNotice + fullText }] };
      }

      const lines = fullText.split("\n");
      const result: string[] = [];
      let capturing = false;

      for (const line of lines) {
        if (line.includes(args.section)) {
          capturing = true;
        } else if (
          capturing &&
          /^(第[一二三四五六七八九十]+[章条]|[一二三四五六七八九十]+、)/.test(line) &&
          !line.includes(args.section)
        ) {
          break;
        }
        if (capturing) result.push(line);
      }

      const text = result.length > 0 ? result.join("\n") : `未找到"${args.section}"章节，返回全文：\n${fullText}`;
      return { content: [{ type: "text" as const, text: exampleNotice + text }] };
    }
  );

  const taxCalculator = sdk.tool(
    "tax_calculator",
    "计算增值税、企业所得税。结果含完整计算过程，便于对账和审计。工资薪金个税请用 calculate_payroll_batch（累计预扣预缴），本工具不提供个税计算。",
    {
      type: z.enum(["vat", "cit"]).describe("税种：vat=增值税 | cit=企业所得税"),
      amount: z.number().describe("金额（元）"),
      vatParams: z
        .object({
          direction: z.enum(["from_tax_exclusive", "from_tax_inclusive"]).describe("from_tax_exclusive=不含税价算含税 | from_tax_inclusive=含税价算税额"),
          rate: z.string().describe("增值税税率(小数),合法集默认 0.13/0.09/0.06/0.03;政策有变可在设置 tax_rates 调整"),
          inputTax: z.number().nullish().describe("进项税额（元），用于计算应纳税额")
        })
        .nullish(),
      citParams: z
        .object({
          rate: z.string().describe("企业所得税法定税率(小数),合法集默认 0.25/0.20/0.15(普通/小微基础/高新);小微实际优惠税负逐年调整、按所选法定税率直算;政策有变可在设置 tax_rates 调整"),
          deductions: z.number().nullish().describe("税前扣除金额（元）")
        })
        .nullish()
    },
    async (args: {
      type: "vat" | "cit";
      amount: number;
      vatParams?: { direction: "from_tax_exclusive" | "from_tax_inclusive"; rate: string; inputTax?: number | null } | null;
      citParams?: { rate: string; deductions?: number | null } | null;
    }) => {
      // 合法税率集走配置(tax-config 默认 + app_settings.tax_rates 覆盖),不写死在枚举里
      const rates = loadTaxRates();
      if (args.type === "vat" && args.vatParams && !rates.vat.includes(args.vatParams.rate)) {
        return { content: [{ type: "text" as const, text: `增值税税率 ${args.vatParams.rate} 不在合法税率集(${rates.vat.join("/")})中;如政策有变,请在设置 tax_rates 调整后重试。` }], isError: true };
      }
      if (args.type === "cit" && args.citParams && !rates.cit.includes(args.citParams.rate)) {
        return { content: [{ type: "text" as const, text: `企业所得税税率 ${args.citParams.rate} 不在合法税率集(${rates.cit.join("/")})中;如政策有变,请在设置 tax_rates 调整后重试。` }], isError: true };
      }
      // 税额计算逻辑在 tax-incentive skill 的固定脚本 tax_calc.py(可直接调;parity 见 selftest_tax_calc.py)
      const script = path.join(getBundledPluginRoot(), "skills", "tax-incentive", "scripts", "tax_calc.py");
      type PyTaxResult = {
        value: number;
        caliberVersion: string;
        steps: Array<{ label: string; expr: string; subtotal: number }>;
      };
      let text: string;
      let pyResult: PyTaxResult | undefined;
      try {
        const out = execFileSync(getPythonPath(), [script], { input: JSON.stringify(args), encoding: "utf-8" });
        const parsed = JSON.parse(out) as { text?: string; result?: PyTaxResult };
        text = parsed.text ?? "参数不完整，请提供对应税种的计算参数。";
        pyResult = parsed.result;
      } catch (e) {
        text = `税额计算脚本执行失败：${e instanceof Error ? e.message : String(e)}`;
      }

      // 功能3: CalcReceipt 直接消费 Python 返回的结构化数值 — TS 不再重算税额（单一真相）
      const now = new Date();
      const asOf = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      let receipt: CalcReceipt | undefined;
      if (pyResult) {
        receipt = makeCalcReceipt({
          value: pyResult.value,
          steps: pyResult.steps.map((s) => ({ label: s.label, expr: s.expr, inputs: {}, subtotal: s.subtotal })),
          source: [],
          basis: { caliberVersion: pyResult.caliberVersion, settlementStatus: "draft", asOf },
          rounding: "half_up",
        });
      }

      return {
        content: [{ type: "text" as const, text: redact(text) }],
        ...(receipt ? { structuredContent: receipt } : {})
      };
    }
  );

  return [readExpensePolicy, taxCalculator];
}

/**
 * 报销制度文件路径:优先用设置中导入的贵司制度(expense_policy_path),
 * 否则回落到内置示例文件,并标记 isExample=true 以便提示用户结论可能不符。
 */
function resolveExpensePolicyPath(): { policyPath: string; isExample: boolean } {
  const configured = getAppSetting("expense_policy_path");
  if (configured && configured.trim() && fs.existsSync(configured.trim())) {
    return { policyPath: configured.trim(), isExample: false };
  }
  // 回退到随 app 打包的示例制度（agent-skills 会进 Tauri resources；docs/ 不会，故不能放 docs）
  return { policyPath: path.join(getBundledPluginRoot(), "skills", "reimbursement-check", "示例报销制度.md"), isExample: true };
}
