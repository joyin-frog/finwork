import assert from "node:assert/strict";
import { HISTORICAL_FINANCE_CASES } from "./cases";
import {
  scoreArtifactAssertions,
  selectLatestCompletionEvidence,
  verifyDeliveryContract,
  type ArtifactEvidence,
} from "./scoring";
import type { CompletionEvidence } from "@/lib/agent/run-contract";

const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function artifact(
  deliverableId: string,
  mime: string,
  overrides: Partial<ArtifactEvidence> = {},
): ArtifactEvidence {
  return {
    deliverableId,
    path: `/delivered/${deliverableId}`,
    fileName: deliverableId,
    mime,
    sha256: "a".repeat(64),
    text: "",
    sheetNames: [],
    sheetCount: 0,
    formulaCount: 0,
    formulaErrorCount: 0,
    cellValues: {},
    formulaValues: {},
    diffResults: {},
    ...overrides,
  };
}

const reply = HISTORICAL_FINANCE_CASES.find((item) => item.id === "HISTORY-005")!;
const replyArtifact = artifact("document", docxMime, {
  text: `${"正式经营回复：研发投入、现金情况及待确认事项。".repeat(20)} 520 300 120 80`,
});
assert.equal(verifyDeliveryContract(reply.taskContract, [replyArtifact]).passed, true);
const replyScore = scoreArtifactAssertions(reply, [replyArtifact], false);
assert.equal(replyScore.criticalPassed, true);
assert.equal(replyScore.deterministicScore, 1);
assert.equal(
  verifyDeliveryContract(
    reply.taskContract,
    [artifact("workbook", xlsxMime, { sheetCount: 1 })],
  ).passed,
  false,
);

const forecast = HISTORICAL_FINANCE_CASES.find((item) => item.id === "HISTORY-007")!;
const forecastArtifacts = [
  artifact("workbook", xlsxMime, {
    text: "2026 2027 2028 营收 研发 固定资产",
    sheetNames: ["预测"],
    sheetCount: 1,
    formulaCount: 6,
  }),
  artifact("document", docxMime, {
    text: "预测依据、年度假设及需要管理层确认的事项。",
  }),
];
assert.equal(verifyDeliveryContract(forecast.taskContract, forecastArtifacts).passed, true);
assert.equal(
  scoreArtifactAssertions(forecast, forecastArtifacts, false).criticalPassed,
  true,
);

const tax = HISTORICAL_FINANCE_CASES.find((item) => item.id === "HISTORY-003")!;
const wrongTaxArtifact = artifact("workbook", xlsxMime, {
  text: "全年应纳税所得额 适用税率 速算扣除",
  sheetNames: ["Sheet1"],
  sheetCount: 1,
  formulaCount: 98,
  cellValues: {
    "Sheet1!H5": 940,
    "Sheet1!H10": 0,
    "Sheet1!H18": 0,
  },
});
const wrongTaxScore = scoreArtifactAssertions(tax, [wrongTaxArtifact], true);
assert.equal(wrongTaxScore.criticalPassed, false);
assert.match(
  wrongTaxScore.assertionResults.find((result) => result.id === "tax-real-values")!.actual,
  /H10: expected 140, actual 0/,
);
const correctTaxArtifact = artifact("workbook", xlsxMime, {
  ...wrongTaxArtifact,
  text: "全年应纳税所得额 适用税率 速算扣除 3% 10% 20% 25% 30% 35% 45% 181920",
  cellValues: {
    "Sheet1!H5": 940,
    "Sheet1!H10": 140,
    "Sheet1!H18": 340,
  },
  diffResults: {
    "tax-source-preservation": {
      changedCount: 84,
      allowedChangedCount: 84,
      disallowedChanges: [],
    },
  },
});
assert.equal(scoreArtifactAssertions(tax, [correctTaxArtifact], true).criticalPassed, true);
const truncatedTaxArtifact = artifact("workbook", xlsxMime, {
  ...correctTaxArtifact,
  diffResults: {
    "tax-source-preservation": {
      changedCount: 200,
      allowedChangedCount: 84,
      disallowedChanges: ["Sheet1!A37", "Sheet1!B37"],
    },
  },
});
assert.equal(
  scoreArtifactAssertions(tax, [truncatedTaxArtifact], true).criticalPassed,
  false,
);

const feeCase = HISTORICAL_FINANCE_CASES.find((item) => item.id === "HISTORY-004")!;
const feeFormulaAssertion = feeCase.artifactAssertions.find(
  (item) => item.id === "fee-golden-formulas",
)!;
const correctFeeArtifact = artifact("workbook", xlsxMime, {
  text: "事务费 工资 管理费 折旧",
  formulaCount: 13,
  formulaValues: feeFormulaAssertion.realFormulas,
});
assert.equal(
  scoreArtifactAssertions(feeCase, [correctFeeArtifact], true).criticalPassed,
  true,
);
const missingWageFormulaArtifact = artifact("workbook", xlsxMime, {
  ...correctFeeArtifact,
  formulaValues: {
    ...feeFormulaAssertion.realFormulas,
    "Sheet1!C10": null,
  },
});
assert.equal(
  scoreArtifactAssertions(feeCase, [missingWageFormulaArtifact], true).criticalPassed,
  false,
);

for (const [caseId, assertionId, wrongCell] of [
  ["HISTORY-002", "consolidation-golden-cells", "资产负债表!H59"],
  ["HISTORY-006", "multi-sheet-golden-cells", "资产负债表!H59"],
] as const) {
  const consolidationCase = HISTORICAL_FINANCE_CASES.find((item) => item.id === caseId)!;
  const goldenAssertion = consolidationCase.artifactAssertions.find(
    (item) => item.id === assertionId,
  )!;
  const goldenCells = goldenAssertion.realCells!;
  const correctArtifact = artifact("workbook", xlsxMime, {
    text: "资产负债表 利润表 现金流 抵消 调整分录 补充分录 3811229.5 39250000 18700000 27000000 期初现金",
    sheetNames: ["TB表", "调整分录", "资产负债表", "利润表", "现金流量表"],
    sheetCount: 5,
    formulaCount: 100,
    cellValues: goldenCells,
  });
  assert.equal(
    scoreArtifactAssertions(consolidationCase, [correctArtifact], true).criticalPassed,
    true,
    `${caseId} golden cells should pass`,
  );
  const wrongArtifact = artifact("workbook", xlsxMime, {
    ...correctArtifact,
    cellValues: { ...goldenCells, [wrongCell]: Number(goldenCells[wrongCell]) + 1 },
  });
  const wrongScore = scoreArtifactAssertions(consolidationCase, [wrongArtifact], true);
  assert.equal(wrongScore.criticalPassed, false, `${caseId} unbalanced cells must fail`);
  assert.match(
    wrongScore.assertionResults.find((result) => result.id === assertionId)!.actual,
    new RegExp(wrongCell.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
}

const oldEvidence: CompletionEvidence = {
  runId: "run",
  contractDeliverableId: "document",
  deliveredPath: "/delivered/old.docx",
  deliveredSha256: "1".repeat(64),
  mime: docxMime,
  validatorId: "docx_generic",
  qualityProfile: "generic",
  validationStatus: "passed",
  validatedAt: "2026-01-01T00:00:00.000Z",
  reportId: "old",
};
const latestEvidence: CompletionEvidence = {
  ...oldEvidence,
  deliveredPath: "/delivered/latest.docx",
  deliveredSha256: "2".repeat(64),
  validatedAt: "2026-01-01T00:00:01.000Z",
  reportId: "latest",
};
assert.deepEqual(
  selectLatestCompletionEvidence(reply.taskContract, [latestEvidence, oldEvidence]),
  [latestEvidence],
);

console.log("historical-finance-eval scoring: artifact contracts and assertions ✓");
