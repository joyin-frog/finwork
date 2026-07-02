// 总览页派活入口与关注区空态引导文案。
// 全仓库唯一允许写引导 prompt 文案的文件；文案按财务日历窗口轮换，务实简短。

import type { CalendarContext } from "./tax-calendar";

export type CockpitSuggestions = {
  /** 派活输入框占位文案 */
  placeholder: string;
  /** 关注区空态补充提示 */
  attentionEmptyHint: string;
};

export function getCockpitSuggestions(calendar: CalendarContext): CockpitSuggestions {
  if (calendar.windows.includes("tax_filing") && calendar.primaryWindow === "tax_filing") {
    const daysLeft = calendar.deadlines[0]?.daysLeft ?? 0;
    return {
      placeholder:
        daysLeft <= 3
          ? `申报截止还有 ${daysLeft} 天：让税务专员跑一遍申报前检查…`
          : "报税期：让税务专员跑一遍申报前检查，核对个税与增值税数据",
      attentionEmptyHint: "当前无紧急事项，可提前让税务专员备好申报数据",
    };
  }

  if (calendar.windows.includes("payroll_prep")) {
    return {
      placeholder: "算薪窗口：让薪酬专员计算本月工资和个税…",
      attentionEmptyHint: "临近发薪日，可提前发起算薪任务",
    };
  }

  if (calendar.windows.includes("closing")) {
    return {
      placeholder: "月末结账：让账务专员核对发票收齐与计提…",
      attentionEmptyHint: "处于结账窗口，可发起月末核对任务",
    };
  }

  // 平峰
  return {
    placeholder: "有什么财务问题？让专员帮你处理…",
    attentionEmptyHint: "当前节点无需处理的事，可趁平峰做经营分析或税务筹划",
  };
}
