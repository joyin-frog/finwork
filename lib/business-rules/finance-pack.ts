import type { RuleDefinition, RuleEvaluator } from "./contracts";
import { BusinessRuleRegistry, businessRuleRegistry } from "./engine";

const source = { authority: "Finwork deterministic finance rule pack", reference: "spec-agent-capability-foundation/WP7", publishedAt: "2026-08-09" };
const base = { version: "2026.1", source, jurisdiction: "CN", effectivePeriod: { from: "2020-01-01", to: null }, tolerance: { absolute: 0.01, relative: 0.0001 } } as const;

type EvaluatorResult = ReturnType<RuleEvaluator>;

function locators(facts: Record<string, unknown>): string[] {
  return Array.isArray(facts.locators) ? facts.locators.map(String) : [];
}

function finiteFacts(
  facts: Record<string, unknown>,
  keys: string[],
): { values: Record<string, number> } | { error: EvaluatorResult } {
  const values: Record<string, number> = {};
  for (const key of keys) {
    if (typeof facts[key] !== "number" || !Number.isFinite(facts[key])) {
      return {
        error: {
          status: "unverifiable",
          message: `Fact ${key} must be a finite number`,
          facts: { invalidFact: key },
          locators: locators(facts),
        },
      };
    }
    values[key] = facts[key];
  }
  return { values };
}

function toleranceFor(expected: number, definition: RuleDefinition): number {
  return Math.max(definition.tolerance.absolute, Math.abs(expected) * definition.tolerance.relative);
}

function computedAmountRule(request: {
  inputKeys: string[];
  recordedKey: string;
  label: string;
  compute: (values: Record<string, number>) => number;
  validate?: (values: Record<string, number>) => string | undefined;
}): RuleEvaluator {
  return (facts, definition) => {
    const parsed = finiteFacts(facts, [...request.inputKeys, request.recordedKey]);
    if ("error" in parsed) return parsed.error;
    const validationError = request.validate?.(parsed.values);
    if (validationError) {
      return { status: "unverifiable", message: validationError, facts: parsed.values, locators: locators(facts) };
    }
    const expected = request.compute(parsed.values);
    const recorded = parsed.values[request.recordedKey]!;
    const difference = recorded - expected;
    const tolerance = toleranceFor(expected, definition);
    const passed = Math.abs(difference) <= tolerance;
    return {
      status: passed ? "passed" : "failed",
      message: passed ? `${request.label}: ties` : `${request.label}: recorded amount differs by ${difference}`,
      facts: { ...parsed.values, expected, recorded, difference, tolerance },
      locators: locators(facts),
    };
  };
}

function numericTie(leftKey: string, rightKeys: string[]): RuleEvaluator {
  return (facts, definition) => {
    const parsed = finiteFacts(facts, [leftKey, ...rightKeys]);
    if ("error" in parsed) return parsed.error;
    const left = parsed.values[leftKey]!;
    const right = rightKeys.reduce((total, key) => total + parsed.values[key]!, 0);
    const difference = left - right;
    const tolerance = toleranceFor(left, definition);
    const passed = Math.abs(difference) <= tolerance;
    return { status: passed ? "passed" : "failed", message: passed ? `${leftKey} ties` : `${leftKey} differs by ${difference}`, facts: { [leftKey]: left, right, difference, tolerance }, locators: locators(facts) };
  };
}

function requiredStringFields(keys: string[], label: string): RuleEvaluator {
  return (facts) => {
    const invalid = keys.filter((key) => typeof facts[key] !== "string" || !(facts[key] as string).trim());
    return {
      status: invalid.length ? "failed" : "passed",
      message: invalid.length ? `${label}: missing or invalid ${invalid.join(", ")}` : `${label}: complete`,
      facts: { checkedFields: keys, invalidFields: invalid },
      locators: locators(facts),
    };
  };
}

function uniqueCompositeKey(keys: string[]): RuleEvaluator {
  return (facts): EvaluatorResult => {
    const rows = Array.isArray(facts.rows) ? facts.rows : null;
    if (!rows || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      return { status: "unverifiable", message: "rows must be an array of records", facts: {} as Record<string, never>, locators: locators(facts) };
    }
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    rows.forEach((row, index) => {
      const record = row as Record<string, unknown>;
      const missing = keys.some((key) => record[key] === undefined || record[key] === null || String(record[key]).trim() === "");
      if (missing) return;
      const key = keys.map((field) => String(record[field])).join("\u001f");
      if (seen.has(key)) duplicates.push(`${seen.get(key)! + 1},${index + 1}`);
      else seen.set(key, index);
    });
    return {
      status: duplicates.length ? "failed" : "passed",
      message: duplicates.length ? `Duplicate composite keys at rows ${duplicates.join("; ")}` : "Composite keys are unique",
      facts: { rowCount: rows.length, duplicateRowPairs: duplicates, keyFields: keys },
      locators: locators(facts),
    };
  };
}

function periodAlignmentRule(facts: Record<string, unknown>): EvaluatorResult {
  const postingPeriod = typeof facts.postingPeriod === "string" ? facts.postingPeriod.trim() : "";
  const documentDate = typeof facts.documentDate === "string" ? facts.documentDate.trim() : "";
  const derivedPeriod = /^\d{4}-\d{2}-\d{2}$/.test(documentDate) ? documentDate.slice(0, 7) : "";
  if (!/^\d{4}-\d{2}$/.test(postingPeriod) || !derivedPeriod) {
    return { status: "unverifiable", message: "postingPeriod and documentDate must use YYYY-MM and YYYY-MM-DD", facts: {}, locators: locators(facts) };
  }
  const passed = postingPeriod === derivedPeriod;
  return { status: passed ? "passed" : "failed", message: passed ? "Voucher period matches document date" : `Voucher period ${postingPeriod} differs from ${derivedPeriod}`, facts: { postingPeriod, documentDate, derivedPeriod }, locators: locators(facts) };
}

function consolidationScopeRule(facts: Record<string, unknown>): EvaluatorResult {
  const expected = Array.isArray(facts.expectedEntityIds) ? facts.expectedEntityIds.map(String) : null;
  const included = Array.isArray(facts.includedEntityIds) ? facts.includedEntityIds.map(String) : null;
  const exclusions = facts.excludedEntitiesWithReason;
  if (!expected || !included || typeof exclusions !== "object" || exclusions === null || Array.isArray(exclusions)) {
    return { status: "unverifiable", message: "Consolidation scope facts must contain entity arrays and exclusion reasons", facts: {}, locators: locators(facts) };
  }
  const excluded = Object.entries(exclusions as Record<string, unknown>)
    .filter(([, reason]) => typeof reason === "string" && reason.trim().length > 0)
    .map(([entityId]) => entityId);
  const accountedFor = new Set([...included, ...excluded]);
  const expectedSet = new Set(expected);
  const omitted = expected.filter((entityId) => !accountedFor.has(entityId));
  const unexpected = included.filter((entityId) => !expectedSet.has(entityId));
  const passed = omitted.length === 0 && unexpected.length === 0;
  return {
    status: passed ? "passed" : "failed",
    message: passed ? "Consolidation scope is complete" : `Consolidation scope differs: omitted=${omitted.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    facts: { expectedEntityIds: expected, includedEntityIds: included, excludedEntityIds: excluded, omittedEntityIds: omitted, unexpectedEntityIds: unexpected },
    locators: locators(facts),
  };
}

const definitions: Array<{ definition: RuleDefinition; evaluate: RuleEvaluator }> = [
  { definition: { ...base, id: "balance-sheet-equation", category: "statement_tie", title: "资产负债表恒等式", requiredFacts: ["assets", "liabilities", "equity"] }, evaluate: numericTie("assets", ["liabilities", "equity"]) },
  { definition: { ...base, id: "cash-flow-ending-cash", category: "statement_tie", title: "现金流量表与资产负债表勾稽", requiredFacts: ["cashFlowEndingCash", "balanceSheetCash"] }, evaluate: numericTie("cashFlowEndingCash", ["balanceSheetCash"]) },
  { definition: { ...base, id: "cash-rollforward", category: "statement_tie", title: "现金滚动勾稽", requiredFacts: ["openingCash", "netCashMovement", "endingCash"] }, evaluate: numericTie("endingCash", ["openingCash", "netCashMovement"]) },
  { definition: { ...base, id: "retained-earnings-rollforward", category: "statement_tie", title: "未分配利润滚动勾稽", requiredFacts: ["openingRetainedEarnings", "netProfit", "appropriations", "dividends", "endingRetainedEarnings"] }, evaluate: computedAmountRule({ inputKeys: ["openingRetainedEarnings", "netProfit", "appropriations", "dividends"], recordedKey: "endingRetainedEarnings", label: "未分配利润滚动", compute: (v) => v.openingRetainedEarnings! + v.netProfit! - v.appropriations! - v.dividends! }) },
  { definition: { ...base, id: "notes-statement-tie", category: "statement_tie", title: "附注与报表勾稽", requiredFacts: ["noteAmount", "statementAmount"] }, evaluate: numericTie("noteAmount", ["statementAmount"]) },
  { definition: { ...base, id: "multi-period-rollforward", category: "period", title: "多期间滚动一致性", requiredFacts: ["opening", "movement", "closing"] }, evaluate: numericTie("closing", ["opening", "movement"]) },
  { definition: { ...base, id: "consolidation-scope", category: "consolidation", title: "合并范围完整性", requiredFacts: ["expectedEntityIds", "includedEntityIds", "excludedEntitiesWithReason"] }, evaluate: consolidationScopeRule },
  { definition: { ...base, id: "consolidation-elimination", category: "consolidation", title: "内部交易抵消", requiredFacts: ["counterpartyDebit", "counterpartyCredit", "recordedElimination"] }, evaluate: computedAmountRule({ inputKeys: ["counterpartyDebit", "counterpartyCredit"], recordedKey: "recordedElimination", label: "内部交易抵消", compute: (v) => v.counterpartyDebit!, validate: (v) => Math.abs(v.counterpartyDebit! - v.counterpartyCredit!) > 0.01 ? "Counterparty balances do not agree; elimination amount is not determinable" : undefined }) },
  { definition: { ...base, id: "investment-equity-elimination", category: "consolidation", title: "长期股权投资与权益抵消", requiredFacts: ["parentInvestment", "parentShareOfNetAssets", "recordedElimination"] }, evaluate: computedAmountRule({ inputKeys: ["parentInvestment", "parentShareOfNetAssets"], recordedKey: "recordedElimination", label: "投资权益抵消", compute: (v) => Math.min(v.parentInvestment!, v.parentShareOfNetAssets!), validate: (v) => v.parentInvestment! < 0 || v.parentShareOfNetAssets! < 0 ? "Investment and net assets must be non-negative" : undefined }) },
  { definition: { ...base, id: "intercompany-revenue-cost-elimination", category: "consolidation", title: "内部收入成本抵消", requiredFacts: ["sellerRevenue", "buyerRecognizedCost", "recordedElimination"] }, evaluate: computedAmountRule({ inputKeys: ["sellerRevenue", "buyerRecognizedCost"], recordedKey: "recordedElimination", label: "内部收入成本抵消", compute: (v) => v.sellerRevenue!, validate: (v) => Math.abs(v.sellerRevenue! - v.buyerRecognizedCost!) > 0.01 ? "Seller revenue and buyer cost do not agree" : undefined }) },
  { definition: { ...base, id: "unrealized-profit", category: "consolidation", title: "未实现损益抵消", requiredFacts: ["transferRevenue", "carryingCost", "remainingInventoryRate", "recordedElimination"] }, evaluate: computedAmountRule({ inputKeys: ["transferRevenue", "carryingCost", "remainingInventoryRate"], recordedKey: "recordedElimination", label: "未实现损益抵消", compute: (v) => (v.transferRevenue! - v.carryingCost!) * v.remainingInventoryRate!, validate: (v) => v.remainingInventoryRate! < 0 || v.remainingInventoryRate! > 1 ? "remainingInventoryRate must be between 0 and 1" : undefined }) },
  { definition: { ...base, id: "nci-allocation", category: "consolidation", title: "少数股东权益分配", requiredFacts: ["subsidiaryProfit", "parentOwnershipRate", "recordedNciProfit"] }, evaluate: computedAmountRule({ inputKeys: ["subsidiaryProfit", "parentOwnershipRate"], recordedKey: "recordedNciProfit", label: "少数股东损益分配", compute: (v) => v.subsidiaryProfit! * (1 - v.parentOwnershipRate!), validate: (v) => v.parentOwnershipRate! < 0 || v.parentOwnershipRate! > 1 ? "parentOwnershipRate must be between 0 and 1" : undefined }) },
  { definition: { ...base, id: "fx-translation", category: "fx", title: "外币折算一致性", requiredFacts: ["sourceAmount", "exchangeRate", "translatedAmount"] }, evaluate: computedAmountRule({ inputKeys: ["sourceAmount", "exchangeRate"], recordedKey: "translatedAmount", label: "外币折算", compute: (v) => v.sourceAmount! * v.exchangeRate!, validate: (v) => v.exchangeRate! <= 0 ? "exchangeRate must be positive" : undefined }) },
  { definition: { ...base, id: "tax-rate-basic", category: "tax", title: "税额基础校验", requiredFacts: ["taxableBase", "applicableRate", "recordedTax"] }, evaluate: computedAmountRule({ inputKeys: ["taxableBase", "applicableRate"], recordedKey: "recordedTax", label: "税额", compute: (v) => v.taxableBase! * v.applicableRate!, validate: (v) => v.applicableRate! < 0 || v.applicableRate! > 1 ? "applicableRate must be between 0 and 1" : undefined }) },
  { definition: { ...base, id: "vat-payable", category: "tax", title: "增值税应纳税额校验", requiredFacts: ["outputVat", "inputVatCreditable", "carriedCredit", "recordedVatPayable"] }, evaluate: computedAmountRule({ inputKeys: ["outputVat", "inputVatCreditable", "carriedCredit"], recordedKey: "recordedVatPayable", label: "增值税应纳税额", compute: (v) => Math.max(0, v.outputVat! - v.inputVatCreditable! - v.carriedCredit!), validate: (v) => v.outputVat! < 0 || v.inputVatCreditable! < 0 || v.carriedCredit! < 0 ? "VAT inputs must be non-negative" : undefined }) },
  { definition: { ...base, id: "current-income-tax", category: "tax", title: "当期所得税费用校验", requiredFacts: ["taxableIncome", "applicableRate", "taxCredits", "recordedCurrentTax"] }, evaluate: computedAmountRule({ inputKeys: ["taxableIncome", "applicableRate", "taxCredits"], recordedKey: "recordedCurrentTax", label: "当期所得税", compute: (v) => Math.max(0, v.taxableIncome! * v.applicableRate! - v.taxCredits!), validate: (v) => v.applicableRate! < 0 || v.applicableRate! > 1 || v.taxCredits! < 0 ? "Tax rate must be in [0,1] and credits non-negative" : undefined }) },
  { definition: { ...base, id: "payroll-basic", category: "payroll", title: "薪酬净额校验", requiredFacts: ["grossPay", "deductions", "recordedNetPay"] }, evaluate: computedAmountRule({ inputKeys: ["grossPay", "deductions"], recordedKey: "recordedNetPay", label: "薪酬净额", compute: (v) => v.grossPay! - v.deductions!, validate: (v) => v.grossPay! < 0 || v.deductions! < 0 ? "grossPay and deductions must be non-negative" : undefined }) },
  { definition: { ...base, id: "payroll-employer-contribution", category: "payroll", title: "单位承担社保公积金校验", requiredFacts: ["contributionBase", "employerRate", "recordedEmployerContribution"] }, evaluate: computedAmountRule({ inputKeys: ["contributionBase", "employerRate"], recordedKey: "recordedEmployerContribution", label: "单位社保公积金", compute: (v) => v.contributionBase! * v.employerRate!, validate: (v) => v.contributionBase! < 0 || v.employerRate! < 0 || v.employerRate! > 1 ? "Contribution base/rate is invalid" : undefined }) },
  { definition: { ...base, id: "voucher-balance", category: "voucher", title: "凭证借贷平衡", requiredFacts: ["debit", "credit"] }, evaluate: numericTie("debit", ["credit"]) },
  { definition: { ...base, id: "voucher-required-fields", category: "voucher", title: "凭证必填字段", requiredFacts: ["voucherNumber", "documentDate", "postingPeriod", "summary"] }, evaluate: requiredStringFields(["voucherNumber", "documentDate", "postingPeriod", "summary"], "凭证字段") },
  { definition: { ...base, id: "voucher-period-alignment", category: "voucher", title: "凭证期间一致性", requiredFacts: ["postingPeriod", "documentDate"] }, evaluate: periodAlignmentRule },
  { definition: { ...base, id: "voucher-unique-number", category: "data_quality", title: "凭证号唯一性", requiredFacts: ["rows"] }, evaluate: uniqueCompositeKey(["entity", "postingPeriod", "voucherNumber"]) },
  { definition: { ...base, id: "ar-aging-total", category: "statement_tie", title: "应收账龄汇总勾稽", requiredFacts: ["receivableTotal", "currentBucket", "days31To90", "days91To180", "days181To365", "over365"] }, evaluate: numericTie("receivableTotal", ["currentBucket", "days31To90", "days91To180", "days181To365", "over365"]) },
  { definition: { ...base, id: "table-merge-key-uniqueness", category: "table_merge", title: "合并表标签唯一性", requiredFacts: ["rows"] }, evaluate: uniqueCompositeKey(["source", "label"]) },
];

export function registerFinanceRulePack(registry: BusinessRuleRegistry = businessRuleRegistry): void {
  const existing = new Set(registry.list().map((item) => `${item.id}@${item.version}`));
  for (const item of definitions) if (!existing.has(`${item.definition.id}@${item.definition.version}`)) registry.register(item.definition, item.evaluate);
}

export const financeRuleDefinitions = definitions.map((item) => item.definition);
