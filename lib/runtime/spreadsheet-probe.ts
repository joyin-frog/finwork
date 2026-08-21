/**
 * Spreadsheet capability probe (CR-S1).
 * Runs real import/fixture checks where possible; LibreOffice recalc is skipped
 * cleanly when resolver returns recalc_unavailable (no false failure).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { getProjectRoot, getPythonPath } from "./paths";
import { pythonSpawnEnv } from "./python-env";
import { resolveLibreOffice, type LibreOfficeResolveResult } from "./libreoffice-resolver";

export type Capability = {
  ok: boolean;
  version?: string;
  source?: string;
  errorCode?: string;
};

export type SpreadsheetCapabilities = {
  python: Capability;
  packages: {
    openpyxl: Capability;
    pandas: Capability;
    xlsxwriter: Capability;
    xlrd: Capability;
  };
  read: { csv: boolean; xlsx: boolean; xlsm: boolean; xls: boolean };
  write: { xlsx: boolean; preserveXlsm: false };
  recalc: {
    ok: boolean;
    provider?: "system_libreoffice" | "managed_libreoffice";
    executable?: string;
    version?: string;
    /** Present when LO missing or probe skipped — tests must treat as explicit skip, not failure. */
    skipped?: boolean;
    errorCode?: string;
  };
  render: { ok: boolean; provider?: "system_libreoffice" | "managed_libreoffice"; skipped?: boolean };
  problems: Array<{
    code: string;
    severity: "blocking" | "warning";
    remediation: "repair_python" | "install_libreoffice" | "none";
  }>;
  /** Wall-clock probe duration in ms. */
  durationMs?: number;
};

export type ProbeDeps = {
  pythonPath?: string;
  runner?: (pythonPath: string, args: string[], opts?: { timeout?: number }) => Promise<string>;
  resolveLo?: () => LibreOfficeResolveResult;
  exists?: (p: string) => boolean;
  /** When false, skip real LO recalc even if LO is present (CI without formula fixture run). */
  runRecalcProbe?: boolean;
};

const FIXTURE_DIR = path.join(getProjectRoot(), "tests", "fixtures", "spreadsheet");

function defaultRunner(pythonPath: string, args: string[], opts?: { timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      pythonPath,
      args,
      {
        timeout: opts?.timeout ?? 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: pythonSpawnEnv(),
        cwd: os.tmpdir(),
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout);
      }
    );
  });
}

function capFromImport(
  name: string,
  deps: Record<string, string> | undefined,
  missing: string[] | undefined
): Capability {
  const miss = (missing ?? []).includes(name) || (missing ?? []).includes(name === "PIL" ? "PIL" : name);
  // selfcheck uses import names: openpyxl, pandas, xlsxwriter, xlrd, PIL
  const key = name;
  if (miss || !deps || !(key in deps)) {
    return { ok: false, errorCode: `missing_${name}` };
  }
  return { ok: true, version: deps[key], source: "selfcheck" };
}

/**
 * Probe spreadsheet runtime capabilities.
 * Exported for Doctor API wiring (CR-S1 follow-up); do not wire waiting_dependency here.
 */
export async function getSpreadsheetCapabilities(deps: ProbeDeps = {}): Promise<SpreadsheetCapabilities> {
  const started = Date.now();
  const pythonPath = deps.pythonPath ?? getPythonPath();
  const exists = deps.exists ?? fs.existsSync;
  const runner = deps.runner ?? defaultRunner;
  const resolveLo = deps.resolveLo ?? (() => resolveLibreOffice());
  const runRecalcProbe = deps.runRecalcProbe ?? true;

  const problems: SpreadsheetCapabilities["problems"] = [];
  const packages: SpreadsheetCapabilities["packages"] = {
    openpyxl: { ok: false, errorCode: "not_probed" },
    pandas: { ok: false, errorCode: "not_probed" },
    xlsxwriter: { ok: false, errorCode: "not_probed" },
    xlrd: { ok: false, errorCode: "not_probed" },
  };
  let python: Capability = { ok: false, errorCode: "python_missing" };
  let read = { csv: false, xlsx: false, xlsm: false, xls: false };
  let writeXlsx = false;

  if (!exists(pythonPath)) {
    problems.push({
      code: "python_missing",
      severity: "blocking",
      remediation: "repair_python",
    });
    const lo = resolveLo();
    return finalize(
      {
        python,
        packages,
        read,
        write: { xlsx: false, preserveXlsm: false },
        recalc: lo.ok
          ? { ok: false, provider: lo.provider, executable: lo.executable, version: lo.version, skipped: true, errorCode: "python_missing" }
          : { ok: false, skipped: true, errorCode: lo.errorCode },
        render: { ok: false, skipped: true },
        problems,
      },
      started
    );
  }

  const workerPath = path.join(getProjectRoot(), "workers", "finance_worker.py");
  try {
    const raw = await runner(pythonPath, [workerPath, "--selfcheck"]);
    const parsed = JSON.parse(raw) as {
      python?: string;
      deps?: Record<string, string>;
      missing?: string[];
      ok?: boolean;
    };
    python = { ok: true, version: parsed.python, source: pythonPath };
    packages.openpyxl = capFromImport("openpyxl", parsed.deps, parsed.missing);
    packages.pandas = capFromImport("pandas", parsed.deps, parsed.missing);
    packages.xlsxwriter = capFromImport("xlsxwriter", parsed.deps, parsed.missing);
    packages.xlrd = capFromImport("xlrd", parsed.deps, parsed.missing);
    if (!packages.openpyxl.ok || !packages.pandas.ok || !packages.xlsxwriter.ok || !packages.xlrd.ok) {
      problems.push({
        code: "spreadsheet_packages_missing",
        severity: "blocking",
        remediation: "repair_python",
      });
    }
  } catch (error) {
    python = {
      ok: false,
      errorCode: "selfcheck_failed",
      source: error instanceof Error ? error.message : String(error),
    };
    problems.push({
      code: "selfcheck_failed",
      severity: "blocking",
      remediation: "repair_python",
    });
  }

  // Behavioral fixtures via worker probe-spreadsheet when packages look ok
  if (python.ok && packages.openpyxl.ok && packages.xlrd.ok) {
    try {
      const probeOut = await runner(pythonPath, [workerPath, "probe-spreadsheet"], { timeout: 90_000 });
      const probe = JSON.parse(probeOut) as {
        read?: { csv?: boolean; xlsx?: boolean; xlsm?: boolean; xls?: boolean };
        write?: { xlsx?: boolean };
        ok?: boolean;
        error?: string;
      };
      read = {
        csv: Boolean(probe.read?.csv),
        xlsx: Boolean(probe.read?.xlsx),
        xlsm: Boolean(probe.read?.xlsm),
        xls: Boolean(probe.read?.xls),
      };
      writeXlsx = Boolean(probe.write?.xlsx);
      if (!read.xls) {
        problems.push({
          code: "xls_read_failed",
          severity: "blocking",
          remediation: "repair_python",
        });
      }
      if (!writeXlsx || !read.xlsx) {
        problems.push({
          code: "xlsx_io_failed",
          severity: "blocking",
          remediation: "repair_python",
        });
      }
    } catch (error) {
      problems.push({
        code: "fixture_probe_failed",
        severity: "blocking",
        remediation: "repair_python",
      });
      // keep packages from selfcheck; read/write stay false
      void error;
    }
  }

  const lo = resolveLo();
  let recalc: SpreadsheetCapabilities["recalc"];
  let render: SpreadsheetCapabilities["render"];

  if (!lo.ok) {
    recalc = { ok: false, skipped: true, errorCode: lo.errorCode };
    render = { ok: false, skipped: true };
    problems.push({
      code: "recalc_unavailable",
      severity: "warning",
      remediation: "install_libreoffice",
    });
  } else if (!runRecalcProbe || !python.ok) {
    // LO present but probe explicitly skipped (e.g. unit test) or python broken
    recalc = {
      ok: false,
      provider: lo.provider,
      executable: lo.executable,
      version: lo.version,
      skipped: true,
      errorCode: "recalc_probe_skipped",
    };
    render = { ok: false, provider: lo.provider, skipped: true };
  } else {
    // Real SUM(A1:A2)=3 probe via worker when LO available
    try {
      const recalcOut = await runner(
        pythonPath,
        [workerPath, "probe-recalc", lo.executable],
        { timeout: 120_000 }
      );
      const parsed = JSON.parse(recalcOut) as { ok?: boolean; value?: number; renderOk?: boolean; renderError?: string; error?: string };
      if (parsed.ok && parsed.value === 3) {
        recalc = {
          ok: true,
          provider: lo.provider,
          executable: lo.executable,
          version: lo.version,
        };
        render = parsed.renderOk
          ? { ok: true, provider: lo.provider }
          : { ok: false, provider: lo.provider };
        if (!parsed.renderOk) {
          problems.push({
            code: "render_probe_failed",
            severity: "warning",
            remediation: "install_libreoffice",
          });
        }
      } else {
        recalc = {
          ok: false,
          provider: lo.provider,
          executable: lo.executable,
          version: lo.version,
          errorCode: "recalc_probe_failed",
        };
        render = { ok: false, provider: lo.provider };
        problems.push({
          code: "recalc_probe_failed",
          severity: "warning",
          remediation: "install_libreoffice",
        });
      }
    } catch {
      recalc = {
        ok: false,
        provider: lo.provider,
        executable: lo.executable,
        version: lo.version,
        errorCode: "recalc_probe_failed",
      };
      render = { ok: false, provider: lo.provider };
      problems.push({
        code: "recalc_probe_failed",
        severity: "warning",
        remediation: "install_libreoffice",
      });
    }
  }

  return finalize(
    {
      python,
      packages,
      read,
      write: { xlsx: writeXlsx, preserveXlsm: false },
      recalc,
      render,
      problems,
    },
    started
  );
}

function finalize(
  caps: Omit<SpreadsheetCapabilities, "durationMs">,
  started: number
): SpreadsheetCapabilities {
  return { ...caps, durationMs: Date.now() - started };
}

/** Fixture directory used by worker probe (also useful for tests). */
export function getSpreadsheetFixtureDir(): string {
  return FIXTURE_DIR;
}

/** Stable content hash helper for recalc input/output verification. */
export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}
