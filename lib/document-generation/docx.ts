import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import JSZip from "jszip";
import { GenerateDocxRequestSchema, type DocumentReport, type GeneratedDocument, type GenerateDocxRequest } from "./contracts";

const FIXED_DATE = new Date("2000-01-01T00:00:00.000Z");
const PRODUCER = "finwork.document-generation.docx.v1" as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reportChildren(report: DocumentReport): Array<Paragraph | Table> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: report.title, bold: true, size: 36 })],
    }),
  ];

  if (report.subtitle) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: report.subtitle, size: 22, color: "666666" })] }));
  }
  if (report.metadata.length > 0) {
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: report.metadata.map((item) => new TableRow({ children: [
        new TableCell({ width: { size: 25, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: item.label, bold: true })] })] }),
        new TableCell({ width: { size: 75, type: WidthType.PERCENTAGE }, children: [new Paragraph(item.value)] }),
      ] })),
    }));
  }

  for (const section of report.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: section.heading, bold: true })] }));
    for (const paragraph of section.paragraphs) children.push(new Paragraph({ text: paragraph }));
    for (const table of section.tables) {
      if (table.caption) children.push(new Paragraph({ children: [new TextRun({ text: table.caption, bold: true })] }));
      const rows = [table.columns, ...table.rows].map((row, rowIndex) => new TableRow({
        children: row.map((cell) => new TableCell({
          width: { size: 100 / table.columns.length, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: cell, bold: rowIndex === 0 })] })],
        })),
      }));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
    }
  }
  return children;
}

async function deterministicDocx(report: DocumentReport): Promise<Buffer> {
  const footer = report.footer
    ? { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, text: report.footer })] }) }
    : undefined;
  const document = new Document({
    title: report.title,
    subject: report.subtitle ?? "Finwork structured financial report",
    creator: "Finwork",
    lastModifiedBy: "Finwork",
    revision: 1,
    description: PRODUCER,
    sections: [{ properties: {}, footers: footer, children: reportChildren(report) }],
  });
  const generated = await Packer.toBuffer(document);
  const source = await JSZip.loadAsync(generated);
  const core = source.file("docProps/core.xml");
  if (core) {
    const xml = (await core.async("text"))
      .replace(/<dcterms:created[^>]*>[^<]*<\/dcterms:created>/g, '<dcterms:created xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:created>')
      .replace(/<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/g, '<dcterms:modified xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:modified>');
    source.file("docProps/core.xml", xml, { date: FIXED_DATE });
  }
  for (const entry of Object.values(source.files)) entry.date = FIXED_DATE;
  return source.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
    streamFiles: false,
  });
}

function resolveOutputPath(outputRoot: string, outputName: string): string {
  if (path.basename(outputName) !== outputName || !/^[^/\\]+\.docx$/i.test(outputName)) {
    throw new Error("document_generation_invalid_output_name");
  }
  const root = path.resolve(outputRoot);
  const outputPath = path.resolve(root, outputName);
  if (path.dirname(outputPath) !== root) throw new Error("document_generation_path_escape");
  return outputPath;
}

function atomicWrite(outputPath: string, bytes: Buffer, overwrite: boolean): void {
  mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  if (existsSync(outputPath)) {
    if (lstatSync(outputPath).isSymbolicLink()) throw new Error("document_generation_symlink_target_blocked");
    if (!overwrite) throw new Error("document_generation_output_exists");
  }
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (overwrite && existsSync(outputPath)) unlinkSync(outputPath);
    renameSync(temporary, outputPath);
    const directory = openSync(path.dirname(outputPath), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export async function generateDocx(request: GenerateDocxRequest): Promise<GeneratedDocument> {
  const parsed = GenerateDocxRequestSchema.parse(request);
  const outputPath = resolveOutputPath(parsed.outputRoot, parsed.outputName);
  const bytes = await deterministicDocx(parsed.report);
  atomicWrite(outputPath, bytes, parsed.overwrite);
  const persisted = readFileSync(outputPath);
  return {
    format: "docx",
    producer: PRODUCER,
    outputPath,
    bytes: persisted.byteLength,
    sha256: sha256(persisted),
    semanticSha256: sha256(canonicalJson(parsed.report)),
  };
}
