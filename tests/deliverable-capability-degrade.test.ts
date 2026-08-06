/**
 * 单测:计算/渲染 Provider 缺失时的降级行为。
 *
 * 真实事故(2026-08-05 历史财务评测 HISTORY-001):模型交出一个 1143 条公式的工作簿,
 * 本机没装 LibreOffice → 渲染失败 → 被 push 进 errors → 整个交付物被拒 → 0 产物、
 * 确定性分 0。而那份工作簿本可以通过 5 条断言里的 4 条。
 *
 * 不变量:**能力不可用 ≠ 校验失败**。Provider 缺失一律降为 warning,交付照走;
 * 只有真正跑起来却出错(公式错误、结构损坏、重算后仍不对)才算 errors。
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256File } from "../lib/deliverable/hash.ts";
import { validateXlsxFile } from "../lib/deliverable/validators/xlsx.ts";
import { getSpreadsheetFixtureDir } from "../lib/runtime/spreadsheet-probe.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const { equal, ok } = assert;

/** 一个结构正常、含 1 条公式的工作簿检查结果。 */
const healthyInspect = async () => ({
  ok: true as const,
  data: {
    sheets: [{
      name: "Sheet1",
      formula_count: 1,
      formulas_sample: [{ cell: "A1", formula: "=1+1", cached_value: 2 }],
    }],
  },
});

function stageCandidate(dir: string): { filePath: string; sha: string } {
  const filePath = path.join(dir, "candidate.xlsx");
  copyFileSync(path.join(getSpreadsheetFixtureDir(), "formula-ok.xlsx"), filePath);
  return { filePath, sha: sha256File(filePath) };
}

export const deliverableCapabilityDegradeTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "capability-degrade-test-"));
  try {
    // 1. 渲染不可用 —— 事故复现。渲染产出的是预览图,不该毙掉工作簿。
    {
      const { filePath, sha } = stageCandidate(dir);
      const report = await validateXlsxFile(
        {
          filePath,
          fileName: "candidate.xlsx",
          expectedMime: XLSX_MIME,
          qualityProfile: "generic",
          expectedSha256: sha,
          needsRender: true,
        },
        {
          inspect: healthyInspect,
          recalc: async () => ({ ok: false, errorCode: "recalc_unavailable" }),
          // LO resolver 对 recalc / render 返回同一个错误码,这里照实模拟。
          render: async () => ({
            ok: false,
            errorCode: "recalc_unavailable",
            detail: "未找到 LibreOffice，公式重算与正式渲染不可用。",
          }),
        },
      );
      equal(report.status, "passed", "渲染 FAIL: 预览渲不出来不得阻断交付");
      equal(report.errors.length, 0, `渲染 FAIL: 不应有 errors —— ${JSON.stringify(report.errors)}`);
      ok(
        report.warnings.some((issue) => issue.code === "render_unavailable"),
        "渲染 FAIL: 应归一为 render_unavailable，而不是透传 recalc_unavailable",
      );
      equal(
        (report.evidence as { renderAvailable?: boolean }).renderAvailable,
        false,
        "渲染 FAIL: 证据里应标明渲染不可用",
      );
    }

    // 2. 重算不可用 —— 同样降级,并在证据里留下「缓存是旧的」这一事实。
    {
      const { filePath, sha } = stageCandidate(dir);
      const report = await validateXlsxFile(
        {
          filePath,
          fileName: "candidate.xlsx",
          expectedMime: XLSX_MIME,
          qualityProfile: "generic",
          expectedSha256: sha,
          needsRecalc: true,
        },
        {
          inspect: healthyInspect,
          recalc: async () => ({
            ok: false,
            errorCode: "recalc_unavailable",
            detail: "未找到 LibreOffice，公式重算与正式渲染不可用。",
          }),
          render: async () => ({ ok: true, data: { files: [], provider: "stub" } }),
        },
      );
      equal(report.status, "passed", "重算 FAIL: 缺 Provider 不得阻断交付");
      equal(report.errors.length, 0, `重算 FAIL: 不应有 errors —— ${JSON.stringify(report.errors)}`);
      ok(
        report.warnings.some((issue) => issue.code === "recalc_unavailable"),
        "重算 FAIL: 应留下 recalc_unavailable 警告",
      );
      equal(
        (report.evidence as { recalcAvailable?: boolean }).recalcAvailable,
        false,
        "重算 FAIL: 证据里应标明重算不可用",
      );
    }

    // 3. 重算**真的跑了却失败** —— 这不是能力缺失,必须仍然是硬失败。
    //    降级只针对「没这个能力」,不针对「有能力但结果不对」。
    {
      const { filePath, sha } = stageCandidate(dir);
      const report = await validateXlsxFile(
        {
          filePath,
          fileName: "candidate.xlsx",
          expectedMime: XLSX_MIME,
          qualityProfile: "generic",
          expectedSha256: sha,
          needsRecalc: true,
        },
        {
          inspect: healthyInspect,
          recalc: async () => ({
            ok: false,
            errorCode: "recalc_failed",
            detail: "LibreOffice 退出码 1",
          }),
          render: async () => ({ ok: true, data: { files: [], provider: "stub" } }),
        },
      );
      equal(report.status, "failed", "真失败 FAIL: 重算跑了却出错必须硬失败");
      ok(
        report.errors.some((issue) => issue.code === "recalc_failed"),
        "真失败 FAIL: 应保留 recalc_failed 错误",
      );
    }

    console.log("deliverable-capability-degrade: all 3 checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
