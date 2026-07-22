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
import { pythonSpawnEnv } from "./python-env";
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
      env: pythonSpawnEnv(),
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
  provider: string;
  version?: string;
  formulaCount?: number;
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
  const workRoot = opts?.workCopyDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "fa-recalc-"));
  const profileDir = path.join(workRoot, "lo-profile");
  const workCopy = path.join(workRoot, path.basename(xlsxPath));
  fs.mkdirSync(profileDir, { recursive: true });
  fs.copyFileSync(xlsxPath, workCopy);
  const inputHash = sha256File(xlsxPath);

  const userInstallation = `file://${profileDir}`;
  const args = [
    "--headless",
    "--norestore",
    "--nolockcheck",
    `-env:UserInstallation=${userInstallation}`,
    "--calc",
    workCopy,
    "macro:///Standard.Module1.RecalculateAndSave",
  ];

  // Native timeout via spawn — do not depend on timeout/gtimeout.
  try {
    await execFileAsync(lo.executable, args, timeoutSeconds * 1000);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/TIMEOUT|killed|SIGKILL/i.test(msg)) {
      return { ok: false, errorCode: "recalc_timeout", detail: msg };
    }
    // Fallback: ask worker to run convert-to / macro path if direct macro fails
    try {
      const raw = await runPython(
        ["recalc-xlsx", workCopy, lo.executable, String(timeoutSeconds)],
        { timeoutMs: (timeoutSeconds + 15) * 1000 }
      );
      const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; formulaCount?: number };
      if (!parsed.ok) {
        return { ok: false, errorCode: "recalc_failed", detail: parsed.error ?? msg };
      }
      const outputHash = sha256File(workCopy);
      // Upload must remain unchanged
      if (sha256File(xlsxPath) !== inputHash) {
        return { ok: false, errorCode: "input_mutated", detail: "recalc mutated source file" };
      }
      return {
        ok: true,
        data: {
          inputHash,
          outputHash,
          provider: lo.provider,
          version: lo.version,
          formulaCount: parsed.formulaCount,
          durationMs: Date.now() - started,
          executable: lo.executable,
        },
      };
    } catch (inner) {
      return {
        ok: false,
        errorCode: "recalc_failed",
        detail: inner instanceof Error ? inner.message : String(inner),
      };
    }
  }

  const outputHash = sha256File(workCopy);
  if (sha256File(xlsxPath) !== inputHash) {
    return { ok: false, errorCode: "input_mutated", detail: "recalc mutated source file" };
  }

  let formulaCount: number | undefined;
  try {
    const raw = await runPython(["inspect-excel", workCopy]);
    const inspected = JSON.parse(raw) as { sheets?: Array<{ formula_count?: number }> };
    formulaCount = (inspected.sheets ?? []).reduce((n, s) => n + (s.formula_count ?? 0), 0);
  } catch {
    // optional
  }

  return {
    ok: true,
    data: {
      inputHash,
      outputHash,
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
        env: {
          ...process.env,
          SAL_USE_VCLPLUGIN: "svp",
        },
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
