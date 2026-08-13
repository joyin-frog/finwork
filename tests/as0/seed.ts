import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fixturePath } from "./manifest";
import type { GoldenTask } from "./types";

type BusinessSeed = {
  salesInvoices?: Array<{
    invoiceNo: string;
    customer: string;
    invoiceDate: string;
    amountExcludingTax: number;
    taxAmount: number;
    settledAmount: number;
  }>;
  contractObligations?: Array<{
    obligationId: string;
    customer: string;
    dueDate: string;
    amount: number;
    settledAmount: number;
  }>;
};

export async function seedAttempt(args: {
  task: GoldenTask;
  fixtureRoot: string;
  inputDir: string;
}): Promise<Map<string, string>> {
  mkdirSync(args.inputDir, { recursive: true });
  const copied = new Map<string, string>();
  const referenced = new Set<string>();
  for (const turn of args.task.turns) {
    for (const attachment of turn.attachments ?? []) referenced.add(attachment);
  }
  for (const relative of referenced) {
    const source = fixturePath(args.fixtureRoot, relative);
    const target = path.join(args.inputDir, path.basename(source));
    copyFileSync(source, target);
    copied.set(relative, target);
  }

  const { ingestDocument } = await import("@/lib/knowledge/pipeline");
  for (const relative of args.task.setup?.knowledgeDocuments ?? []) {
    const source = fixturePath(args.fixtureRoot, relative);
    const target = path.join(args.inputDir, `knowledge-${path.basename(source)}`);
    copyFileSync(source, target);
    await ingestDocument({
      filePath: target,
      title: path.basename(source, path.extname(source)),
      fileName: path.basename(source),
      mimeType: "text/markdown",
      sizeBytes: statSync(target).size,
      storagePath: target,
      embedRunner: async (texts) => texts.map((text) => {
        // AS0 fixtures need stable, non-empty vectors so Retrieval v2 exercises
        // the same indexing contract as production without downloading a model.
        let a = 0;
        let b = 0;
        for (let index = 0; index < text.length; index += 1) {
          const code = text.charCodeAt(index);
          a = (a + code * (index + 1)) % 104729;
          b = (b + code * 31) % 130363;
        }
        return [a / 104729, b / 130363, text.length % 997 / 997, 0.1];
      }),
    });
  }

  if (args.task.setup?.businessSeed) {
    await seedBusinessData(fixturePath(args.fixtureRoot, args.task.setup.businessSeed));
  }
  return copied;
}

async function seedBusinessData(seedPath: string): Promise<void> {
  const seed = JSON.parse(readFileSync(seedPath, "utf8")) as BusinessSeed;
  const { getDb } = await import("@/lib/db/sqlite");
  const { recordInvoices } = await import("@/lib/db/finance-store");
  const db = getDb();

  if (seed.salesInvoices?.length) {
    recordInvoices(
      seed.salesInvoices.map((invoice) => ({
        invoiceNo: invoice.invoiceNo,
        amount: invoice.amountExcludingTax + invoice.taxAmount,
        invoiceDate: invoice.invoiceDate,
        taxAmountCents: Math.round(invoice.taxAmount * 100),
        counterparty: invoice.customer,
        direction: "out",
        category: "AS0 fixture",
      })),
      db,
      { eventType: "as0_seed_sales_invoice", toolName: "as0_phase_b_harness" },
    );
  }

  const insert = db.prepare(
    `INSERT INTO fact_obligations
      (kind, amount_cents, due_date, counterparty, status, status_raw, source_doc,
       source_document_id, settlement_status, source, provenance)
     VALUES ('receive', ?, ?, ?, ?, ?, ?, ?, ?, 'as0_fixture', ?)`,
  );
  for (const [index, obligation] of (seed.contractObligations ?? []).entries()) {
    const settled = obligation.settledAmount >= obligation.amount;
    insert.run(
      Math.round(obligation.amount * 100),
      obligation.dueDate,
      obligation.customer,
      settled ? "settled" : "pending",
      settled ? "已收款" : "待收款",
      `${obligation.obligationId}.json`,
      900000 + index,
      settled ? "settled" : "derived",
      JSON.stringify({ fixture: path.basename(seedPath), obligationId: obligation.obligationId }),
    );
  }
}
