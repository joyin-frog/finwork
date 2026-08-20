import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { FileWorkspaceStore } from "./store";
import type { SemanticDiff, WorkspaceChangePlanResult, WorkspaceChangeTarget } from "./types";

type CellSnapshot = {
  formula: string | null;
  value: unknown;
  style: string;
  comment: string | null;
};

type WorkbookSnapshot = {
  sheets: Array<{ name: string; state: string; rowCount: number; columnCount: number }>;
  cells: Record<string, CellSnapshot>;
  names: string[];
  tables: string[];
  validations: string[];
  hiddenRows: string[];
  hiddenColumns: string[];
  packageParts: Record<string, string>;
  hasMacros: boolean;
};

export async function semanticDiffFiles(beforePath: string, afterPath: string): Promise<SemanticDiff> {
  const extension = path.extname(afterPath || beforePath).toLowerCase();
  if ([".xlsx", ".xlsm"].includes(extension)) return xlsxSemanticDiff(beforePath, afterPath);
  if ([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".py", ".js", ".ts", ".sh", ".sql", ".r"].includes(extension)) {
    return textSemanticDiff(beforePath, afterPath, extension);
  }
  const [before, after] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
  const beforeHash = digest(before);
  const afterHash = digest(after);
  return {
    kind: "binary",
    changed: beforeHash !== afterHash,
    summary: beforeHash === afterHash ? "文件内容未变化" : "二进制内容发生变化",
    details: { beforeSha256: beforeHash, afterSha256: afterHash, beforeBytes: before.length, afterBytes: after.length },
  };
}

/** Single authority for the latest candidate on a run-local asset branch. */
export function resolveWorkspaceBranchHead(input: {
  db: DatabaseSync;
  store: FileWorkspaceStore;
  runId: string;
  assetId: string;
}): string {
  const latest = input.db.prepare(`
    SELECT candidate_version_id FROM file_changesets
    WHERE run_id=? AND asset_id=?
    ORDER BY created_at DESC,rowid DESC LIMIT 1
  `).get(input.runId, input.assetId) as { candidate_version_id: string } | undefined;
  return latest?.candidate_version_id ?? input.store.getAsset(input.assetId).versionId;
}

export async function createFileChangeSet(input: {
  db: DatabaseSync;
  store: FileWorkspaceStore;
  runId: string;
  assetId: string;
  candidatePath: string;
  validation: Record<string, unknown>;
  diff?: SemanticDiff;
  /** Agent 声称本轮候选基于的版本；与 run 分支头不一致时拒绝。 */
  baseVersionId?: string;
}): Promise<{ changesetId: string; diff: SemanticDiff; candidateVersionId: string }> {
  const base = input.store.getAsset(input.assetId);
  const branchHeadVersionId = resolveWorkspaceBranchHead(input);
  if (input.baseVersionId && input.baseVersionId !== branchHeadVersionId) {
    const error = new Error(
      `stale_base_version: 当前候选分支头为 ${branchHeadVersionId}，不能从旧版本 ${input.baseVersionId} 重建`,
    ) as Error & { code?: string };
    error.code = "stale_base_version";
    throw error;
  }
  const baselineDir = path.join(path.dirname(input.candidatePath), ".finwork-diff-baseline");
  try {
    const baselinePath = input.store.materializeVersion(branchHeadVersionId, baselineDir, base.name);
    const diff = input.diff ?? await semanticDiffFiles(baselinePath, input.candidatePath);
    const candidate = input.store.ingestManagedBuffer({
      assetId: base.assetId,
      name: base.name,
      mediaType: base.mediaType,
      content: await readFile(input.candidatePath),
      sourceKind: "managed",
      parentVersionId: branchHeadVersionId,
      makeCurrent: false,
    });
    input.store.linkTaskFile(input.runId, base.assetId, base.versionId, "baseline");
    input.store.linkTaskFile(input.runId, candidate.assetId, candidate.versionId, "output");
    const changesetId = randomUUID();
    input.db.prepare(`
      INSERT INTO file_changesets
        (changeset_id,run_id,asset_id,base_version_id,candidate_version_id,diff_kind,diff_json,validation_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      changesetId, input.runId, input.assetId, branchHeadVersionId, candidate.versionId,
      diff.kind, JSON.stringify(diff), JSON.stringify(input.validation), "pending", new Date().toISOString(),
    );
    return { changesetId, diff, candidateVersionId: candidate.versionId };
  } finally {
    await rm(baselineDir, { recursive: true, force: true });
  }
}

export function resolveFileChangeSet(
  db: DatabaseSync,
  changesetId: string,
  decision: "approved" | "rejected",
): void {
  const changed = db.prepare(`
    UPDATE file_changesets SET status=?,resolved_at=? WHERE changeset_id=? AND status='pending'
  `).run(decision, new Date().toISOString(), changesetId);
  if (Number(changed.changes) !== 1) throw new Error("变更集不存在或已经处理");
}

async function xlsxSemanticDiff(beforePath: string, afterPath: string): Promise<SemanticDiff> {
  const [before, after] = await Promise.all([snapshotWorkbook(beforePath), snapshotWorkbook(afterPath)]);
  const changedCells = diffRecord(before.cells, after.cells);
  const changedParts = diffRecord(before.packageParts, after.packageParts);
  const details = {
    sheets: diffArray(before.sheets, after.sheets, (item) => item.name),
    cells: changedCells,
    definedNames: diffArray(before.names, after.names),
    tables: diffArray(before.tables, after.tables),
    validations: diffArray(before.validations, after.validations),
    hiddenRows: diffArray(before.hiddenRows, after.hiddenRows),
    hiddenColumns: diffArray(before.hiddenColumns, after.hiddenColumns),
    packageParts: changedParts,
    macros: { before: before.hasMacros, after: after.hasMacros },
    cellChanges: {
      added: changedCells.added.slice(0, 2_000).map((address) => ({ address, after: after.cells[address] })),
      removed: changedCells.removed.slice(0, 2_000).map((address) => ({ address, before: before.cells[address] })),
      changed: changedCells.changed.slice(0, 2_000).map((address) => ({
        address,
        before: before.cells[address],
        after: after.cells[address],
      })),
      truncated: changedCells.added.length + changedCells.removed.length + changedCells.changed.length > 2_000,
    },
  };
  const changed = [
    details.sheets, details.cells, details.definedNames, details.tables, details.validations,
    details.hiddenRows, details.hiddenColumns, details.packageParts,
  ].some((value) => value.added.length > 0 || value.removed.length > 0 || value.changed.length > 0)
    || details.macros.before !== details.macros.after;
  return {
    kind: "xlsx",
    changed,
    summary: changed
      ? `Excel 语义变化：${changedCells.changed.length} 个单元格修改，${changedCells.added.length} 个新增，${changedCells.removed.length} 个删除`
      : "Excel 工作簿语义未变化",
    details,
  };
}

/**
 * 用实际工作簿语义变化核对 Agent 的修改计划。该结果会同时反馈给模型和用户；
 * 没有结构化定位的信息保持 pending，避免把模型自报完成当成证据。
 */
export function evaluateWorkspaceChangePlan(
  diff: SemanticDiff,
  targets: WorkspaceChangeTarget[],
): WorkspaceChangePlanResult {
  const completed: WorkspaceChangePlanResult["completed"] = [];
  const pending: WorkspaceChangePlanResult["pending"] = [];
  if (!targets.length) return { complete: true, completed, pending };
  if (diff.kind !== "xlsx") {
    return {
      complete: false,
      completed,
      pending: targets.map((target) => ({ ...target, reason: "该目标尚无可确定性判定的结构化位置" })),
    };
  }

  const raw = diff.details.cellChanges as {
    added?: Array<{ address: string; after?: CellSnapshot }>;
    removed?: Array<{ address: string; before?: CellSnapshot }>;
    changed?: Array<{ address: string; before?: CellSnapshot; after?: CellSnapshot }>;
  } | undefined;
  const changes = new Map<string, { before?: CellSnapshot; after?: CellSnapshot }>();
  for (const item of raw?.added ?? []) changes.set(item.address, { after: item.after });
  for (const item of raw?.removed ?? []) changes.set(item.address, { before: item.before });
  for (const item of raw?.changed ?? []) changes.set(item.address, { before: item.before, after: item.after });

  for (const target of targets) {
    // Plans are authored by the model and can contain a contradictory
    // mustChange=true on an invariant such as "保持原公式不变".  Preserve the
    // user's semantic intent: invariant targets prove that no diff exists.
    const invariantIntent = /保持.{0,20}不变|(?:保持|保留|维持)(?:\s*ok|原|未修改)|不(?:要|得|应)修改|禁止修改|原样保留/.test(
      target.description,
    );
    const mustChange = invariantIntent ? false : (target.mustChange ?? true);
    if (!target.sheet) {
      pending.push({ ...target, reason: "缺少 sheet，无法确定性核对" });
      continue;
    }
    if (!target.cell) {
      const sheetPrefix = `${target.sheet}!`;
      const sheetChanged = [...changes.keys()].some((address) => address.startsWith(sheetPrefix));
      if (mustChange !== sheetChanged) {
        pending.push({
          ...target,
          address: target.sheet,
          reason: mustChange ? "目标工作表没有发生单元格变化" : "要求保持不变的工作表发生了变化",
        });
      } else {
        completed.push({ ...target, address: target.sheet });
      }
      continue;
    }
    const address = `${target.sheet}!${target.cell.toUpperCase()}`;
    const change = changes.get(address);
    if (mustChange && !change) {
      pending.push({ ...target, address, reason: "目标单元格没有发生变化" });
      continue;
    }
    if (!mustChange && change) {
      pending.push({ ...target, address, reason: "要求保持不变的单元格发生了变化" });
      continue;
    }
    if (!mustChange) {
      completed.push({ ...target, address });
      continue;
    }
    const actual = change?.after;
    if (Object.hasOwn(target, "expectedValue") && !cellValuesEquivalent(actual?.value, target.expectedValue)) {
      // Agent freezes the plan before calculation.  A cell whose formula is
      // preserved but whose cached result changed is a derived outcome, not a
      // direct edit target; do not force the workbook to match an early model
      // estimate.  Financial/delivery validators remain the authority for the
      // derived result.  Direct input cells still fail closed on a mismatch.
      const preservedDerivedFormula = Boolean(
        change?.before?.formula
        && actual?.formula
        && change.before.formula === actual.formula,
      );
      if (!preservedDerivedFormula) {
        pending.push({ ...target, address, reason: `结果值不符：实际为 ${displayValue(actual?.value)}` });
        continue;
      }
    }
    if (target.expectedFormula != null) {
      const expected = target.expectedFormula.replace(/^=/, "");
      if ((actual?.formula ?? "") !== expected) {
        pending.push({ ...target, address, reason: `公式不符：实际为 ${actual?.formula ? `=${actual.formula}` : "空"}` });
        continue;
      }
    }
    completed.push({ ...target, address });
  }
  return { complete: pending.length === 0, completed, pending };
}

async function snapshotWorkbook(filePath: string): Promise<WorkbookSnapshot> {
  const bytes = await readFile(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const cells: Record<string, CellSnapshot> = {};
  const hiddenRows: string[] = [];
  const hiddenColumns: string[] = [];
  const tables: string[] = [];
  const validations: string[] = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (row.hidden) hiddenRows.push(`${sheet.name}!${rowNumber}`);
      row.eachCell({ includeEmpty: false }, (cell) => {
        const model = cell.value as { formula?: string; result?: unknown } | null;
        cells[`${sheet.name}!${cell.address}`] = {
          formula: model && typeof model === "object" && "formula" in model ? String(model.formula ?? "") : null,
          value: normalizeCellValue(model && typeof model === "object" && "formula" in model ? model.result : cell.value),
          style: stableJson({
            numFmt: cell.numFmt, font: cell.font, fill: cell.fill, border: cell.border,
            alignment: cell.alignment, protection: cell.protection,
          }),
          comment: cell.note ? stableJson(cell.note) : null,
        };
      });
    });
    for (let index = 1; index <= sheet.columnCount; index += 1) {
      if (sheet.getColumn(index).hidden) hiddenColumns.push(`${sheet.name}!${index}`);
    }
    const model = sheet.model as unknown as { tables?: Array<{ name?: string; tableRef?: string }>; dataValidations?: unknown };
    for (const table of model.tables ?? []) tables.push(`${sheet.name}:${table.name ?? ""}:${table.tableRef ?? ""}`);
    if (model.dataValidations) validations.push(`${sheet.name}:${stableJson(model.dataValidations)}`);
  }
  const zip = await JSZip.loadAsync(bytes);
  const packageParts: Record<string, string> = {};
  const semanticParts = Object.keys(zip.files).filter((name) =>
    /^(xl\/(charts|pivotTables|pivotCache|externalLinks)\/|xl\/connections\.xml|xl\/vbaProject\.bin|xl\/workbook\.xml)/.test(name),
  );
  for (const name of semanticParts.sort()) packageParts[name] = digest(await zip.file(name)!.async("uint8array"));
  const names = (((workbook as unknown as { model?: { definedNames?: { model?: unknown[] } } }).model?.definedNames?.model) ?? [])
    .map((item) => stableJson(item)).sort();
  return {
    sheets: workbook.worksheets.map((sheet) => ({ name: sheet.name, state: sheet.state, rowCount: sheet.rowCount, columnCount: sheet.columnCount })),
    cells,
    names,
    tables: tables.sort(), validations: validations.sort(), hiddenRows: hiddenRows.sort(), hiddenColumns: hiddenColumns.sort(), packageParts,
    hasMacros: Boolean(zip.file("xl/vbaProject.bin")),
  };
}

async function textSemanticDiff(beforePath: string, afterPath: string, extension: string): Promise<SemanticDiff> {
  const [before, after] = await Promise.all([readFile(beforePath, "utf8"), readFile(afterPath, "utf8")]);
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const changedLines: Array<{ line: number; before: string | null; after: string | null }> = [];
  for (let index = 0; index < max; index += 1) {
    if (beforeLines[index] !== afterLines[index]) changedLines.push({ line: index + 1, before: beforeLines[index] ?? null, after: afterLines[index] ?? null });
  }
  const delimiter = extension === ".csv" ? "," : extension === ".tsv" ? "\t" : null;
  return {
    kind: "text",
    changed: before !== after,
    summary: before === after ? "文本内容未变化" : `文本有 ${changedLines.length} 行变化`,
    details: {
      changedLines: changedLines.slice(0, 2_000), truncated: changedLines.length > 2_000,
      beforeLines: beforeLines.length, afterLines: afterLines.length,
      ...(delimiter ? { beforeFields: beforeLines.map((line) => line.split(delimiter).length), afterFields: afterLines.map((line) => line.split(delimiter).length) } : {}),
    },
  };
}

function normalizeCellValue(value: unknown): unknown {
  if (value instanceof Date) {
    // ExcelJS 会把越界/损坏的 Excel 日期解析成 Invalid Date。直接调用
    // toISOString() 会让整次复核以 RangeError("Invalid time value") 崩掉；
    // 无效日期本身仍应作为可比较、可报告的单元格值保留下来。
    return Number.isFinite(value.getTime())
      ? value.toISOString()
      : { kind: "invalid_excel_date", value: "Invalid Date" };
  }
  if (Buffer.isBuffer(value)) return { bytesSha256: digest(value) };
  return JSON.parse(stableJson(value));
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function cellValuesEquivalent(actual: unknown, expected: unknown): boolean {
  if (stableJson(actual) === stableJson(expected)) return true;
  if (
    (typeof actual === "number" || typeof actual === "string")
    && (typeof expected === "number" || typeof expected === "string")
  ) {
    const left = typeof actual === "number" ? actual : Number(actual.replace(/,/g, "").trim());
    const right = typeof expected === "number" ? expected : Number(expected.replace(/,/g, "").trim());
    if (Number.isFinite(left) && Number.isFinite(right)) {
      return Math.abs(left - right) <= Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 1e-12);
    }
  }
  return false;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  return value ?? null;
}

function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

function displayValue(value: unknown): string {
  const rendered = stableJson(value);
  return rendered.length > 120 ? `${rendered.slice(0, 117)}…` : rendered;
}

function diffRecord<T>(before: Record<string, T>, after: Record<string, T>) {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  return {
    added: [...afterKeys].filter((key) => !beforeKeys.has(key)),
    removed: [...beforeKeys].filter((key) => !afterKeys.has(key)),
    changed: [...beforeKeys].filter((key) => afterKeys.has(key) && stableJson(before[key]) !== stableJson(after[key])),
  };
}

function diffArray<T>(before: T[], after: T[], key: (item: T) => string = (item) => stableJson(item)) {
  const beforeMap = new Map(before.map((item) => [key(item), item]));
  const afterMap = new Map(after.map((item) => [key(item), item]));
  return {
    added: [...afterMap.keys()].filter((item) => !beforeMap.has(item)),
    removed: [...beforeMap.keys()].filter((item) => !afterMap.has(item)),
    changed: [...beforeMap.keys()].filter((item) => afterMap.has(item) && stableJson(beforeMap.get(item)) !== stableJson(afterMap.get(item))),
  };
}
