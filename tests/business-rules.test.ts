import assert from "node:assert/strict";
import {
  BusinessRuleRegistry,
  financeRuleDefinitions,
  registerFinanceRulePack,
} from "@/lib/business-rules";

const ARTIFACT_SHA256 = "a".repeat(64);

export const businessRulesTestPromise = (async () => {
  const registry = new BusinessRuleRegistry();
  registerFinanceRulePack(registry);
  assert.equal(registry.list().length, financeRuleDefinitions.length);
  assert.deepEqual(
    [...new Set(registry.list().map((rule) => rule.category))].sort(),
    ["consolidation", "data_quality", "fx", "payroll", "period", "statement_tie", "table_merge", "tax", "voucher"],
  );
  for (const definition of registry.list()) {
    assert.ok(definition.version);
    assert.ok(definition.source.authority);
    assert.equal(definition.jurisdiction, "CN");
    assert.ok(definition.tolerance.absolute >= 0);
  }

  const passed = registry.evaluate("balance-sheet-equation", "2026.1", { assets: 100, liabilities: 60, equity: 40 }, ARTIFACT_SHA256, "2026-06-30");
  assert.equal(passed.status, "passed");
  assert.equal(passed.artifactSha256, ARTIFACT_SHA256);
  const failed = registry.evaluate("balance-sheet-equation", "2026.1", { assets: 100, liabilities: 70, equity: 40 }, ARTIFACT_SHA256, "2026-06-30");
  assert.equal(failed.status, "failed");
  const unverifiable = registry.evaluate("balance-sheet-equation", "2026.1", { assets: 100 }, ARTIFACT_SHA256, "2026-06-30");
  assert.equal(unverifiable.status, "unverifiable");
  const notApplicable = registry.evaluate("balance-sheet-equation", "2026.1", { assets: 100, liabilities: 60, equity: 40 }, ARTIFACT_SHA256, "2019-12-31");
  assert.equal(notApplicable.status, "not_applicable");
  assert.equal(registry.resolve("balance-sheet-equation", "2026-06-30", "CN").version, "2026.1");
  assert.equal(registry.evaluateEffective("balance-sheet-equation", { assets: 100, liabilities: 60, equity: 40 }, ARTIFACT_SHA256, "2026-06-30", "CN").status, "passed");
  assert.throws(() => registry.resolve("balance-sheet-equation", "2019-12-31", "CN"), /no_effective_rule/);

  const ruleCases = [
    ["consolidation-scope", { expectedEntityIds: ["parent", "sub-a", "sub-b"], includedEntityIds: ["parent", "sub-a"], excludedEntitiesWithReason: { "sub-b": "disposed before reporting date" } }],
    ["consolidation-elimination", { counterpartyDebit: 1_000, counterpartyCredit: 1_000, recordedElimination: 1_000 }],
    ["unrealized-profit", { transferRevenue: 1_000, carryingCost: 800, remainingInventoryRate: 0.25, recordedElimination: 50 }],
    ["nci-allocation", { subsidiaryProfit: 1_000, parentOwnershipRate: 0.8, recordedNciProfit: 200 }],
    ["fx-translation", { sourceAmount: 100, exchangeRate: 7.2, translatedAmount: 720 }],
    ["tax-rate-basic", { taxableBase: 100_000, applicableRate: 0.25, recordedTax: 25_000 }],
    ["payroll-basic", { grossPay: 50_000, deductions: 8_000, recordedNetPay: 42_000 }],
    ["cash-rollforward", { openingCash: 100, netCashMovement: 20, endingCash: 120 }],
    ["retained-earnings-rollforward", { openingRetainedEarnings: 100, netProfit: 30, appropriations: 5, dividends: 10, endingRetainedEarnings: 115 }],
    ["investment-equity-elimination", { parentInvestment: 800, parentShareOfNetAssets: 800, recordedElimination: 800 }],
    ["intercompany-revenue-cost-elimination", { sellerRevenue: 1_000, buyerRecognizedCost: 1_000, recordedElimination: 1_000 }],
    ["vat-payable", { outputVat: 100, inputVatCreditable: 70, carriedCredit: 5, recordedVatPayable: 25 }],
    ["current-income-tax", { taxableIncome: 100, applicableRate: 0.25, taxCredits: 5, recordedCurrentTax: 20 }],
    ["payroll-employer-contribution", { contributionBase: 100, employerRate: 0.2, recordedEmployerContribution: 20 }],
    ["voucher-required-fields", { voucherNumber: "记-1", documentDate: "2026-06-30", postingPeriod: "2026-06", summary: "销售收入" }],
    ["voucher-period-alignment", { postingPeriod: "2026-06", documentDate: "2026-06-30" }],
    ["voucher-unique-number", { rows: [{ entity: "A", postingPeriod: "2026-06", voucherNumber: "记-1" }] }],
    ["ar-aging-total", { receivableTotal: 100, currentBucket: 20, days31To90: 20, days91To180: 20, days181To365: 20, over365: 20 }],
    ["table-merge-key-uniqueness", { rows: [{ source: "A", label: "Cash" }, { source: "B", label: "Cash" }] }],
  ] as const;
  for (const [ruleId, facts] of ruleCases) {
    const assertion = registry.evaluate(ruleId, "2026.1", facts, ARTIFACT_SHA256, "2026-06-30");
    assert.equal(assertion.status, "passed", `${ruleId} should be computed from source facts`);
    assert.equal(Object.hasOwn(assertion.facts, "valid"), false, `${ruleId} must not accept a caller verdict`);
  }
  assert.equal(registry.evaluate("tax-rate-basic", "2026.1", { taxableBase: 100_000, applicableRate: 0.25, recordedTax: 20_000 }, ARTIFACT_SHA256, "2026-06-30").status, "failed");
  assert.equal(registry.evaluate("payroll-basic", "2026.1", { grossPay: 50_000, deductions: 8_000 }, ARTIFACT_SHA256, "2026-06-30").status, "unverifiable");
  assert.equal(registry.evaluate("fx-translation", "2026.1", { sourceAmount: 100, exchangeRate: 0, translatedAmount: 0 }, ARTIFACT_SHA256, "2026-06-30").status, "unverifiable");
  assert.equal(registry.evaluate("consolidation-scope", "2026.1", { expectedEntityIds: ["a", "b"], includedEntityIds: ["a"], excludedEntitiesWithReason: {} }, ARTIFACT_SHA256, "2026-06-30").status, "failed");
  assert.equal(registry.evaluate("voucher-period-alignment", "2026.1", { postingPeriod: "2026-07", documentDate: "2026-06-30" }, ARTIFACT_SHA256, "2026-06-30").status, "failed");
  assert.equal(registry.evaluate("voucher-unique-number", "2026.1", { rows: [{ entity: "A", postingPeriod: "2026-06", voucherNumber: "1" }, { entity: "A", postingPeriod: "2026-06", voucherNumber: "1" }] }, ARTIFACT_SHA256, "2026-06-30").status, "failed");

  console.log("business-rules tests passed");
})();
