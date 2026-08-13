import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DocumentLocator } from "@/lib/artifacts/contracts";
import {
  DocumentIrSchema,
  type DocumentFormat,
  type DocumentIr,
  type DocumentNode,
  type DocumentStyle,
  type PreservationFeature,
  type PreservationManifest,
} from "./contracts";
import { attributeValue, tagBlocks, textFromXml } from "./xml";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function node(
  format: DocumentFormat,
  kind: DocumentNode["kind"],
  order: number,
  text: string | undefined,
  locator: DocumentLocator,
  parentId: string | null,
  attributes: DocumentNode["attributes"] = {},
  style?: DocumentStyle,
): DocumentNode {
  return { id: `${format}-${kind}-${order + 1}`, kind, parentId, order, text, locator, attributes, ...(style ? { style } : {}) };
}

function openingTag(block: string, qualifiedTag: string): string {
  const escaped = qualifiedTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp(`<${escaped}\\b[^>]*>`, "i"))?.[0] ?? "";
}

function ooxmlStyle(block: string, namespace: "w" | "a"): DocumentStyle | undefined {
  const style: DocumentStyle = {};
  if (namespace === "w") {
    const styleTag = block.match(/<w:(?:pStyle|rStyle)\b[^>]*>/i)?.[0] ?? "";
    const sizeTag = block.match(/<w:sz\b[^>]*>/i)?.[0] ?? "";
    const colorTag = block.match(/<w:color\b[^>]*>/i)?.[0] ?? "";
    const fontTag = block.match(/<w:rFonts\b[^>]*>/i)?.[0] ?? "";
    const alignTag = block.match(/<w:jc\b[^>]*>/i)?.[0] ?? "";
    const styleId = attributeValue(styleTag, "w:val");
    const size = Number(attributeValue(sizeTag, "w:val"));
    const alignment = attributeValue(alignTag, "w:val");
    if (styleId) style.styleId = styleId;
    if (Number.isFinite(size) && size > 0) style.fontSizePt = size / 2;
    const color = attributeValue(colorTag, "w:val");
    if (color && color !== "auto") style.color = color;
    const font = attributeValue(fontTag, "w:ascii") ?? attributeValue(fontTag, "w:eastAsia");
    if (font) style.fontFamily = font;
    if (/<w:b\b/i.test(block)) style.bold = true;
    if (/<w:i\b/i.test(block)) style.italic = true;
    if (["left", "center", "right", "both"].includes(alignment ?? "")) style.alignment = alignment === "both" ? "justify" : alignment as DocumentStyle["alignment"];
  } else {
    const props = block.match(/<a:(?:rPr|defRPr)\b[^>]*>/i)?.[0] ?? "";
    const size = Number(attributeValue(props, "sz"));
    if (Number.isFinite(size) && size > 0) style.fontSizePt = size / 100;
    if (attributeValue(props, "b") === "1") style.bold = true;
    if (attributeValue(props, "i") === "1") style.italic = true;
  }
  return Object.keys(style).length ? style : undefined;
}

function feature(
  featureName: PreservationFeature["feature"],
  paths: string[],
  disposition: PreservationFeature["disposition"] = "preserve",
  reason?: string,
): PreservationFeature {
  return { feature: featureName, count: paths.length, paths, disposition, reason };
}

async function packageManifest(
  bytes: Uint8Array,
  format: Exclude<DocumentFormat, "pdf">,
  zip: JSZip,
  extraFeatures: PreservationFeature[] = [],
): Promise<PreservationManifest> {
  const entries = Object.keys(zip.files).sort();
  const files = entries.filter((entry) => !zip.files[entry]?.dir);
  const macros = files.filter((entry) => /vbaProject\.bin$/i.test(entry));
  const signatures = files.filter((entry) => /_xmlsignatures|signature/i.test(entry));
  const embeddings = files.filter((entry) => /\/embeddings\//i.test(entry));
  const relationshipPaths = entries.filter((entry) => /\.rels$/i.test(entry));
  const externalLinks: string[] = [];
  for (const relPath of relationshipPaths) {
    const xml = await zip.file(relPath)?.async("text");
    if (xml && /TargetMode\s*=\s*["']External["']/i.test(xml)) externalLinks.push(relPath);
  }
  const features = [
    ...extraFeatures,
    feature("macros", macros, "block", macros.length ? "Macros require quarantine and explicit approval" : undefined),
    feature("external_links", externalLinks),
    feature("embedded_objects", embeddings, "block", embeddings.length ? "Embedded objects require explicit support" : undefined),
    feature("digital_signatures", signatures, "block", signatures.length ? "Editing invalidates digital signatures" : undefined),
  ].filter((item) => item.count > 0);
  const blockingReasons = features.filter((item) => item.disposition === "block").map((item) => item.reason ?? item.feature);
  return {
    sourceSha256: sha256(bytes),
    sourceBytes: bytes.byteLength,
    format,
    packageEntries: entries,
    features,
    blocked: blockingReasons.length > 0,
    blockingReasons,
  };
}

async function parseDocx(bytes: Uint8Array): Promise<DocumentIr> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = (await zip.file("word/document.xml")?.async("text")) ?? "";
  const nodes: DocumentNode[] = [];
  const root = node("docx", "document", nodes.length, undefined, { kind: "node", nodeId: "docx-document" }, null, { packagePath: "word/document.xml" });
  nodes.push(root);
  tagBlocks(xml, "w:p").forEach((block, index) => {
    const text = textFromXml(block);
    const paragraph = node("docx", "paragraph", nodes.length, text || undefined, { kind: "paragraph", nodeId: `docx-paragraph-${index + 1}` }, root.id, { xmlIndex: index + 1 }, ooxmlStyle(block, "w"));
    nodes.push(paragraph);
    tagBlocks(block, "w:r").forEach((runBlock, runIndex) => {
      const runText = textFromXml(runBlock);
      nodes.push(node("docx", "run", nodes.length, runText || undefined, { kind: "node", nodeId: `docx-run-${index + 1}-${runIndex + 1}` }, paragraph.id, { paragraphIndex: index + 1, runIndex: runIndex + 1 }, ooxmlStyle(runBlock, "w")));
    });
  });
  tagBlocks(xml, "w:tbl").forEach((block, index) => {
    const table = node("docx", "table", nodes.length, textFromXml(block), { kind: "table", nodeId: `docx-table-${index + 1}` }, root.id, { tableIndex: index + 1 });
    nodes.push(table);
    tagBlocks(block, "w:tr").forEach((rowBlock, rowIndex) => {
      const row = node("docx", "table_row", nodes.length, textFromXml(rowBlock), { kind: "node", nodeId: `docx-table-${index + 1}-row-${rowIndex + 1}` }, table.id, { row: rowIndex + 1 });
      nodes.push(row);
      tagBlocks(rowBlock, "w:tc").forEach((cellBlock, columnIndex) => {
        nodes.push(node("docx", "table_cell", nodes.length, textFromXml(cellBlock), { kind: "node", nodeId: `docx-table-${index + 1}-cell-${rowIndex + 1}-${columnIndex + 1}` }, row.id, { row: rowIndex + 1, column: columnIndex + 1 }));
      });
    });
  });
  const comments = Object.keys(zip.files).filter((entry) => /word\/comments.*\.xml$/i.test(entry));
  const footnotes = Object.keys(zip.files).filter((entry) => /word\/footnotes\.xml$/i.test(entry));
  const images = Object.keys(zip.files).filter((entry) => /word\/media\//i.test(entry));
  const revisions = [
    ...tagBlocks(xml, "w:ins").map((_, index) => `word/document.xml#ins-${index + 1}`),
    ...tagBlocks(xml, "w:del").map((_, index) => `word/document.xml#del-${index + 1}`),
  ];
  for (const commentPath of comments) {
    const commentXml = (await zip.file(commentPath)?.async("text")) ?? "";
    tagBlocks(commentXml, "w:comment").forEach((block, index) => {
      const tag = openingTag(block, "w:comment");
      nodes.push(node("docx", "comment", nodes.length, textFromXml(block), { kind: "node", nodeId: `docx-comment-${attributeValue(tag, "w:id") ?? index + 1}` }, root.id, {
        author: attributeValue(tag, "w:author") ?? null,
        date: attributeValue(tag, "w:date") ?? null,
        packagePath: commentPath,
      }));
    });
  }
  for (const footnotePath of footnotes) {
    const footnoteXml = (await zip.file(footnotePath)?.async("text")) ?? "";
    tagBlocks(footnoteXml, "w:footnote").forEach((block, index) => {
      const tag = openingTag(block, "w:footnote");
      const footnoteId = attributeValue(tag, "w:id") ?? String(index + 1);
      if (Number(footnoteId) < 0) return;
      nodes.push(node("docx", "footnote", nodes.length, textFromXml(block), { kind: "node", nodeId: `docx-footnote-${footnoteId}` }, root.id, { packagePath: footnotePath }));
    });
  }
  tagBlocks(xml, "w:ins").forEach((block, index) => nodes.push(node("docx", "revision", nodes.length, textFromXml(block), { kind: "node", nodeId: `docx-revision-insert-${index + 1}` }, root.id, { change: "insert" })));
  tagBlocks(xml, "w:del").forEach((block, index) => nodes.push(node("docx", "revision", nodes.length, textFromXml(block), { kind: "node", nodeId: `docx-revision-delete-${index + 1}` }, root.id, { change: "delete" })));
  images.forEach((imagePath, index) => nodes.push(node("docx", "image", nodes.length, undefined, { kind: "node", nodeId: `docx-image-${index + 1}` }, root.id, { packagePath: imagePath })));
  const manifest = await packageManifest(bytes, "docx", zip, [
    feature("comments", comments),
    feature("footnotes", footnotes),
    feature("images", images),
    feature("revisions", revisions),
  ]);
  return DocumentIrSchema.parse({ schemaVersion: 1, format: "docx", sourceSha256: sha256(bytes), nodes, manifest, metadata: {} });
}

async function parsePptx(bytes: Uint8Array): Promise<DocumentIr> {
  const zip = await JSZip.loadAsync(bytes);
  const slidePaths = Object.keys(zip.files).filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry)).sort();
  const nodes: DocumentNode[] = [];
  const root = node("pptx", "document", nodes.length, undefined, { kind: "node", nodeId: "pptx-document" }, null, { packagePath: "ppt/presentation.xml" });
  nodes.push(root);
  for (const [slideIndex, slidePath] of slidePaths.entries()) {
    const xml = (await zip.file(slidePath)?.async("text")) ?? "";
    const slideId = `pptx-slide-${slideIndex + 1}`;
    const slide = node("pptx", "slide", nodes.length, textFromXml(xml), { kind: "node", nodeId: slideId }, root.id, { slide: slideIndex + 1, packagePath: slidePath });
    nodes.push(slide);
    for (const block of tagBlocks(xml, "p:sp")) {
      const shapeId = attributeValue(block.match(/<p:cNvPr\b[^>]*>/i)?.[0] ?? "", "id") ?? String(nodes.length + 1);
      const shape = node("pptx", "shape", nodes.length, textFromXml(block), { kind: "node", nodeId: `pptx-shape-${slideIndex + 1}-${shapeId}` }, slide.id, { shapeId, slide: slideIndex + 1 }, ooxmlStyle(block, "a"));
      nodes.push(shape);
      tagBlocks(block, "a:r").forEach((runBlock, runIndex) => nodes.push(node("pptx", "run", nodes.length, textFromXml(runBlock), { kind: "node", nodeId: `pptx-run-${slideIndex + 1}-${shapeId}-${runIndex + 1}` }, shape.id, { runIndex: runIndex + 1 }, ooxmlStyle(runBlock, "a"))));
    }
    for (const block of tagBlocks(xml, "a:tbl")) {
      nodes.push(node("pptx", "table", nodes.length, textFromXml(block), { kind: "table", nodeId: `pptx-table-${slideIndex + 1}-${nodes.length + 1}` }, slide.id));
    }
  }
  const notes = Object.keys(zip.files).filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entry));
  for (const notePath of notes) {
    const xml = (await zip.file(notePath)?.async("text")) ?? "";
    nodes.push(node("pptx", "notes", nodes.length, textFromXml(xml), { kind: "node", nodeId: `pptx-notes-${nodes.length + 1}` }, root.id, { packagePath: notePath }));
  }
  const images = Object.keys(zip.files).filter((entry) => /ppt\/media\//i.test(entry));
  images.forEach((imagePath, index) => nodes.push(node("pptx", "image", nodes.length, undefined, { kind: "node", nodeId: `pptx-image-${index + 1}` }, root.id, { packagePath: imagePath })));
  const manifest = await packageManifest(bytes, "pptx", zip, [feature("images", images)]);
  return DocumentIrSchema.parse({ schemaVersion: 1, format: "pptx", sourceSha256: sha256(bytes), nodes, manifest, metadata: { slides: slidePaths.length } });
}

async function parseXlsx(bytes: Uint8Array): Promise<DocumentIr> {
  const zip = await JSZip.loadAsync(bytes);
  const workbook = new ExcelJS.Workbook();
  const workbookBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(workbookBytes);
  const nodes: DocumentNode[] = [];
  const root = node("xlsx", "document", nodes.length, undefined, { kind: "node", nodeId: "xlsx-document" }, null, { packagePath: "xl/workbook.xml" });
  nodes.push(root);
  const MAX_DOCUMENT_CELLS = 10_000;
  let representedCells = 0;
  workbook.eachSheet((sheet) => {
    const id = `xlsx-sheet-${sheet.id}`;
    const sheetNode = node("xlsx", "sheet", nodes.length, sheet.name, { kind: "sheet_range", sheet: sheet.name, range: "A1" }, root.id, {
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      state: sheet.state,
    });
    nodes.push(sheetNode);
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (representedCells >= MAX_DOCUMENT_CELLS || cell.value === null) return;
      representedCells += 1;
      const value = typeof cell.value === "object" ? JSON.stringify(cell.value) : String(cell.value);
      nodes.push(node("xlsx", "table_cell", nodes.length, value, { kind: "sheet_range", sheet: sheet.name, range: cell.address }, sheetNode.id, { row: cell.row, column: cell.col }));
    }));
  });
  const images = Object.keys(zip.files).filter((entry) => /xl\/media\//i.test(entry));
  const manifest = await packageManifest(bytes, "xlsx", zip, [feature("images", images)]);
  return DocumentIrSchema.parse({ schemaVersion: 1, format: "xlsx", sourceSha256: sha256(bytes), nodes, manifest, metadata: { sheets: workbook.worksheets.length, representedCells, truncated: representedCells >= MAX_DOCUMENT_CELLS } });
}

async function parsePdf(bytes: Uint8Array): Promise<DocumentIr> {
  // pdfjs rejects Node's Buffer subclass even though it satisfies the TS
  // Uint8Array type, so always hand it an owned plain Uint8Array.
  const pdfBytes = new Uint8Array(bytes);
  const loading = getDocument({ data: pdfBytes, useWorkerFetch: false });
  const pdf = await loading.promise;
  const pageCount = pdf.numPages;
  const nodes: DocumentNode[] = [];
  const root = node("pdf", "document", nodes.length, undefined, { kind: "node", nodeId: "pdf-document" }, null, { pages: pageCount });
  nodes.push(root);
  const ocrPages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const pageId = `pdf-page-${pageNumber}`;
    const pageNode = node("pdf", "page", nodes.length, undefined, { kind: "page", page: pageNumber }, root.id, { width: viewport.width, height: viewport.height });
    nodes.push(pageNode);
    const pageBlocks: Array<{ text: string; bbox: [number, number, number, number] }> = [];
    let textCount = 0;
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const transform = item.transform;
      const width = Number(item.width ?? 0);
      const height = Number(item.height ?? 0);
      const x = Number(transform[4] ?? 0);
      const y = Number(transform[5] ?? 0);
      const bbox: [number, number, number, number] = [x, Math.max(0, viewport.height - y - height), x + width, Math.max(0, viewport.height - y)];
      nodes.push(node("pdf", "text_block", nodes.length, item.str, {
        kind: "bbox",
        page: pageNumber,
        bbox,
      }, pageNode.id));
      pageBlocks.push({ text: item.str, bbox });
      textCount += 1;
    }
    if (textCount === 0) {
      ocrPages.push(`page:${pageNumber}`);
      nodes.push(node("pdf", "ocr_region", nodes.length, undefined, { kind: "bbox", page: pageNumber, bbox: [0, 0, viewport.width, viewport.height] }, pageNode.id, { status: "required" }));
    } else {
      const rows = new Map<number, typeof pageBlocks>();
      for (const block of pageBlocks) {
        const rowKey = Math.round(block.bbox[1] / 4) * 4;
        const row = rows.get(rowKey) ?? [];
        row.push(block);
        rows.set(rowKey, row);
      }
      const tableRows = [...rows.values()].filter((row) => row.length >= 3);
      if (tableRows.length >= 2) {
        const cells = tableRows.flat();
        const bbox: [number, number, number, number] = [
          Math.min(...cells.map((item) => item.bbox[0])), Math.min(...cells.map((item) => item.bbox[1])),
          Math.max(...cells.map((item) => item.bbox[2])), Math.max(...cells.map((item) => item.bbox[3])),
        ];
        nodes.push(node("pdf", "table", nodes.length, tableRows.map((row) => row.map((item) => item.text).join(" | ")).join("\n"), { kind: "bbox", page: pageNumber, bbox }, pageNode.id, { detection: "deterministic_line_cluster", rows: tableRows.length, cells: cells.length }));
      }
    }
    page.cleanup();
  }
  await loading.destroy();
  const features = ocrPages.length ? [feature("ocr_required", ocrPages, "block", "OCR provider is required before claims may use these pages")] : [];
  const manifest: PreservationManifest = {
    sourceSha256: sha256(bytes), sourceBytes: bytes.byteLength, format: "pdf", packageEntries: [], features,
    blocked: features.length > 0, blockingReasons: features.map((item) => item.reason ?? item.feature),
  };
  return DocumentIrSchema.parse({ schemaVersion: 1, format: "pdf", sourceSha256: sha256(bytes), nodes, manifest, metadata: { pages: pageCount } });
}

export async function parseDocumentBytes(format: DocumentFormat, bytes: Uint8Array): Promise<DocumentIr> {
  if (format === "docx") return parseDocx(bytes);
  if (format === "pptx") return parsePptx(bytes);
  if (format === "xlsx") return parseXlsx(bytes);
  return parsePdf(bytes);
}

export async function parseDocumentFile(filePath: string, format?: DocumentFormat): Promise<DocumentIr> {
  const inferred = format ?? filePath.split(".").pop()?.toLowerCase();
  if (!inferred || !["docx", "pdf", "pptx", "xlsx"].includes(inferred)) throw new Error(`Unsupported document format: ${inferred ?? "unknown"}`);
  return parseDocumentBytes(inferred as DocumentFormat, await readFile(filePath));
}
