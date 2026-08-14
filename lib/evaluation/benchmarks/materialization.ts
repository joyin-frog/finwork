import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "@/lib/artifacts/store";
import type { ArtifactRef } from "@/lib/artifacts/contracts";
import { DocumentLocatorSchema, type DocumentLocator } from "@/lib/artifacts/contracts";
import { canonicalJson } from "@/lib/capability/hash";
import type { RetrievalIndexer } from "@/lib/retrieval/indexer";
import {
  BenchmarkImportManifestSchema,
  BenchmarkMaterializationManifestSchema,
  type BenchmarkCaseMaterialization,
  type BenchmarkImportManifest,
  type BenchmarkMaterializationManifest,
  type BenchmarkMaterializedSource,
  type NormalizedBenchmarkCase,
} from "./contracts";
import { readNormalizedBenchmarkCases } from "./importer";

export interface BenchmarkRetrievalMaterializer {
  indexer: RetrievalIndexer;
  embeddingModel: string;
  parserVersion?: string;
  chunkerVersion?: string;
}

export interface MaterializeBenchmarkImportOptions {
  db: DatabaseSync;
  casRoot: string;
  importManifestPath: string;
  casesPath: string;
  assetsRoot: string;
  acknowledgeLicenseReview: true;
  retrieval?: BenchmarkRetrievalMaterializer;
  createdAt?: string;
}

export interface MaterializeBenchmarkImportResult {
  manifest: BenchmarkMaterializationManifest;
  cases: NormalizedBenchmarkCase[];
  inputArtifactsByCaseId: Record<string, ArtifactRef[]>;
}

export async function materializeBenchmarkImport(
  options: MaterializeBenchmarkImportOptions,
): Promise<MaterializeBenchmarkImportResult> {
  const [manifestBytes, cases] = await Promise.all([
    fs.readFile(options.importManifestPath),
    readNormalizedBenchmarkCases(options.casesPath),
  ]);
  const importManifest = BenchmarkImportManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  verifyImportedCases(importManifest, cases);
  const artifacts = new ArtifactStore(options.db, options.casRoot);
  const assetsRoot = await fs.realpath(path.resolve(options.assetsRoot));
  const materializedCases: BenchmarkCaseMaterialization[] = [];
  const inputArtifactsByCaseId: Record<string, ArtifactRef[]> = {};
  const createdAt = options.createdAt ?? new Date().toISOString();

  for (const benchmarkCase of cases) {
    if (needsRetrieval(benchmarkCase) && !options.retrieval) {
      throw new Error(`benchmark_retrieval_materializer_unavailable:${benchmarkCase.id}`);
    }
    const sources: BenchmarkMaterializedSource[] = [];
    const inputArtifacts: ArtifactRef[] = [];
    const oracleArtifacts: ArtifactRef[] = [];
    for (const block of benchmarkCase.context.textBlocks) {
      const source = await materializeGeneratedSource({
        artifacts,
        benchmarkCase,
        sourceId: block.id,
        logicalName: `${block.id}.md`,
        content: [block.title ? `# ${block.title}` : "", block.text].filter(Boolean).join("\n\n"),
        locator: block.locator ?? `node:${block.id}`,
        retrieval: needsRetrieval(benchmarkCase) ? options.retrieval : undefined,
        createdAt,
      });
      sources.push(source);
      inputArtifacts.push(source.artifactRef);
    }
    for (const table of benchmarkCase.context.tables) {
      const source = await materializeGeneratedSource({
        artifacts,
        benchmarkCase,
        sourceId: table.id,
        logicalName: `${table.id}.tsv`,
        content: [table.columns, ...table.rows].map((row) => row.join("\t")).join("\n"),
        locator: `table:${table.id}`,
        retrieval: needsRetrieval(benchmarkCase) ? options.retrieval : undefined,
        createdAt,
      });
      sources.push(source);
      inputArtifacts.push(source.artifactRef);
    }
    for (const file of benchmarkCase.context.files) {
      if (file.artifactRef) {
        assertArtifactRefExists(options.db, file.artifactRef);
        inputArtifacts.push(file.artifactRef);
        sources.push({
          sourceId: file.logicalName,
          artifactRef: file.artifactRef,
          locator: `artifact:${file.artifactRef.versionId}`,
        });
        continue;
      }
      if (!file.upstreamUri) {
        throw new Error(`benchmark_input_not_materialized:${benchmarkCase.id}:${file.logicalName}`);
      }
      const sourcePath = await resolveAssetPath(assetsRoot, file.upstreamUri);
      const content = await fs.readFile(sourcePath);
      const artifact = artifacts.put({
        kind: "benchmark_input",
        logicalName: file.logicalName,
        classification: "public",
        retention: { policyId: "benchmark-ephemeral", datasetId: benchmarkCase.datasetId },
        mediaType: file.mediaType,
        producer: { component: "benchmark-materializer", version: "1.0.0" },
        metadata: {
          sourceId: file.logicalName,
          caseId: benchmarkCase.id,
          sourceSha256: benchmarkCase.provenance.sourceSha256,
        },
        content,
        state: "candidate",
      });
      inputArtifacts.push(artifact);
      sources.push({ sourceId: file.logicalName, artifactRef: artifact, locator: `artifact:${artifact.versionId}` });
    }
    const spreadsheetOracle = benchmarkCase.expected.artifact?.oracle;
    if (spreadsheetOracle) {
      const sourcePath = await resolveAssetPath(assetsRoot, spreadsheetOracle.goldenUpstreamUri);
      const content = await fs.readFile(sourcePath);
      oracleArtifacts.push(artifacts.put({
        kind: "benchmark_oracle",
        logicalName: path.basename(spreadsheetOracle.goldenUpstreamUri),
        classification: "public",
        retention: { policyId: "benchmark-ephemeral", datasetId: benchmarkCase.datasetId },
        mediaType: benchmarkCase.expected.artifact!.mediaType,
        producer: { component: "benchmark-materializer", version: "1.0.0" },
        metadata: {
          caseId: benchmarkCase.id,
          oracleType: "spreadsheetbench_v2_golden",
          answerRange: spreadsheetOracle.answerRange,
        },
        content,
        state: "candidate",
      }));
    }
    const uniqueInputs = dedupeArtifacts(inputArtifacts);
    inputArtifactsByCaseId[benchmarkCase.id] = uniqueInputs;
    materializedCases.push({
      caseId: benchmarkCase.id,
      normalizedCaseSha256: sha256(canonicalJson(benchmarkCase)),
      inputArtifacts: uniqueInputs,
      ...(oracleArtifacts.length > 0 ? { oracleArtifacts } : {}),
      sources,
    });
  }

  const manifest = BenchmarkMaterializationManifestSchema.parse({
    schemaVersion: 1,
    datasetId: importManifest.datasetId,
    datasetVersion: importManifest.datasetVersion,
    split: importManifest.split,
    importManifestSha256: sha256(manifestBytes),
    sourceSha256: importManifest.sourceSha256,
    licenseStatus: importManifest.descriptor.license.status,
    licenseAcknowledged: options.acknowledgeLicenseReview,
    createdAt,
    cases: materializedCases,
  });
  return { manifest, cases, inputArtifactsByCaseId };
}

export async function writeBenchmarkMaterializationManifest(
  manifest: BenchmarkMaterializationManifest,
  outputPath: string,
): Promise<void> {
  const parsed = BenchmarkMaterializationManifestSchema.parse(manifest);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, outputPath);
}

export async function readBenchmarkMaterializationManifest(
  manifestPath: string,
): Promise<BenchmarkMaterializationManifest> {
  return BenchmarkMaterializationManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, "utf8")));
}

function verifyImportedCases(manifest: BenchmarkImportManifest, cases: readonly NormalizedBenchmarkCase[]): void {
  if (cases.length !== manifest.normalizedCases) {
    throw new Error(`benchmark_manifest_case_count_mismatch:${manifest.normalizedCases}:${cases.length}`);
  }
  for (const benchmarkCase of cases) {
    if (benchmarkCase.datasetId !== manifest.datasetId
      || benchmarkCase.datasetVersion !== manifest.datasetVersion
      || benchmarkCase.split !== manifest.split
      || benchmarkCase.provenance.sourceSha256 !== manifest.sourceSha256) {
      throw new Error(`benchmark_manifest_source_mismatch:${benchmarkCase.id}`);
    }
  }
}

async function materializeGeneratedSource(input: {
  artifacts: ArtifactStore;
  benchmarkCase: NormalizedBenchmarkCase;
  sourceId: string;
  logicalName: string;
  content: string;
  locator: string;
  retrieval?: BenchmarkRetrievalMaterializer;
  createdAt: string;
}): Promise<BenchmarkMaterializedSource> {
  const artifact = input.artifacts.put({
    kind: "benchmark_source_context",
    logicalName: input.logicalName,
    classification: "public",
    retention: { policyId: "benchmark-ephemeral", datasetId: input.benchmarkCase.datasetId },
    mediaType: input.logicalName.endsWith(".tsv") ? "text/csv" : "text/markdown",
    producer: { component: "benchmark-materializer", version: "1.0.0" },
    metadata: {
      sourceId: input.sourceId,
      caseId: input.benchmarkCase.id,
      sourceSha256: input.benchmarkCase.provenance.sourceSha256,
    },
    content: new TextEncoder().encode(input.content),
    state: "candidate",
  });
  if (!input.retrieval) return { sourceId: input.sourceId, artifactRef: artifact, locator: input.locator };
  const registration = input.retrieval.indexer.register({
    artifactId: artifact.artifactId,
    artifactVersionId: artifact.versionId,
    contentHash: artifact.sha256,
    mediaType: artifact.mediaType,
    metadata: {
      title: input.sourceId,
      documentType: `benchmark:${input.benchmarkCase.datasetId}`,
      entityRefs: [],
      classification: "public",
    },
    acl: [{
      principal: { id: "benchmark-runner", type: "service", tenantId: "benchmark" },
      grantedAt: input.createdAt,
    }],
    embeddingModel: input.retrieval.embeddingModel,
    requestedAt: input.createdAt,
    parserVersion: input.retrieval.parserVersion ?? "benchmark-parser-v1",
    chunkerVersion: input.retrieval.chunkerVersion ?? "structure-chunker-v1",
  });
  if (registration.jobId) {
    await input.retrieval.indexer.processJob(
      registration.jobId,
      `benchmark-materializer:${input.benchmarkCase.id}`,
      input.createdAt,
    );
  }
  const retrievalLocator = parseMaterializedLocator(input.locator);
  input.retrieval.indexer.db.prepare(`
    UPDATE retrieval_chunks SET locator_json = ? WHERE document_id = ?
  `).run(canonicalJson(retrievalLocator), registration.documentId);
  return {
    sourceId: input.sourceId,
    artifactRef: artifact,
    locator: input.locator,
    retrievalDocumentId: registration.documentId,
  };
}

function parseMaterializedLocator(value: string): DocumentLocator {
  const page = /^page:(\d+)$/.exec(value);
  if (page && Number(page[1]) > 0) {
    return DocumentLocatorSchema.parse({ kind: "page", page: Number(page[1]) });
  }
  const table = /^table:(.+)$/.exec(value);
  if (table) return DocumentLocatorSchema.parse({ kind: "table", nodeId: table[1] });
  const node = /^node:(.+)$/.exec(value);
  if (node) return DocumentLocatorSchema.parse({ kind: "node", nodeId: node[1] });
  return DocumentLocatorSchema.parse({ kind: "node", nodeId: value.slice(0, 200) });
}

async function resolveAssetPath(root: string, upstreamUri: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(upstreamUri)) {
    throw new Error(`benchmark_external_asset_uri_forbidden:${upstreamUri}`);
  }
  const candidate = await fs.realpath(path.resolve(root, upstreamUri));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`benchmark_asset_path_escape:${upstreamUri}`);
  }
  return candidate;
}

function assertArtifactRefExists(db: DatabaseSync, artifact: ArtifactRef): void {
  const row = db.prepare(`
    SELECT v.sha256, v.media_type, a.logical_name
    FROM artifact_versions v JOIN artifacts a ON a.artifact_id=v.artifact_id
    WHERE v.version_id=? AND v.artifact_id=?
  `).get(artifact.versionId, artifact.artifactId) as {
    sha256: string;
    media_type: string;
    logical_name: string;
  } | undefined;
  if (!row || row.sha256 !== artifact.sha256 || row.media_type !== artifact.mediaType || row.logical_name !== artifact.logicalName) {
    throw new Error(`benchmark_artifact_ref_mismatch:${artifact.versionId}`);
  }
}

function needsRetrieval(benchmarkCase: NormalizedBenchmarkCase): boolean {
  return benchmarkCase.capabilities.includes("retrieval") || benchmarkCase.capabilities.includes("citation");
}

function dedupeArtifacts(artifacts: readonly ArtifactRef[]): ArtifactRef[] {
  return [...new Map(artifacts.map((artifact) => [artifact.versionId, artifact])).values()];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
