import path from "node:path";
import fs from "node:fs";
import type { CompletionEvidence, TaskContract } from "@/lib/agent/run-contract";
import { parseDocument } from "@/lib/knowledge/parsers";
import {
  spreadsheetCompareAllowedCells,
  spreadsheetExtractText,
  spreadsheetInspect,
  spreadsheetInspectCells,
  spreadsheetInspectFormulaCells,
  spreadsheetRecalc,
} from "@/lib/runtime/spreadsheet-runtime";
import { sha256File } from "@/lib/deliverable/hash";
import { findImpossibleShares } from "@/lib/domain/business-sense";
import type {
  HistoricalArtifactAssertion,
  HistoricalFinanceCase,
} from "./cases";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const FORMULA_ERRORS = ["#DIV/0!", "#REF!", "#VALUE!", "#NAME?", "#NULL!", "#NUM!", "#N/A"];

export type ArtifactEvidence = {
  deliverableId: string;
  path: string;
  fileName: string;
  mime: string;
  sha256: string;
  text: string;
  sheetNames: string[];
  sheetCount: number;
  formulaCount: number;
  formulaErrorCount: number;
  cellValues: Record<string, string | number | boolean | null>;
  formulaValues: Record<string, string | null>;
  diffResults: Record<string, {
    changedCount: number;
    allowedChangedCount: number;
    disallowedChanges: string[];
  }>;
  parseError?: string;
};

export type AssertionResult = {
  id: string;
  description: string;
  critical: boolean;
  weight: number;
  passed: boolean;
  /**
   * `unverifiable` = 没测成,不是测挂了。
   *
   * 典型来源:断言要读公式的缓存值,但本机没有重算 Provider,缓存是空的。
   * 把「没测」记成「测挂了」会直接污染能力评分——2026-08-05 的 HISTORY-001
   * 就因此拿到确定性分 0,而它其实交出了一个 1143 条公式的工作簿。
   */
  status: "passed" | "failed" | "unverifiable";
  expected: string;
  actual: string;
};

export async function inspectDeliveredArtifacts(
  evidences: CompletionEvidence[],
  assertions: HistoricalArtifactAssertion[] = [],
  fixtureRoot?: string,
): Promise<ArtifactEvidence[]> {
  return Promise.all(evidences.map(async (evidence) => {
    const base: ArtifactEvidence = {
      deliverableId: evidence.contractDeliverableId,
      path: evidence.deliveredPath,
      fileName: path.basename(evidence.deliveredPath),
      mime: evidence.mime,
      sha256: evidence.deliveredSha256,
      text: "",
      sheetNames: [],
      sheetCount: 0,
      formulaCount: 0,
      formulaErrorCount: 0,
      cellValues: {},
      formulaValues: {},
      diffResults: {},
    };
    try {
      const actualSha256 = sha256File(evidence.deliveredPath);
      if (actualSha256 !== evidence.deliveredSha256) {
        throw new Error(
          `交付证据 hash 已变化: expected ${evidence.deliveredSha256}, actual ${actualSha256}`,
        );
      }
      if (evidence.mime === XLSX_MIME || evidence.deliveredPath.toLowerCase().endsWith(".xlsx")) {
        const inspected = await spreadsheetInspect(evidence.deliveredPath);
        if (!inspected.ok) throw new Error(inspected.detail ?? "工作簿检查失败");
        // openpyxl 全量提取(不用 buildSpreadsheetMirror):后者以「第一行非空
        // 列数」当表头宽度,超出这个宽度的列在任何一行都不会进入文本——
        // 2026-08-06 实测:HISTORY-003 的列标题在第 4 行(第 1 行只有一个
        // 标题格),导致 contains_all 断言读不到已经正确写入的关键词,把
        // 「评测提取不完整」误判成「模型没做对」。buildSpreadsheetMirror
        // 是为知识库 RAG 检索设计的规整表头假设,不适合这里的完整性要求;
        // 现有断言只做子串匹配,不依赖它的「表头: 值」拼接格式,换掉不影响
        // 任何既有 case。
        const extracted = await spreadsheetExtractText(evidence.deliveredPath);
        if (!extracted.ok) {
          throw new Error(extracted.detail ?? "工作簿文本提取失败");
        }
        base.text = extracted.data?.text ?? "";
        const sheets =
          (inspected.data as { sheets?: Array<Record<string, unknown>> } | undefined)?.sheets ?? [];
        base.sheetNames = sheets.map((sheet) => String(sheet.name ?? ""));
        base.sheetCount = sheets.length;
        base.formulaCount = sheets.reduce(
          (sum, sheet) => sum + Number(sheet.formula_count ?? 0),
          0,
        );
        base.formulaErrorCount = sheets.reduce((sum, sheet) => {
          const explicitErrors =
            (sheet.formula_errors as Array<{ cell?: unknown; cached_value?: unknown }> | undefined);
          if (explicitErrors) return sum + explicitErrors.length;
          const formulas =
            (sheet.formulas_sample as Array<{ cached_value?: unknown }> | undefined) ?? [];
          return sum + formulas.filter((formula) => {
            const cachedValue = formula.cached_value;
            return typeof cachedValue === "string" && FORMULA_ERRORS.some((error) => cachedValue.includes(error));
          }).length;
        }, 0);
        const requestedCells = assertions
          .filter((assertion) => assertion.deliverableId === evidence.contractDeliverableId)
          .flatMap((assertion) => [
            ...Object.keys(assertion.cells ?? {}),
            ...Object.keys(assertion.realCells ?? {}),
          ]);
        if (requestedCells.length > 0) {
          const inspectedCells = await spreadsheetInspectCells(
            evidence.deliveredPath,
            [...new Set(requestedCells)],
          );
          if (!inspectedCells.ok) {
            throw new Error(inspectedCells.detail ?? "关键单元格检查失败");
          }
          base.cellValues = inspectedCells.data?.values ?? {};
          if (Object.values(base.cellValues).some((value) => value === null)) {
            const recalculated = await spreadsheetRecalc(evidence.deliveredPath);
            if (recalculated.ok && recalculated.data?.outputPath) {
              try {
                const recalculatedCells = await spreadsheetInspectCells(
                  recalculated.data.outputPath,
                  [...new Set(requestedCells)],
                );
                if (recalculatedCells.ok && recalculatedCells.data) {
                  for (const [address, value] of Object.entries(recalculatedCells.data.values)) {
                    if (base.cellValues[address] === null && value !== null) {
                      base.cellValues[address] = value;
                    }
                  }
                }
              } finally {
                cleanupEvalRecalcRoot(
                  recalculated.data.cleanupRoot,
                  recalculated.data.outputPath,
                );
              }
            }
          }
        }
        const requestedFormulaCells = assertions
          .filter((assertion) => assertion.deliverableId === evidence.contractDeliverableId)
          .flatMap((assertion) => [
            ...Object.keys(assertion.formulas ?? {}),
            ...Object.keys(assertion.realFormulas ?? {}),
            // cells_equal 的地址也要取公式文本:用来区分「公式存在但没有缓存值」
            // (无重算 Provider,应判未验证)和「格子本来就是空的」(应判失败)。
            ...Object.keys(assertion.cells ?? {}),
            ...Object.keys(assertion.realCells ?? {}),
          ]);
        if (requestedFormulaCells.length > 0) {
          const inspectedFormulas = await spreadsheetInspectFormulaCells(
            evidence.deliveredPath,
            [...new Set(requestedFormulaCells)],
          );
          if (!inspectedFormulas.ok) {
            throw new Error(inspectedFormulas.detail ?? "关键公式检查失败");
          }
          base.formulaValues = inspectedFormulas.data?.formulas ?? {};
        }
        if (fixtureRoot) {
          const diffAssertions = assertions.filter((assertion) =>
            assertion.deliverableId === evidence.contractDeliverableId &&
            assertion.kind === "xlsx_only_allowed_cells_changed" &&
            assertion.referenceFixture &&
            assertion.allowedSheet &&
            assertion.allowedColumns?.length
          );
          for (const assertion of diffAssertions) {
            const compared = await spreadsheetCompareAllowedCells(
              path.join(fixtureRoot, assertion.referenceFixture!),
              evidence.deliveredPath,
              assertion.allowedSheet!,
              assertion.allowedColumns!,
            );
            if (!compared.ok || !compared.data) {
              throw new Error(compared.detail ?? "工作簿允许列差异检查失败");
            }
            base.diffResults[assertion.id] = compared.data;
          }
        }
      } else if (
        evidence.mime === DOCX_MIME ||
        evidence.deliveredPath.toLowerCase().endsWith(".docx")
      ) {
        base.text = await parseDocument(evidence.deliveredPath, DOCX_MIME);
      } else {
        base.text = await parseDocument(evidence.deliveredPath, evidence.mime);
      }
    } catch (error) {
      base.parseError = error instanceof Error ? error.message : String(error);
    }
    return base;
  }));
}

/** repair 期间同一合同项可多次 finalize；评分只读取每个合同项最新的 count 个版本。 */
export function selectLatestCompletionEvidence(
  contract: TaskContract,
  evidences: CompletionEvidence[],
): CompletionEvidence[] {
  return contract.requiredDeliverables.flatMap((required) =>
    evidences
      .filter((evidence) => evidence.contractDeliverableId === required.id)
      .sort((a, b) =>
        a.validatedAt.localeCompare(b.validatedAt) ||
        a.reportId.localeCompare(b.reportId)
      )
      .slice(-required.count)
  );
}

export function verifyDeliveryContract(
  contract: TaskContract,
  artifacts: ArtifactEvidence[],
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const required of contract.requiredDeliverables) {
    const matches = artifacts.filter(
      (artifact) =>
        artifact.deliverableId === required.id &&
        mimeCompatible(artifact.mime, required.mime),
    );
    if (matches.length < required.count) {
      failures.push(
        `${required.id}: 需要 ${required.count} 个 ${required.mime}，实际 ${matches.length} 个`,
      );
    }
    for (const artifact of matches) {
      if (artifact.parseError) failures.push(`${required.id}/${artifact.fileName}: ${artifact.parseError}`);
      if (artifact.formulaErrorCount > 0) {
        failures.push(`${required.id}/${artifact.fileName}: 存在 ${artifact.formulaErrorCount} 个公式错误`);
      }
    }
  }
  return { passed: failures.length === 0, failures };
}

export function scoreArtifactAssertions(
  gc: HistoricalFinanceCase,
  artifacts: ArtifactEvidence[],
  realMode: boolean,
): {
  deterministicScore: number;
  criticalPassed: boolean;
  /** 未验证项数量;>0 时不得宣称通过,应收敛到 needs_review。 */
  unverifiableCount: number;
  assertionResults: AssertionResult[];
} {
  const assertionResults = gc.artifactAssertions.map((assertion) =>
    assertion
  ).filter((assertion) =>
    !assertion.appliesTo ||
    assertion.appliesTo === "all" ||
    (realMode ? assertion.appliesTo === "real" : assertion.appliesTo === "synthetic")
  ).map((assertion) => evaluateAssertion(assertion, artifacts, realMode));
  // 未验证项既不进分子也不进分母:让「缺 Provider」不再稀释能力分。
  // criticalPassed 同理只看真正失败的关键项;是否放行由 unverifiableCount 单独决定。
  const scored = assertionResults.filter((result) => result.status !== "unverifiable");
  const totalWeight = scored.reduce((sum, result) => sum + result.weight, 0);
  const passedWeight = scored
    .filter((result) => result.passed)
    .reduce((sum, result) => sum + result.weight, 0);
  return {
    deterministicScore: totalWeight > 0 ? passedWeight / totalWeight : 1,
    criticalPassed: assertionResults.every(
      (result) => !result.critical || result.status !== "failed",
    ),
    unverifiableCount: assertionResults.filter((result) => result.status === "unverifiable").length,
    assertionResults,
  };
}

export function artifactSummaryForJudge(artifacts: ArtifactEvidence[]): string {
  return artifacts.map((artifact) => {
    const excerpt = artifact.text.replace(/\s+/g, " ").slice(0, 12_000);
    const cellEvidence = Object.entries(artifact.cellValues)
      .map(([address, value]) => `${address}=${String(value)}`)
      .join(", ");
    const diffEvidence = Object.entries(artifact.diffResults)
      .map(([assertionId, result]) =>
        `${assertionId}: 总变化=${result.changedCount}, 允许区变化=${result.allowedChangedCount}, ` +
        `越界=${result.disallowedChanges.length}` +
        (result.disallowedChanges.length > 0
          ? ` (${result.disallowedChanges.slice(0, 20).join(", ")})`
          : "")
      )
      .join("\n");
    return [
      `交付物: ${artifact.fileName}`,
      `合同 ID: ${artifact.deliverableId}`,
      `MIME: ${artifact.mime}`,
      `SHA256: ${artifact.sha256}`,
      `工作表: ${artifact.sheetNames.join(", ") || "(not applicable)"}`,
      `公式数: ${artifact.formulaCount}`,
      `公式错误数: ${artifact.formulaErrorCount}`,
      `解析错误: ${artifact.parseError ?? "(none)"}`,
      `已独立读取的关键单元格缓存值: ${cellEvidence || "(none)"}`,
      `已独立读取的关键公式: ${
        Object.entries(artifact.formulaValues)
          .map(([address, formula]) => `${address}=${String(formula)}`)
          .join(", ") || "(none)"
      }`,
      `已独立执行的修改范围检查:\n${diffEvidence || "(none)"}`,
      "注意：文本摘录可能不显示公式缓存值；上面的关键单元格值来自独立 openpyxl/重算检查，评分时应以该证据为准。",
      `产物内容摘录:\n${excerpt}`,
    ].join("\n");
  }).join("\n\n");
}

function evaluateAssertion(
  assertion: HistoricalArtifactAssertion,
  artifacts: ArtifactEvidence[],
  realMode: boolean,
): AssertionResult {
  const targets = artifacts.filter((artifact) => artifact.deliverableId === assertion.deliverableId);
  const values = realMode && assertion.realValues ? assertion.realValues : assertion.values ?? [];
  const combinedText = normalizeText(
    targets.map((artifact) => `${artifact.sheetNames.join(" ")}\n${artifact.text}`).join("\n"),
  );
  const weight = assertion.weight ?? 1;
  const critical = assertion.critical ?? false;
  let passed = false;
  let unverifiable = false;
  let expected = "";
  let actual = "";

  switch (assertion.kind) {
    case "contains_all": {
      const missing = values.filter((value) => !combinedText.includes(normalizeText(value)));
      passed = targets.length > 0 && missing.length === 0;
      expected = `全部包含: ${values.join(", ")}`;
      actual = missing.length ? `缺少: ${missing.join(", ")}` : "全部命中";
      break;
    }
    case "contains_any": {
      const hits = values.filter((value) => combinedText.includes(normalizeText(value)));
      passed = targets.length > 0 && hits.length > 0;
      expected = `至少包含一个: ${values.join(", ")}`;
      actual = hits.length ? `命中: ${hits.join(", ")}` : "无命中";
      break;
    }
    case "xlsx_min_sheets": {
      const count = Math.max(0, ...targets.map((artifact) => artifact.sheetCount));
      passed = count >= (assertion.minimum ?? 0);
      expected = `工作表数 >= ${assertion.minimum ?? 0}`;
      actual = `工作表数 = ${count}`;
      break;
    }
    case "xlsx_min_formulas": {
      const count = Math.max(0, ...targets.map((artifact) => artifact.formulaCount));
      passed = count >= (assertion.minimum ?? 0);
      expected = `公式数 >= ${assertion.minimum ?? 0}`;
      actual = `公式数 = ${count}`;
      break;
    }
    case "xlsx_cells_equal": {
      const cells = realMode && assertion.realCells ? assertion.realCells : assertion.cells ?? {};
      const mismatches: string[] = [];
      // 公式在、缓存值不在 = 没有重算 Provider,这条读不出来,不能算模型答错。
      const staleFormulaCells: string[] = [];
      for (const [address, expectedValue] of Object.entries(cells)) {
        const holder = targets.find((target) =>
          Object.prototype.hasOwnProperty.call(target.cellValues, address)
        );
        const actualValue = holder?.cellValues[address];
        if (cellValuesEqual(actualValue, expectedValue)) continue;
        const formulaText = targets.find((target) =>
          Object.prototype.hasOwnProperty.call(target.formulaValues, address)
        )?.formulaValues[address];
        if ((actualValue === null || actualValue === undefined) && formulaText) {
          staleFormulaCells.push(`${address}(${formulaText})`);
          continue;
        }
        mismatches.push(`${address}: expected ${expectedValue}, actual ${String(actualValue)}`);
      }
      expected = Object.entries(cells).map(([address, value]) => `${address}=${value}`).join(", ");
      if (targets.length > 0 && mismatches.length === 0 && staleFormulaCells.length > 0) {
        unverifiable = true;
        actual = `公式存在但无缓存值，缺重算 Provider，未验证：${staleFormulaCells.join("; ")}`;
        break;
      }
      passed = targets.length > 0 && Object.keys(cells).length > 0 && mismatches.length === 0;
      actual = mismatches.length > 0 ? mismatches.join("; ") : "全部匹配";
      break;
    }
    case "xlsx_formulas_equal": {
      const formulas =
        realMode && assertion.realFormulas ? assertion.realFormulas : assertion.formulas ?? {};
      const mismatches: string[] = [];
      for (const [address, expectedFormula] of Object.entries(formulas)) {
        const actualFormula = targets.find((target) =>
          Object.prototype.hasOwnProperty.call(target.formulaValues, address)
        )?.formulaValues[address];
        if (actualFormula !== expectedFormula) {
          mismatches.push(
            `${address}: expected ${expectedFormula}, actual ${String(actualFormula)}`,
          );
        }
      }
      passed = targets.length > 0 && Object.keys(formulas).length > 0 && mismatches.length === 0;
      expected = Object.keys(formulas).join(", ");
      actual = mismatches.length > 0 ? mismatches.join("; ") : "全部公式匹配";
      break;
    }
    case "xlsx_only_allowed_cells_changed": {
      const diff = targets.find((target) => target.diffResults[assertion.id])?.diffResults[
        assertion.id
      ];
      passed = Boolean(
        diff &&
        diff.disallowedChanges.length === 0 &&
        diff.allowedChangedCount >= (assertion.minimum ?? 1)
      );
      expected =
        `仅 ${assertion.allowedSheet} 的 ${assertion.allowedColumns?.join(",") ?? ""} 列可变` +
        `，且允许区至少变化 ${assertion.minimum ?? 1} 个单元格`;
      actual = diff
        ? `总变化 ${diff.changedCount}，允许区 ${diff.allowedChangedCount}，越界 ${diff.disallowedChanges.length}` +
          (diff.disallowedChanges.length
            ? ` (${diff.disallowedChanges.slice(0, 8).join(", ")})`
            : "")
        : "未生成工作簿差异证据";
      break;
    }
    case "docx_min_chars": {
      const count = Math.max(0, ...targets.map((artifact) => artifact.text.trim().length));
      passed = count >= (assertion.minimum ?? 0);
      expected = `正文字符数 >= ${assertion.minimum ?? 0}`;
      actual = `正文字符数 = ${count}`;
      break;
    }
    case "no_impossible_share": {
      // 用原始 text 而非 normalizeText:后者去掉空白和逗号会破坏语境窗口与摘录。
      const hits = targets.flatMap((artifact) => findImpossibleShares(artifact.text));
      passed = targets.length > 0 && hits.length === 0;
      expected = "占比类百分比均 <= 100%";
      actual = targets.length === 0
        ? "无交付物"
        : hits.length === 0
          ? "未发现不可能占比"
          : `发现 ${hits.length} 处: ` +
            hits.slice(0, 3).map((hit) => `${hit.percent}% @「${hit.excerpt}」`).join("; ");
      break;
    }
  }

  return {
    id: assertion.id,
    description: assertion.description,
    critical,
    weight,
    passed,
    status: unverifiable ? "unverifiable" : passed ? "passed" : "failed",
    expected,
    actual,
  };
}

function cellValuesEqual(
  actual: string | number | boolean | null | undefined,
  expected: string | number,
): boolean {
  if (typeof expected === "number") {
    return typeof actual === "number" && Math.abs(actual - expected) <= 1e-6;
  }
  return normalizeText(String(actual ?? "")) === normalizeText(expected);
}

function cleanupEvalRecalcRoot(root: string | undefined, outputPath: string): void {
  if (!root) return;
  const resolvedRoot = path.resolve(root);
  const resolvedOutput = path.resolve(outputPath);
  if (
    path.basename(resolvedRoot).startsWith("fa-recalc-") &&
    resolvedOutput.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  }
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s,，]/g, "");
}

function mimeCompatible(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  return (
    expected === XLSX_MIME &&
    actual === "application/vnd.ms-excel.sheet.macroEnabled.12"
  );
}
