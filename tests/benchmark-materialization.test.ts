import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import {
  importExternalBenchmarkSource,
  writeBenchmarkImport,
} from "../lib/evaluation/benchmarks/importer.ts";
import {
  materializeBenchmarkImport,
  writeBenchmarkMaterializationManifest,
  readBenchmarkMaterializationManifest,
} from "../lib/evaluation/benchmarks/materialization.ts";
import { RetrievalIndexer, defaultTextRetrievalParser } from "../lib/retrieval/indexer.ts";
import { RetrievalSearchService } from "../lib/retrieval/search.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

const fixedEmbedder = async (texts: readonly string[]) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);

export const benchmarkMaterializationTestPromise = (async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "finwork-benchmark-materialization-"));
  const db = makeDb();
  try {
    const casRoot = path.join(root, "cas");
    const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "benchmarks");
    const spreadsheetImport = await importExternalBenchmarkSource({
      datasetId: "spreadsheetbench_v2",
      datasetVersion: "synthetic-v2",
      split: "test",
      sourcePath: path.join(fixtureRoot, "spreadsheetbench.sample.json"),
      acknowledgeLicenseReview: true,
      importedAt: "2026-08-13T00:00:00.000Z",
    });
    const spreadsheetImportDir = path.join(root, "imports", "spreadsheet");
    const spreadsheetFiles = await writeBenchmarkImport(spreadsheetImport, spreadsheetImportDir);
    const assetsRoot = path.join(root, "assets");
    mkdirSync(assetsRoot, { recursive: true });
    writeFileSync(path.join(assetsRoot, "synthetic-input.xlsx"), Buffer.from("synthetic-xlsx-input"));

    const spreadsheet = await materializeBenchmarkImport({
      db,
      casRoot,
      importManifestPath: spreadsheetFiles.manifestPath,
      casesPath: spreadsheetFiles.casesPath,
      assetsRoot,
      acknowledgeLicenseReview: true,
      createdAt: "2026-08-13T00:00:01.000Z",
    });
    const spreadsheetCase = spreadsheet.manifest.cases[0]!;
    assert.equal(spreadsheetCase.inputArtifacts.length, 1);
    assert.equal(spreadsheetCase.inputArtifacts[0]?.logicalName, "synthetic-input.xlsx");
    assert.equal(
      Buffer.from(new ArtifactStore(db, casRoot).read(spreadsheetCase.inputArtifacts[0]!.versionId)).toString(),
      "synthetic-xlsx-input",
      "Spreadsheet input must be read back through ArtifactStore rather than a host path",
    );

    const manifestPath = path.join(root, "materialized", "spreadsheet.json");
    await writeBenchmarkMaterializationManifest(spreadsheet.manifest, manifestPath);
    assert.deepEqual(await readBenchmarkMaterializationManifest(manifestPath), spreadsheet.manifest);

    const financeImport = await importExternalBenchmarkSource({
      datasetId: "financebench",
      datasetVersion: "synthetic-v1",
      split: "test",
      sourcePath: path.join(fixtureRoot, "financebench.sample.json"),
      acknowledgeLicenseReview: true,
      importedAt: "2026-08-13T00:00:00.000Z",
    });
    const financeImportDir = path.join(root, "imports", "financebench");
    const financeFiles = await writeBenchmarkImport(financeImport, financeImportDir);
    await assert.rejects(
      () => materializeBenchmarkImport({
        db,
        casRoot,
        importManifestPath: financeFiles.manifestPath,
        casesPath: financeFiles.casesPath,
        assetsRoot,
        acknowledgeLicenseReview: true,
      }),
      /benchmark_retrieval_materializer_unavailable/,
      "RAG inputs must not silently bypass Retrieval v2",
    );
    const artifacts = new ArtifactStore(db, casRoot);
    const indexer = new RetrievalIndexer(db, artifacts, defaultTextRetrievalParser, fixedEmbedder);
    const finance = await materializeBenchmarkImport({
      db,
      casRoot,
      importManifestPath: financeFiles.manifestPath,
      casesPath: financeFiles.casesPath,
      assetsRoot,
      acknowledgeLicenseReview: true,
      retrieval: { indexer, embeddingModel: "benchmark-test-embedding" },
      createdAt: "2026-08-13T00:00:02.000Z",
    });
    const financeSource = finance.manifest.cases[0]?.sources[0];
    assert.ok(financeSource?.retrievalDocumentId, "RAG materialization must bind a Retrieval v2 document version");
    const search = new RetrievalSearchService(db).search({
      principal: { id: "benchmark-runner", type: "service", tenantId: "benchmark" },
      query: "operating income",
      mode: "hybrid",
      queryVector: [1, 0, 0, 0, 0, 0, 0, 0],
      embeddingModel: "benchmark-test-embedding",
      filters: { entityRefs: [], documentTypes: [], artifactVersionIds: [] },
      topK: 5,
      candidateLimit: 20,
      cacheTtlSeconds: 0,
      now: "2026-08-13T00:00:03.000Z",
    });
    assert.ok(search.hits.length > 0);
    assert.equal(search.hits[0]?.citation.artifactVersionId, financeSource?.artifactRef.versionId);
    assert.ok(search.hits[0]?.citation.locator, "RAG citation must retain a concrete source locator");

    const tamperedCases = financeImport.cases.map((value) => ({
      ...value,
      provenance: { ...value.provenance, sourceSha256: "f".repeat(64) },
    }));
    const tamperedPath = path.join(financeImportDir, "tampered-cases.jsonl");
    writeFileSync(tamperedPath, tamperedCases.map((value) => JSON.stringify(value)).join("\n") + "\n");
    await assert.rejects(
      () => materializeBenchmarkImport({
        db,
        casRoot,
        importManifestPath: financeFiles.manifestPath,
        casesPath: tamperedPath,
        assetsRoot,
        acknowledgeLicenseReview: true,
        retrieval: { indexer, embeddingModel: "benchmark-test-embedding" },
      }),
      /benchmark_manifest_source_mismatch/,
    );

    console.log("benchmark-materialization: manifest, ArtifactStore, Retrieval v2 and SHA gates passed ✓");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("benchmark-materialization.test")) {
  benchmarkMaterializationTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
