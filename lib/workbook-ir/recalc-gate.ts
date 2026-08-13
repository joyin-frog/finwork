import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spreadsheetRecalc, type RecalcResult, type RuntimeCommandResult } from "@/lib/runtime/spreadsheet-runtime";

export type RecalcGateResult =
  | { status: "verified"; evidence: RecalcResult & { candidateSha256: string } }
  | { status: "blocked"; code: string; detail: string };

export type RecalcProvider = (filePath: string) => Promise<RuntimeCommandResult<RecalcResult>>;

export async function requireWorkbookRecalculation(filePath: string, provider: RecalcProvider = spreadsheetRecalc): Promise<RecalcGateResult> {
  const result = await provider(filePath);
  if (!result.ok || !result.data?.outputPath) return { status: "blocked", code: result.errorCode ?? "recalc_unavailable", detail: result.detail ?? "No controlled calculation provider is available" };
  const candidateSha256 = createHash("sha256").update(await readFile(result.data.outputPath)).digest("hex");
  if (candidateSha256 !== result.data.outputHash) return { status: "blocked", code: "recalc_evidence_hash_mismatch", detail: "Recalculated artifact hash does not match provider evidence" };
  return { status: "verified", evidence: { ...result.data, candidateSha256 } };
}

