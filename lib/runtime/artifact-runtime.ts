/**
 * Finwork-owned artifact execution contract.
 *
 * This is the production authority exposed to Harness/validators. Providers
 * remain implementation details: OOXML/Python for lossless IO and managed or
 * system LibreOffice only for compatibility recalculation/rendering.
 */
import { semanticDiffFiles } from "@/lib/file-workspace";
import {
  spreadsheetInspect,
  spreadsheetPatchWorkbook,
  spreadsheetProbe,
  spreadsheetRecalc,
  spreadsheetRender,
  type RecalcResult,
  type RenderResult,
  type RuntimeCommandResult,
  type WorkbookEdit,
  type WorkbookPatchResult,
} from "./spreadsheet-runtime";
import type { SpreadsheetCapabilities } from "./spreadsheet-probe";
import type { SemanticDiff } from "@/lib/file-workspace";

export type FinworkArtifactRuntime = {
  probe(): Promise<RuntimeCommandResult<SpreadsheetCapabilities>>;
  inspect(filePath: string): Promise<RuntimeCommandResult>;
  edit(sourcePath: string, outputPath: string, edits: WorkbookEdit[]): Promise<RuntimeCommandResult<WorkbookPatchResult>>;
  calculate(filePath: string): Promise<RuntimeCommandResult<RecalcResult>>;
  diff(beforePath: string, afterPath: string): Promise<RuntimeCommandResult<SemanticDiff>>;
  render(filePath: string, outDir: string): Promise<RuntimeCommandResult<RenderResult>>;
};

export function createFinworkArtifactRuntime(): FinworkArtifactRuntime {
  return {
    probe: spreadsheetProbe,
    inspect: spreadsheetInspect,
    edit: spreadsheetPatchWorkbook,
    calculate: spreadsheetRecalc,
    async diff(beforePath, afterPath) {
      try {
        return { ok: true, data: await semanticDiffFiles(beforePath, afterPath) };
      } catch (error) {
        return {
          ok: false,
          errorCode: "artifact_diff_failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
    render: spreadsheetRender,
  };
}

export const finworkArtifactRuntime = createFinworkArtifactRuntime();
