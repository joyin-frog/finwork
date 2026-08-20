/**
 * Product spreadsheet runtime commands (CR-S1).
 * Owns probe / inspect / convert-xls / recalc / render — not business validators.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { getProjectRoot, getPythonPath } from "./paths";
import { trustedPythonWorkerEnv } from "./python-env";
import { resolveLibreOffice, type LibreOfficeResolveResult } from "./libreoffice-resolver";
import { getSpreadsheetCapabilities, type SpreadsheetCapabilities } from "./spreadsheet-probe";

export type RuntimeCommandResult<T = unknown> = {
  ok: boolean;
  data?: T;
  errorCode?: string;
  detail?: string;
};

function runPython(args: string[], opts?: { timeoutMs?: number; stdin?: string }): Promise<string> {
  const pythonPath = getPythonPath();
  const worker = path.join(getProjectRoot(), "workers", "finance_worker.py");
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [worker, ...args], {
      env: trustedPythonWorkerEnv(),
      cwd: os.tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${opts?.timeoutMs ?? 60_000}ms`));
    }, opts?.timeoutMs ?? 60_000);
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || `exit ${code}`));
      else resolve(stdout);
    });
    if (opts?.stdin) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export async function spreadsheetProbe(): Promise<RuntimeCommandResult<SpreadsheetCapabilities>> {
  const data = await getSpreadsheetCapabilities();
  return { ok: data.problems.every((p) => p.severity !== "blocking"), data };
}

export async function spreadsheetInspect(filePath: string): Promise<RuntimeCommandResult> {
  if (!fs.existsSync(filePath)) {
    return { ok: false, errorCode: "file_not_found", detail: filePath };
  }
  try {
    const raw = await runPython(["inspect-excel", filePath]);
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      errorCode: "inspect_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function spreadsheetExtractText(
  filePath: string,
): Promise<RuntimeCommandResult<{ text: string }>> {
  if (!fs.existsSync(filePath)) {
    return { ok: false, errorCode: "file_not_found", detail: filePath };
  }
  try {
    const text = await runPython(["extract-text", filePath]);
    return { ok: true, data: { text } };
  } catch (error) {
    return {
      ok: false,
      errorCode: "extract_text_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function spreadsheetInspectCells(
  filePath: string,
  addresses: string[],
): Promise<RuntimeCommandResult<{ values: Record<string, string | number | boolean | null> }>> {
  if (!fs.existsSync(filePath)) {
    return { ok: false, errorCode: "file_not_found", detail: filePath };
  }
  try {
    const raw = await runPython(["inspect-excel-cells", filePath, JSON.stringify(addresses)]);
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      values?: Record<string, string | number | boolean | null>;
      error?: string;
    };
    if (!parsed.ok || !parsed.values) {
      return { ok: false, errorCode: "inspect_cells_failed", detail: parsed.error };
    }
    return { ok: true, data: { values: parsed.values } };
  } catch (error) {
    return {
      ok: false,
      errorCode: "inspect_cells_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type WorkbookEdit = {
  sheet: string;
  cell: string;
  value?: string | number | boolean | null;
  formula?: string;
  clear?: boolean;
  /** 显式声明才建表;表不存在且未声明时报 sheet_not_found,不静默新建。 */
  createSheet?: boolean;
};

export type WorkbookPatchResult = {
  applied: Array<{ sheet: string; cell: string }>;
  missing: Array<{ sheet: string; cell: string; reason: string }>;
  createdSheets: string[];
  formulaCount: number;
  cachedValueCount: number;
  /**
   * 因改动而失效、但引擎也算不出新值的既有公式:原缓存原样保留,需人工复核。
   * 只包含「传播到了但解析不了」的格子——引擎能算出的都已进入 `backfilled`。
   */
  staleFormulas: Array<{ cell: string; formula: string }>;
  staleFormulaCount: number;
  /** 只写了公式、未提供结果的单元格数(不含依赖闭包发现的既有公式)。 */
  formulaOnlyCount: number;
  /**
   * 被引擎成功算出并写回缓存的单元格,含两类来源(见 reason):
   * - "explicit":模型自己新写的公式,没给结果,引擎补算。
   * - "downstream":既有公式,因引用了本次改动的格子而失效,引擎重算后更新。
   */
  backfilled: Array<{ sheet: string; cell: string; value: string | number | boolean; reason: "explicit" | "downstream" }>;
  backfilledCount: number;
  /** 引擎也算不出的显式公式:多因依赖本机够不到的外部链接,需人工校验。 */
  unresolvedFormulaCells: string[];
  /** 引擎不可用/超时的原因;null 表示引擎正常工作。 */
  engineNote: string | null;
};

/**
 * 无损编辑既有工作簿:只重写目标单元格,其余字节原样搬运。
 *
 * 不要用 openpyxl 的 load→save 代替它。实测一次原样往返会清空全部公式缓存
 * (真实工作簿 1164 → 0);外部链接的值一旦丢失,本机无论装不装 LibreOffice
 * 都算不回来。
 */
export async function spreadsheetPatchWorkbook(
  sourcePath: string,
  outputPath: string,
  edits: WorkbookEdit[],
): Promise<RuntimeCommandResult<WorkbookPatchResult>> {
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, errorCode: "file_not_found", detail: sourcePath };
  }
  if (edits.length === 0) {
    return { ok: false, errorCode: "no_edits", detail: "未提供任何单元格改动" };
  }
  try {
    // 必须宽于 finance_worker.py 的 ENGINE_TIMEOUT_SECONDS(45s)+闭包扫描/最终统计
    // 的开销——实测真实大模板总耗时约 48s。留得太紧,Python 那边优雅降级(标记
    // engine_timeout、保留原缓存)还没写完 JSON,这层就先把子进程硬杀了,模型
    // 看到的会是一个裸的 "timeout after 60000ms" 而不是可读的降级说明。
    const raw = await runPython([
      "patch-workbook",
      sourcePath,
      outputPath,
      JSON.stringify(edits),
    ], { timeoutMs: 90_000 });
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string } & WorkbookPatchResult;
    if (!parsed.ok) {
      return { ok: false, errorCode: "patch_failed", detail: parsed.error };
    }
    return { ok: true, data: parsed };
  } catch (error) {
    return {
      ok: false,
      errorCode: "patch_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function spreadsheetInspectFormulaCells(
  filePath: string,
  addresses: string[],
): Promise<RuntimeCommandResult<{ formulas: Record<string, string | null> }>> {
  if (!fs.existsSync(filePath)) {
    return { ok: false, errorCode: "file_not_found", detail: filePath };
  }
  try {
    const raw = await runPython([
      "inspect-excel-formulas",
      filePath,
      JSON.stringify(addresses),
    ]);
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      formulas?: Record<string, string | null>;
      error?: string;
    };
    if (!parsed.ok || !parsed.formulas) {
      return { ok: false, errorCode: "inspect_formulas_failed", detail: parsed.error };
    }
    return { ok: true, data: { formulas: parsed.formulas } };
  } catch (error) {
    return {
      ok: false,
      errorCode: "inspect_formulas_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function spreadsheetCompareAllowedCells(
  referencePath: string,
  candidatePath: string,
  allowedSheet: string,
  allowedColumns: string[],
): Promise<RuntimeCommandResult<{
  changedCount: number;
  allowedChangedCount: number;
  disallowedChanges: string[];
}>> {
  if (!fs.existsSync(referencePath) || !fs.existsSync(candidatePath)) {
    return {
      ok: false,
      errorCode: "file_not_found",
      detail: !fs.existsSync(referencePath) ? referencePath : candidatePath,
    };
  }
  try {
    const raw = await runPython([
      "compare-excel-allowlist",
      referencePath,
      candidatePath,
      allowedSheet,
      JSON.stringify(allowedColumns),
    ]);
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      changedCount?: number;
      allowedChangedCount?: number;
      disallowedChanges?: string[];
      error?: string;
    };
    if (!parsed.ok) {
      return { ok: false, errorCode: "compare_cells_failed", detail: parsed.error };
    }
    return {
      ok: true,
      data: {
        changedCount: parsed.changedCount ?? 0,
        allowedChangedCount: parsed.allowedChangedCount ?? 0,
        disallowedChanges: parsed.disallowedChanges ?? [],
      },
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "compare_cells_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function spreadsheetConvertXls(
  inputPath: string,
  outputPath: string
): Promise<RuntimeCommandResult<{ outputPath: string }>> {
  if (!fs.existsSync(inputPath)) {
    return { ok: false, errorCode: "file_not_found", detail: inputPath };
  }
  try {
    const raw = await runPython(["convert-xls", inputPath, outputPath]);
    const parsed = JSON.parse(raw) as { ok?: boolean; outputPath?: string; error?: string };
    if (!parsed.ok) {
      return { ok: false, errorCode: "convert_failed", detail: parsed.error };
    }
    return { ok: true, data: { outputPath: parsed.outputPath ?? outputPath } };
  } catch (error) {
    return {
      ok: false,
      errorCode: "convert_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type RecalcResult = {
  inputHash: string;
  outputHash: string;
  /** Verified recalculated working copy. The caller decides whether to promote it. */
  outputPath: string;
  /** Runtime-owned temporary root that the caller may remove after promotion. */
  cleanupRoot?: string;
  provider: string;
  version?: string;
  formulaCount?: number;
  /** Single-pass post-recalc inspection, when the provider can inspect in memory. */
  inspection?: unknown;
  durationMs: number;
  executable: string;
};

/**
 * Recalculate formulas on a working copy (never mutates the upload in place).
 * Uses an isolated LibreOffice UserInstallation profile.
 */
export async function spreadsheetRecalc(
  xlsxPath: string,
  opts?: {
    timeoutSeconds?: number;
    resolveLo?: () => LibreOfficeResolveResult;
    workCopyDir?: string;
  }
): Promise<RuntimeCommandResult<RecalcResult>> {
  const started = Date.now();
  if (!fs.existsSync(xlsxPath)) {
    return { ok: false, errorCode: "file_not_found", detail: xlsxPath };
  }
  const lo = (opts?.resolveLo ?? resolveLibreOffice)();
  if (!lo.ok) {
    return {
      ok: false,
      errorCode: lo.errorCode,
      detail: lo.detail,
    };
  }

  const timeoutSeconds = opts?.timeoutSeconds ?? 60;
  const ownsWorkRoot = !opts?.workCopyDir;
  const workRoot = opts?.workCopyDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "fa-recalc-"));
  const workCopy = path.join(workRoot, path.basename(xlsxPath));
  fs.mkdirSync(workRoot, { recursive: true });
  fs.copyFileSync(xlsxPath, workCopy);
  const inputHash = sha256File(xlsxPath);

  // Re-save through Calc in an isolated profile. Invoking a user macro directly
  // can hang forever when the bundled runtime has no Standard.Module1 installed;
  // the worker's convert-to path both recalculates and has its own hard timeout.
  let formulaCount: number | undefined;
  try {
    const raw = await runPython(
      ["recalc-xlsx", workCopy, lo.executable, String(timeoutSeconds)],
      { timeoutMs: (timeoutSeconds + 15) * 1000 }
    );
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; formulaCount?: number };
    if (!parsed.ok) {
      const detail = parsed.error ?? "LibreOffice recalculation failed";
      return {
        ok: false,
        errorCode: /timeout/i.test(detail) ? "recalc_timeout" : "recalc_failed",
        detail,
      };
    }
    formulaCount = parsed.formulaCount;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errorCode: /timeout|killed|SIGKILL/i.test(msg) ? "recalc_timeout" : "recalc_failed",
      detail: msg,
    };
  }

  const outputHash = sha256File(workCopy);
  if (sha256File(xlsxPath) !== inputHash) {
    return { ok: false, errorCode: "input_mutated", detail: "recalc mutated source file" };
  }

  return {
    ok: true,
    data: {
      inputHash,
      outputHash,
      outputPath: workCopy,
      cleanupRoot: ownsWorkRoot ? workRoot : undefined,
      provider: lo.provider,
      version: lo.version,
      formulaCount,
      durationMs: Date.now() - started,
      executable: lo.executable,
    },
  };
}

export type RenderResult = {
  outDir: string;
  files: string[];
  provider: string;
  executable: string;
  durationMs: number;
};

/** Render workbook to PDF (or other LO export) in outDir via system LibreOffice. */
export async function spreadsheetRender(
  xlsxPath: string,
  outDir: string,
  opts?: { resolveLo?: () => LibreOfficeResolveResult; timeoutSeconds?: number }
): Promise<RuntimeCommandResult<RenderResult>> {
  const started = Date.now();
  if (!fs.existsSync(xlsxPath)) {
    return { ok: false, errorCode: "file_not_found", detail: xlsxPath };
  }
  const lo = (opts?.resolveLo ?? resolveLibreOffice)();
  if (!lo.ok) {
    return { ok: false, errorCode: lo.errorCode, detail: lo.detail };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fa-render-"));
  const profileDir = path.join(workRoot, "lo-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  const timeoutSeconds = opts?.timeoutSeconds ?? 90;
  try {
    await execFileAsync(
      lo.executable,
      [
        "--headless",
        "--norestore",
        "--nolockcheck",
        `-env:UserInstallation=file://${profileDir}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        xlsxPath,
      ],
      timeoutSeconds * 1000
    );
  } catch (error) {
    return {
      ok: false,
      errorCode: "render_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const files = fs.readdirSync(outDir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (files.length === 0) {
    return { ok: false, errorCode: "render_empty", detail: "LibreOffice produced no PDF" };
  }
  return {
    ok: true,
    data: {
      outDir,
      files: files.map((f) => path.join(outDir, f)),
      provider: lo.provider,
      executable: lo.executable,
      durationMs: Date.now() - started,
    },
  };
}

function execFileAsync(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: trustedPythonWorkerEnv({ SAL_USE_VCLPLUGIN: "svp" }),
        cwd: os.tmpdir(),
      },
      (err, _stdout, stderr) => {
        if (err) {
          const anyErr = err as NodeJS.ErrnoException & { killed?: boolean };
          if (anyErr.killed) reject(new Error(`TIMEOUT: killed after ${timeoutMs}ms`));
          else reject(new Error(stderr || err.message));
        } else resolve();
      }
    );
  });
}
