import path from "node:path";
import { BenchmarkDatasetIdSchema } from "../lib/evaluation/benchmarks/contracts.ts";
import { importExternalBenchmarkSource, writeBenchmarkImport } from "../lib/evaluation/benchmarks/importer.ts";

function parseArgs(argv: string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const [inlineKey, inlineValue] = item.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      values.set(inlineKey!, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(inlineKey!, true);
      continue;
    }
    values.set(inlineKey!, next);
    index += 1;
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
  console.log("Usage: pnpm benchmarks:import -- --dataset <id> --version <version> --split <split> --source <local-json-or-jsonl> --ack-license [--output <directory>]");
  process.exit(0);
}

const datasetId = BenchmarkDatasetIdSchema.parse(required(args, "dataset"));
const datasetVersion = required(args, "version");
const split = required(args, "split");
const sourcePath = path.resolve(required(args, "source"));
const outputDirectory = path.resolve(
  typeof args.get("output") === "string"
    ? String(args.get("output"))
    : path.join(".finwork-test", "benchmarks", "imports", datasetId, datasetVersion, split),
);

const result = await importExternalBenchmarkSource({
  datasetId,
  datasetVersion,
  split,
  sourcePath,
  acknowledgeLicenseReview: args.get("ack-license") === true,
});
const written = await writeBenchmarkImport(result, outputDirectory);
console.log(JSON.stringify({
  datasetId,
  datasetVersion,
  split,
  sourceSha256: result.manifest.sourceSha256,
  normalizedCases: result.manifest.normalizedCases,
  manifestPath: written.manifestPath,
  casesPath: written.casesPath,
}, null, 2));
