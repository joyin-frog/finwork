import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BenchmarkDatasetIdSchema,
  BenchmarkImportManifestSchema,
  NormalizedBenchmarkCaseSchema,
  type BenchmarkDatasetId,
  type BenchmarkImportManifest,
  type NormalizedBenchmarkCase,
} from "./contracts";
import { getBenchmarkDatasetDescriptor } from "./catalog";
import { BenchmarkAdapterRegistry, createBuiltInBenchmarkAdapterRegistry } from "./registry";

export interface BenchmarkImportOptions {
  datasetId: BenchmarkDatasetId;
  datasetVersion: string;
  split: string;
  sourcePath: string;
  acknowledgeLicenseReview: boolean;
  registry?: BenchmarkAdapterRegistry;
  importedAt?: string;
}

export interface BenchmarkImportResult {
  manifest: BenchmarkImportManifest;
  cases: NormalizedBenchmarkCase[];
}

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function parseJsonOrJsonl(content: string): unknown[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["data", "records", "items", "examples"]) {
        if (Array.isArray(record[key])) return record[key] as unknown[];
      }
    }
    return [parsed];
  } catch (jsonError) {
    const records: unknown[] = [];
    for (const [index, line] of trimmed.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        throw new Error(`invalid benchmark source: JSON parse failed and JSONL line ${index + 1} is invalid`, {
          cause: jsonError,
        });
      }
    }
    return records;
  }
}

function assertImportOptions(options: BenchmarkImportOptions): void {
  const descriptor = getBenchmarkDatasetDescriptor(BenchmarkDatasetIdSchema.parse(options.datasetId));
  if (descriptor.integrationStatus === "reference_only") {
    throw new Error(
      `${descriptor.displayName} is reference-only until its authoritative source, execution environment, and adapter schema are verified`,
    );
  }
  if (!descriptor.supportedSplits.includes(options.split)) {
    throw new Error(
      `unsupported ${descriptor.id} split "${options.split}"; expected one of ${descriptor.supportedSplits.join(", ")}`,
    );
  }
  if (descriptor.license.status === "review_required" && !options.acknowledgeLicenseReview) {
    throw new Error(
      `${descriptor.displayName} requires an explicit license review acknowledgement before import`,
    );
  }
}

export async function importExternalBenchmarkSource(
  options: BenchmarkImportOptions,
): Promise<BenchmarkImportResult> {
  assertImportOptions(options);
  const descriptor = getBenchmarkDatasetDescriptor(options.datasetId);
  const registry = options.registry ?? createBuiltInBenchmarkAdapterRegistry();
  const adapter = registry.get(descriptor.sourceFormat);
  const source = await readFile(options.sourcePath);
  const sourceText = source.toString("utf8");
  const sourceSha256 = sha256(source);
  const records = parseJsonOrJsonl(sourceText);
  if (records.length === 0) {
    throw new Error(`${descriptor.displayName} source contains no records`);
  }
  const cases = records.flatMap((record, sourceRecordIndex) =>
    adapter.adapt(record, {
      descriptor,
      datasetVersion: options.datasetVersion,
      split: options.split,
      sourceSha256,
      sourceRecordIndex,
    }),
  );
  if (cases.length === 0) {
    throw new Error(`${descriptor.displayName} adapter produced no normalized benchmark cases`);
  }

  const seen = new Set<string>();
  for (const [index, benchmarkCase] of cases.entries()) {
    NormalizedBenchmarkCaseSchema.parse(benchmarkCase);
    if (seen.has(benchmarkCase.id)) {
      throw new Error(`duplicate normalized benchmark case id at index ${index}: ${benchmarkCase.id}`);
    }
    seen.add(benchmarkCase.id);
  }

  const manifest = BenchmarkImportManifestSchema.parse({
    schemaVersion: 1,
    datasetId: descriptor.id,
    datasetVersion: options.datasetVersion,
    split: options.split,
    sourceSha256,
    sourceBytes: source.byteLength,
    sourceRecords: records.length,
    normalizedCases: cases.length,
    descriptor,
    importedAt: options.importedAt ?? new Date().toISOString(),
  });
  return { manifest, cases };
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}

export async function writeBenchmarkImport(
  result: BenchmarkImportResult,
  outputDirectory: string,
): Promise<{ manifestPath: string; casesPath: string }> {
  const manifestPath = path.join(outputDirectory, "import-manifest.json");
  const casesPath = path.join(outputDirectory, "cases.jsonl");
  await writeAtomic(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  await writeAtomic(casesPath, result.cases.map((benchmarkCase) => JSON.stringify(benchmarkCase)).join("\n") + (result.cases.length ? "\n" : ""));
  return { manifestPath, casesPath };
}

export async function readNormalizedBenchmarkCases(filePath: string): Promise<NormalizedBenchmarkCase[]> {
  const content = await readFile(filePath, "utf8");
  return parseJsonOrJsonl(content).map((item, index) => {
    try {
      return NormalizedBenchmarkCaseSchema.parse(item);
    } catch (error) {
      throw new Error(`invalid normalized benchmark case at index ${index}`, { cause: error });
    }
  });
}
