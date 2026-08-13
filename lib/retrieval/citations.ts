import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";
import { EvidenceLedger } from "@/lib/evidence/ledger";
import {
  CitationRecordV2Schema,
  RetrievalError,
  type CitationRecordV2,
} from "./contracts";

type CitationSourceRow = {
  artifact_id: string;
  artifact_version_id: string;
  artifact_hash: string;
  document_id: string;
  document_type: string;
  title: string;
  effective_date: string | null;
  locator_json: string;
  text: string;
};

function quoteForCitation(text: string): string {
  return text.length <= 2_000 ? text : `${text.slice(0, 1_999)}…`;
}

export class RetrievalCitationBinder {
  readonly ledger: EvidenceLedger;

  constructor(readonly db: DatabaseSync) {
    this.ledger = new EvidenceLedger(db);
  }

  bind(claimId: string, chunkId: string, rawCitation: CitationRecordV2, at: string, citationId = randomUUID()): string {
    const citation = CitationRecordV2Schema.parse(rawCitation);
    const row = this.db.prepare(`
      SELECT d.artifact_id, d.artifact_version_id, v.sha256 AS artifact_hash,
             d.document_id, d.document_type, d.title, d.effective_date,
             c.locator_json, c.text
      FROM retrieval_chunks c
      JOIN retrieval_documents d ON d.document_id=c.document_id
      JOIN artifact_versions v ON v.version_id=d.artifact_version_id
      WHERE c.chunk_id=? AND c.active=1 AND d.index_status='ready'
    `).get(chunkId) as CitationSourceRow | undefined;
    if (!row) throw new RetrievalError("citation_invalid", `citation chunk is unavailable: ${chunkId}`);

    const expectedQuote = quoteForCitation(row.text);
    const expectedLocator = JSON.parse(row.locator_json) as unknown;
    const mismatch =
      citation.artifactId !== row.artifact_id
      || citation.artifactVersionId !== row.artifact_version_id
      || citation.artifactHash !== row.artifact_hash
      || citation.documentId !== row.document_id
      || citation.documentType !== row.document_type
      || citation.title !== row.title
      || (citation.effectiveDate ?? null) !== row.effective_date
      || canonicalJson(citation.locator) !== canonicalJson(expectedLocator)
      || citation.quotedText !== expectedQuote
      || citation.quoteHash !== sha256Json(expectedQuote);
    if (mismatch) throw new RetrievalError("citation_invalid", `citation no longer matches immutable source: ${chunkId}`);

    this.ledger.addCitation({
      id: citationId,
      claimId,
      artifactVersionId: citation.artifactVersionId,
      locator: citation.locator,
      quoteHash: citation.quoteHash,
      createdAt: at,
    });
    return citationId;
  }
}
