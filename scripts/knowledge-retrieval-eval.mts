import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getDb } from "../lib/db/sqlite.ts";
import {
  closeProductionRetrievalService,
  getProductionRetrievalService,
} from "../lib/retrieval/production.ts";
import {
  evaluateKnowledgeRetrieval,
  type KnowledgeRetrievalEvalCase,
} from "../lib/retrieval/evaluation.ts";

const RawCaseSchema = z.object({
  id: z.string().trim().min(1),
  query: z.string().trim().min(1),
  shouldFind: z.boolean().default(true),
  relevantKnowledgeDocumentIds: z.array(z.number().int().positive()).default([]),
  expectedQuotes: z.array(z.string().trim().min(1)).default([]),
  topK: z.number().int().min(1).max(100).default(5),
}).strict().superRefine((value, context) => {
  if (value.shouldFind && value.relevantKnowledgeDocumentIds.length === 0) {
    context.addIssue({ code: "custom", path: ["relevantKnowledgeDocumentIds"], message: "positive cases require at least one relevant document" });
  }
});

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readCases(filePath: string) {
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return RawCaseSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

const casesPath = option("--cases");
if (!casesPath) throw new Error("usage: pnpm eval:knowledge-retrieval -- --cases <cases.jsonl> [--out <report.json>]");
const rawCases = readCases(path.resolve(casesPath));
const db = getDb();
const service = getProductionRetrievalService();

try {
  await service.ensureKnowledgeDocumentsReady();
  const evalCases: KnowledgeRetrievalEvalCase[] = rawCases.map((raw) => {
    const relevantArtifactVersionIds = raw.relevantKnowledgeDocumentIds.map((documentId) => {
      const row = db.prepare(`
        SELECT artifact_version_id FROM knowledge_retrieval_bindings WHERE knowledge_document_id=?
      `).get(documentId) as { artifact_version_id: string } | undefined;
      if (!row) throw new Error(`knowledge document ${documentId} has no governed retrieval binding; re-upload the source if its text mirror is missing`);
      return row.artifact_version_id;
    });
    return {
      id: raw.id,
      query: raw.query,
      shouldFind: raw.shouldFind,
      relevantArtifactVersionIds,
      expectedQuotes: raw.expectedQuotes,
      topK: raw.topK,
    };
  });
  const report = await evaluateKnowledgeRetrieval(service, evalCases);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = option("--out");
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, serialized);
  }
  process.stdout.write(serialized);
  if (report.totals.failed > 0) process.exitCode = 2;
} finally {
  await closeProductionRetrievalService();
}
