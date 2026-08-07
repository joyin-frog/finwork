import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { RecalcResult, RuntimeCommandResult } from "./spreadsheet-runtime";

type ArtifactModule = {
  SpreadsheetFile: { importXlsx(input: Uint8Array): Promise<any> };
};

type CachedWorkbook = {
  fingerprint: string;
  workbook: any;
};

const workbookCache = new Map<string, CachedWorkbook>();

export type ArtifactToolProbe = {
  provider: "artifact_tool";
  packagePath: string;
  version?: string;
  formulaEngine: boolean;
  importXlsx: boolean;
};

function resolvePackagePath(): string | null {
  const explicit = process.env.FINANCE_AGENT_ARTIFACT_TOOL_PATH ?? process.env.ARTIFACT_TOOL_PATH;
  if (explicit && fs.existsSync(path.join(explicit, "package.json"))) return explicit;
  return null;
}

function loadArtifactTool(): { module: ArtifactModule; packagePath: string; version?: string } | null {
  const packagePath = resolvePackagePath();
  if (!packagePath) return null;
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packagePath, "package.json"), "utf8")) as { version?: string };
    // 变量名不能叫 module——Next.js/webpack 会把它当模块包装器的保留标识符处理
    // (@next/next/no-assign-module-variable)。
    const mod = createRequire(path.join(packagePath, "package.json"))("@oai/artifact-tool") as ArtifactModule;
    return { module: mod, packagePath, version: packageJson.version };
  } catch {
    return null;
  }
}

export function artifactToolProbe(): RuntimeCommandResult<ArtifactToolProbe> {
  const loaded = loadArtifactTool();
  if (!loaded) return { ok: false, errorCode: "artifact_tool_unavailable", detail: "未配置可用的 @oai/artifact-tool bundled runtime" };
  return {
    ok: true,
    data: {
      provider: "artifact_tool",
      packagePath: loaded.packagePath,
      version: loaded.version,
      formulaEngine: true,
      importXlsx: typeof loaded.module.SpreadsheetFile?.importXlsx === "function",
    },
  };
}

/** Clear imported workbook state between isolated evaluation runs/tests. */
export function artifactToolClearCache(): void {
  workbookCache.clear();
}

function fileFingerprint(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

async function importWorkbook(filePath: string, loaded: { module: ArtifactModule }): Promise<any> {
  const fingerprint = fileFingerprint(filePath);
  const cached = workbookCache.get(filePath);
  if (cached?.fingerprint === fingerprint) return cached.workbook;
  const workbook = await loaded.module.SpreadsheetFile.importXlsx(new Uint8Array(fs.readFileSync(filePath)));
  workbookCache.set(filePath, { fingerprint, workbook });
  return workbook;
}

/** Artifact-tool inspection with the same high-level shape as finance_worker inspect. */
export async function artifactToolInspect(filePath: string): Promise<RuntimeCommandResult> {
  if (!fs.existsSync(filePath)) return { ok: false, errorCode: "file_not_found", detail: filePath };
  const loaded = loadArtifactTool();
  if (!loaded) return { ok: false, errorCode: "artifact_tool_unavailable", detail: "未配置可用的 @oai/artifact-tool bundled runtime" };
  try {
    const workbook = await importWorkbook(filePath, loaded);
    const sheets = await summarizeWorkbook(workbook);
    return { ok: true, data: { provider: "artifact_tool", version: loaded.version, sheets } };
  } catch (error) {
    return { ok: false, errorCode: "artifact_tool_inspect_failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function artifactToolRecalc(
  xlsxPath: string,
  opts?: { workCopyDir?: string },
): Promise<RuntimeCommandResult<RecalcResult>> {
  if (!fs.existsSync(xlsxPath)) return { ok: false, errorCode: "file_not_found", detail: xlsxPath };
  const loaded = loadArtifactTool();
  if (!loaded) return { ok: false, errorCode: "artifact_tool_unavailable", detail: "未配置可用的 @oai/artifact-tool bundled runtime" };
  const started = Date.now();
  const ownsRoot = !opts?.workCopyDir;
  const root = opts?.workCopyDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "fa-artifact-recalc-"));
  fs.mkdirSync(root, { recursive: true });
  const outputPath = path.join(root, path.basename(xlsxPath));
  const inputHash = sha256(xlsxPath);
  try {
    const workbook = await importWorkbook(xlsxPath, loaded);
    let formulaCount = 0;
    for (const sheet of workbook.worksheets.items ?? []) {
      const used = sheet.getUsedRange();
      used.calculate?.();
      const formulas = (used.formulas ?? []) as unknown[][];
      formulaCount += formulas.flat().filter((value) => typeof value === "string" && value.startsWith("=")).length;
    }
    const inspection = await summarizeWorkbook(workbook);
    const blob = await (loaded.module as any).SpreadsheetFile.exportXlsx(workbook);
    await blob.save(outputPath);
    return {
      ok: true,
      data: {
        inputHash,
        outputHash: sha256(outputPath),
        outputPath,
        cleanupRoot: ownsRoot ? root : undefined,
        provider: "artifact_tool",
        version: loaded.version,
        formulaCount,
        inspection,
        durationMs: Date.now() - started,
        executable: loaded.packagePath,
      },
    };
  } catch (error) {
    return { ok: false, errorCode: "artifact_tool_recalc_failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function summarizeWorkbook(workbook: any): Promise<{ provider: string; version?: string; sheets: Array<Record<string, unknown>> }> {
  const sheets = [];
  const matches = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 100 },
  });
  const allErrors = parseNdjson(matches?.ndjson);
  for (const sheet of workbook.worksheets.items ?? []) {
    const used = sheet.getUsedRange();
    const formulas = (used.formulas ?? []) as unknown[][];
    const values = (used.values ?? []) as unknown[][];
    let formulaCount = 0;
    let emptyCacheCount = 0;
    const formulasSample: Array<{ cell: string; formula: string; cached_value: unknown }> = [];
    for (let r = 0; r < formulas.length; r += 1) {
      for (let c = 0; c < (formulas[r]?.length ?? 0); c += 1) {
        const formula = formulas[r]?.[c];
        if (typeof formula !== "string" || !formula.startsWith("=")) continue;
        formulaCount += 1;
        const cached = values[r]?.[c];
        if (cached == null || cached === "") emptyCacheCount += 1;
        if (formulasSample.length < 100) formulasSample.push({ cell: `${sheet.name}!${columnName(c + used.columnIndex + 1)}${r + used.rowIndex + 1}`, formula, cached_value: cached });
      }
    }
    sheets.push({ name: sheet.name, rows: used.rowCount, columns: used.columnCount, formula_count: formulaCount, formula_empty_cache_count: emptyCacheCount, formulas_sample: formulasSample, formula_errors: allErrors.filter((entry) => entry.sheet === sheet.name), sample_rows: values.slice(0, 12) });
  }
  return { provider: "artifact_tool", sheets };
}

function parseNdjson(raw: unknown): Array<Record<string, unknown>> {
  if (typeof raw !== "string") return [];
  return raw.split("\n").flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line) as Record<string, unknown>] : []; } catch { return []; }
  });
}

function columnName(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
