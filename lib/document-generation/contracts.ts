import { z } from "zod";

const ReportTextSchema = z.string().trim().min(1).max(20_000);

export const DocumentReportMetadataSchema = z.object({
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(500),
}).strict();

export const DocumentReportTableSchema = z.object({
  caption: z.string().trim().min(1).max(200).optional(),
  columns: z.array(z.string().trim().min(1).max(200)).min(1).max(32),
  rows: z.array(z.array(z.string().max(5_000))).max(10_000),
}).strict().superRefine((table, context) => {
  table.rows.forEach((row, rowIndex) => {
    if (row.length !== table.columns.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows", rowIndex],
        message: `row has ${row.length} cells but table declares ${table.columns.length} columns`,
      });
    }
  });
});

export const DocumentReportSectionSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
  heading: z.string().trim().min(1).max(200),
  paragraphs: z.array(ReportTextSchema).max(1_000).default([]),
  tables: z.array(DocumentReportTableSchema).max(100).default([]),
}).strict().refine((section) => section.paragraphs.length > 0 || section.tables.length > 0, {
  message: "section must contain at least one paragraph or table",
});

export const DocumentReportSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().trim().min(1).max(500).optional(),
  metadata: z.array(DocumentReportMetadataSchema).max(100).default([]),
  sections: z.array(DocumentReportSectionSchema).min(1).max(200),
  footer: z.string().trim().min(1).max(500).optional(),
}).strict();

export type DocumentReport = z.infer<typeof DocumentReportSchema>;

export const GenerateDocxRequestSchema = z.object({
  report: DocumentReportSchema,
  outputRoot: z.string().trim().min(1),
  outputName: z.string().trim().min(1).max(255),
  overwrite: z.boolean().default(false),
}).strict();

export type GenerateDocxRequest = z.input<typeof GenerateDocxRequestSchema>;

export type GeneratedDocument = {
  format: "docx";
  producer: "finwork.document-generation.docx.v1";
  outputPath: string;
  bytes: number;
  sha256: string;
  semanticSha256: string;
};
