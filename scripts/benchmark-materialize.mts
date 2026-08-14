import path from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { getDb } from "../lib/db/sqlite.ts";
import { getAppDataDir } from "../lib/runtime/paths.ts";
import { closeProductionRetrievalService, getProductionRetrievalService } from "../lib/retrieval/production.ts";
import { EMBED_MODEL } from "../lib/knowledge/embed-model.ts";
import {
  materializeBenchmarkImport,
  writeBenchmarkMaterializationManifest,
} from "../lib/evaluation/benchmarks/materialization.ts";

function parseArgs(argv: string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const [key, inlineValue] = item.slice(2).split("=", 2);
    if (inlineValue !== undefined) values.set(key!, inlineValue);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) values.set(key!, argv[++index]!);
    else values.set(key!, true);
  }
  return values;
}

function required(args: Map<string, string | true>, key: string): string {
  const value = args.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing required --${key}`);
  return value;
}

const args = parseArgs(process.argv.slice(2));
if (args.has("help")) {
  console.log("Usage: pnpm benchmarks:materialize -- --import-dir <dir> --assets-root <dir> --ack-license [--output <manifest.json>]");
  process.exit(0);
}
if (args.get("ack-license") !== true) throw new Error("materialization requires explicit --ack-license");
const importDir = path.resolve(required(args, "import-dir"));
const assetsRoot = path.resolve(required(args, "assets-root"));
const outputPath = path.resolve(
  typeof args.get("output") === "string"
    ? String(args.get("output"))
    : path.join(importDir, "materialization-manifest.json"),
);
const db = getDb();
const retrieval = getProductionRetrievalService();
try {
  const result = await materializeBenchmarkImport({
    db,
    casRoot: path.join(getAppDataDir(), "artifacts", "cas"),
    importManifestPath: path.join(importDir, "import-manifest.json"),
    casesPath: path.join(importDir, "cases.jsonl"),
    assetsRoot,
    acknowledgeLicenseReview: true,
    retrieval: { indexer: retrieval.indexer, embeddingModel: EMBED_MODEL },
  });
  await writeBenchmarkMaterializationManifest(result.manifest, outputPath);
  const goalStatePath = path.join(
    process.cwd(),
    ".finwork-test",
    "benchmarks",
    "goal",
    "spec-real-api-benchmark-execution-v1",
    "state.json",
  );
  let goalRegistered = false;
  try {
    const state = JSON.parse(await readFile(goalStatePath, "utf8")) as {
      importedManifests?: Array<{
        importManifestPath: string;
        casesPath: string;
        materializationManifestPath: string;
        datasetId?: string;
        datasetVersion?: string;
        split?: string;
      }>;
      [key: string]: unknown;
    };
    const registration = {
      importManifestPath: path.join(importDir, "import-manifest.json"),
      casesPath: path.join(importDir, "cases.jsonl"),
      materializationManifestPath: outputPath,
      datasetId: result.manifest.datasetId,
      datasetVersion: result.manifest.datasetVersion,
      split: result.manifest.split,
    };
    const existing = (state.importedManifests ?? []).filter((entry) =>
      entry.datasetId !== registration.datasetId
      || entry.datasetVersion !== registration.datasetVersion
      || entry.split !== registration.split
    );
    const temporary = `${goalStatePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      ...state,
      importedManifests: [...existing, registration],
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, goalStatePath);
    goalRegistered = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  console.log(JSON.stringify({
    datasetId: result.manifest.datasetId,
    datasetVersion: result.manifest.datasetVersion,
    split: result.manifest.split,
    cases: result.manifest.cases.length,
    sourceSha256: result.manifest.sourceSha256,
    importManifestSha256: result.manifest.importManifestSha256,
    outputPath,
    goalRegistered,
  }, null, 2));
} finally {
  await closeProductionRetrievalService();
}
