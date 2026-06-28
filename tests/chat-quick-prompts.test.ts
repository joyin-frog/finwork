import assert from "node:assert/strict";
import { getChatQuickPrompts } from "../lib/domain/tax-calendar.ts";

function main() {
  // ── AC10a: 报税期(6/12)→ 申报类提示排第一,含剩余天数 ──
  const filing = getChatQuickPrompts(new Date(2026, 5, 12));
  assert.ok(filing.length >= 2 && filing.length <= 3, "AC10 FAIL: 应返回 2-3 条");
  assert.equal(filing[0].label, "申报前数据复核", "AC10 FAIL: 报税期申报复核必须排第一");
  assert.ok(filing[0].hint?.includes("3 天"), `AC10 FAIL: 提示应含剩余天数,实际:${filing[0].hint}`);
  // 6/12 同时处于算薪窗口(发薪日 15 前 5 天)
  assert.ok(filing.some((p) => p.label === "计算本月工资"), "AC10 FAIL: 算薪窗口应有算薪入口");

  // ── AC10b: 截止日当天 → 提示措辞为"今天是" ──
  const dueDay = getChatQuickPrompts(new Date(2026, 5, 15));
  assert.ok(dueDay[0].hint?.includes("今天是"), "AC10 FAIL: 截止日当天措辞应为今天是");

  // ── AC10c: 非报税期(6/20)→ 不含申报提示;平峰兜底按 P2/P3 优先、报销降级、合同提炼不入对话 ──
  const offPeak = getChatQuickPrompts(new Date(2026, 5, 20));
  assert.ok(!offPeak.some((p) => p.label === "申报前数据复核"), "AC10 FAIL: 非报税期不应出申报提示");
  assert.ok(offPeak.length >= 2 && offPeak.length <= 3);
  assert.ok(offPeak.some((p) => p.label === "经营分析"), "AC10 FAIL: 平峰日兜底应含经营分析(P2)");
  assert.ok(offPeak.some((p) => p.label === "查税务优惠"), "AC10 FAIL: 平峰日兜底应含税务优惠(P3)");
  assert.ok(!offPeak.some((p) => p.label === "查报销制度"), "AC10 FAIL: 查报销制度已移除(报销仅留核对入口)");

  // ── AC10d: 月末(6/28)→ 含结账清单 ──
  const closing = getChatQuickPrompts(new Date(2026, 5, 28));
  assert.ok(closing.some((p) => p.label === "月末结账清单"), "AC10 FAIL: 结账窗口应有结账入口");

  // 每条都必须可直接发送(prompt 非空)
  for (const p of [...filing, ...offPeak, ...closing]) {
    assert.ok(p.prompt.trim().length > 0, "AC10 FAIL: prompt 不可为空");
  }

  console.log("chat-quick-prompts: all 4 checks passed ✓");
}

main();
