import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadManifest } from "./manifest";
import {
  buildRescoreResult,
  createManualReview,
  loadAttempts,
  validateManualReview,
  type ManualReview,
} from "./rescore-core";

type Options = {
  baselineRoot: string;
  reviewPath?: string;
  outputPath?: string;
};

export function parseRescoreArgs(argv: string[]): Options {
  let baselineRoot = "";
  let reviewPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--baseline") baselineRoot = path.resolve(argv[++index] ?? "");
    else if (arg === "--review") reviewPath = path.resolve(argv[++index] ?? "");
    else if (arg === "--output") outputPath = path.resolve(argv[++index] ?? "");
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!baselineRoot) throw new Error("usage: rescore.ts --baseline <evidence-dir> [--review review.json] [--output result.json]");
  return { baselineRoot, reviewPath, outputPath };
}

function main(): void {
  const options = parseRescoreArgs(process.argv.slice(2));
  const manifestPath = path.join(options.baselineRoot, "manifest.json");
  const summaryPath = path.join(options.baselineRoot, "summary.json");
  if (!existsSync(manifestPath) || !existsSync(summaryPath)) {
    throw new Error(`不是有效 AS0 baseline 目录: ${options.baselineRoot}`);
  }
  const baselineManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { baselineId?: string };
  const baselineId = baselineManifest.baselineId;
  if (!baselineId) throw new Error("baseline manifest 缺少 baselineId");
  const attempts = loadAttempts(options.baselineRoot);
  const { manifest } = loadManifest();

  if (!options.reviewPath) {
    const review = createManualReview({ baselineId, attempts });
    const templatePath = options.outputPath ?? path.join(options.baselineRoot, "manual-review.json");
    writeFileSync(templatePath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      mode: "prepare-review",
      baselineId,
      decisions: review.decisions.length,
      output: templatePath,
    }, null, 2));
    return;
  }

  const review = JSON.parse(readFileSync(options.reviewPath, "utf8")) as ManualReview;
  validateManualReview({ review, baselineId, attempts });
  const result = buildRescoreResult({
    baselineId,
    baselineRoot: options.baselineRoot,
    manifest,
    attempts,
    review,
  });
  const resultPath = options.outputPath ?? path.join(options.baselineRoot, "rescored-summary.json");
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ mode: "rescore", ...result.summary, output: resultPath }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
