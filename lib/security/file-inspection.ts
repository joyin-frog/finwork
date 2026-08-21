import { createHash } from "node:crypto";
import JSZip from "jszip";
import { FileSafetyManifestSchema, type FileSafetyFinding, type FileSafetyManifest } from "./contracts";

export const DEFAULT_ARCHIVE_SAFETY_LIMITS = {
  maxEntries: 5_000,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxInspectionXmlBytes: 16 * 1024 * 1024,
} as const;

export type ArchiveSafetyLimits = typeof DEFAULT_ARCHIVE_SAFETY_LIMITS;

type ZipEntry = {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  encrypted: boolean;
};

const ZIP_SIGNATURE = 0x04034b50;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ARCHIVE_EXTENSION = /\.(?:zip|7z|rar|tar|gz|bz2|xz|docx|xlsx|xlsm|pptx)$/i;
const OFFICE_EXTENSION = /\.(?:docx|xlsx|xlsm|pptx)$/i;
const UNSAFE_FORMULA = /\b(?:WEBSERVICE|FILTERXML|RTD|HYPERLINK)\s*\(|(?:https?|ftp|file):\/\/|\[[^\]]+\.(?:xlsx?|xlsm|xlsb|csv)\]|\|[^!]{1,256}!/i;

function finding(code: FileSafetyFinding["code"], disposition: FileSafetyFinding["disposition"], location: string, detail: string): FileSafetyFinding {
  return { code, disposition, location, detail };
}

function archivePathIsUnsafe(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  return normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((segment) => segment === "..");
}

function parseCentralDirectory(content: Uint8Array): { entries: ZipEntry[]; findings: FileSafetyFinding[] } {
  const buffer = Buffer.from(content);
  const minimum = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let cursor = buffer.length - 22; cursor >= minimum; cursor -= 1) {
    if (buffer.readUInt32LE(cursor) === EOCD_SIGNATURE) { eocd = cursor; break; }
  }
  if (eocd < 0) return { entries: [], findings: [finding("malformed_archive", "block", "package", "ZIP central directory is missing")] };
  const disk = buffer.readUInt16LE(eocd + 4);
  const directoryDisk = buffer.readUInt16LE(eocd + 6);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryBytes = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || directoryDisk !== 0 || entryCount === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    return { entries: [], findings: [finding("zip64_unsupported", "block", "package", "Multi-disk and Zip64 archives require a dedicated bounded decoder")] };
  }
  if (directoryOffset + directoryBytes > eocd || directoryOffset > buffer.length) {
    return { entries: [], findings: [finding("malformed_archive", "block", "package", "ZIP central directory bounds are invalid")] };
  }
  const entries: ZipEntry[] = [];
  const findings: FileSafetyFinding[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      findings.push(finding("malformed_archive", "block", `entry:${index}`, "ZIP central directory entry is truncated or invalid"));
      break;
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const uncompressedBytes = buffer.readUInt32LE(cursor + 24);
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const commentBytes = buffer.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (end > buffer.length) {
      findings.push(finding("malformed_archive", "block", `entry:${index}`, "ZIP entry metadata exceeds package bounds"));
      break;
    }
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8");
    entries.push({ name, compressedBytes, uncompressedBytes, encrypted: Boolean(flags & 0x1) });
    cursor = end;
  }
  if (entries.length !== entryCount) findings.push(finding("malformed_archive", "block", "package", `Expected ${entryCount} entries but parsed ${entries.length}`));
  return { entries, findings };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'");
}

function inspectXml(path: string, xml: string): FileSafetyFinding[] {
  const findings: FileSafetyFinding[] = [];
  if (/TargetMode\s*=\s*["']External["']/i.test(xml)) {
    findings.push(finding("external_link_present", "require_approval", path, "Office relationship targets an external resource"));
  }
  for (const match of xml.matchAll(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/gi)) {
    const formula = decodeXmlText(match[1] ?? "").trim();
    if (UNSAFE_FORMULA.test(formula)) findings.push(finding("active_formula_present", "block", path, `Unsafe active formula: ${formula.slice(0, 300)}`));
  }
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)) {
    const text = decodeXmlText(match[1] ?? "");
    if (/^[\t\r\n ]*[=+\-@]/.test(text)) findings.push(finding("formula_injection_present", "block", path, "Text cell begins with an executable spreadsheet prefix"));
  }
  return findings;
}

function plainTextFormulaFindings(content: Uint8Array, fileName: string, mediaType: string): FileSafetyFinding[] {
  if (!/\.(?:csv|tsv)$/i.test(fileName) && !/text\/(?:csv|tab-separated-values)/i.test(mediaType)) return [];
  const text = Buffer.from(content).toString("utf8");
  const findings: FileSafetyFinding[] = [];
  text.split(/\r?\n/).forEach((line, lineIndex) => {
    line.split(/[,\t]/).forEach((cell, columnIndex) => {
      const unquoted = cell.trim().replace(/^"|"$/g, "");
      if (/^[=+\-@]/.test(unquoted)) findings.push(finding("formula_injection_present", "block", `row:${lineIndex + 1}:column:${columnIndex + 1}`, "Delimited text cell begins with an executable spreadsheet prefix"));
    });
  });
  return findings;
}

export async function inspectFileSafety(
  content: Uint8Array,
  fileName: string,
  mediaType: string,
  limits: ArchiveSafetyLimits = DEFAULT_ARCHIVE_SAFETY_LIMITS,
): Promise<FileSafetyManifest> {
  const sha256 = createHash("sha256").update(content).digest("hex");
  const requiresZip = OFFICE_EXTENSION.test(fileName) || /(?:zip|openxmlformats|macroenabled)/i.test(mediaType);
  const isZip = content.byteLength >= 4 && Buffer.from(content).readUInt32LE(0) === ZIP_SIGNATURE;
  const findings = plainTextFormulaFindings(content, fileName, mediaType);
  if (!isZip) {
    if (requiresZip) findings.push(finding("malformed_archive", "block", "package", "File extension or media type requires a ZIP-based Office package"));
    return FileSafetyManifestSchema.parse({ schemaVersion: 1, fileName, mediaType, sha256, archive: null, packageEntries: [], findings,
      decision: findings.length ? "block" : "clean" });
  }

  const parsed = parseCentralDirectory(content);
  findings.push(...parsed.findings);
  const packageEntries = parsed.entries.map((entry) => entry.name);
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  let maximumCompressionRatio = 0;
  if (parsed.entries.length > limits.maxEntries) findings.push(finding("archive_entry_limit", "block", "package", `Archive contains ${parsed.entries.length} entries; limit is ${limits.maxEntries}`));
  for (const entry of parsed.entries) {
    totalCompressedBytes += entry.compressedBytes;
    totalUncompressedBytes += entry.uncompressedBytes;
    const ratio = entry.uncompressedBytes === 0 ? 0 : entry.compressedBytes === 0 ? Number.POSITIVE_INFINITY : entry.uncompressedBytes / entry.compressedBytes;
    maximumCompressionRatio = Math.max(maximumCompressionRatio, ratio);
    if (entry.encrypted) findings.push(finding("encrypted_archive", "block", entry.name, "Encrypted entries cannot be inspected before release"));
    if (archivePathIsUnsafe(entry.name)) findings.push(finding("archive_path_traversal", "block", entry.name, "Archive entry escapes the virtual extraction root"));
    if (entry.uncompressedBytes > limits.maxEntryUncompressedBytes) findings.push(finding("archive_entry_size_limit", "block", entry.name, `Entry expands to ${entry.uncompressedBytes} bytes`));
    if (ratio > limits.maxCompressionRatio) findings.push(finding("archive_compression_ratio_limit", "block", entry.name, `Compression ratio ${ratio.toFixed(1)} exceeds ${limits.maxCompressionRatio}`));
    if (ARCHIVE_EXTENSION.test(entry.name)) findings.push(finding("nested_archive", "block", entry.name, "Nested archives require recursive bounded inspection"));
    if (/vbaProject\.bin$/i.test(entry.name)) findings.push(finding("macro_present", "require_approval", entry.name, "Office package contains executable VBA"));
    if (/\/(?:embeddings|activex)\//i.test(entry.name)) findings.push(finding("embedded_object_present", "require_approval", entry.name, "Office package contains an embedded or ActiveX object"));
    if (/_xmlsignatures|signature/i.test(entry.name)) findings.push(finding("digital_signature_present", "require_approval", entry.name, "Office package contains a digital signature whose validity must be preserved"));
    if (/\/externalLinks\//i.test(entry.name)) findings.push(finding("external_link_present", "require_approval", entry.name, "Workbook contains an external-link part"));
  }
  if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) findings.push(finding("archive_total_size_limit", "block", "package", `Archive expands to ${totalUncompressedBytes} bytes; limit is ${limits.maxTotalUncompressedBytes}`));

  if (!findings.some((item) => ["malformed_archive", "zip64_unsupported", "archive_entry_limit", "archive_entry_size_limit", "archive_total_size_limit", "archive_compression_ratio_limit"].includes(item.code))) {
    try {
      const zip = await JSZip.loadAsync(content, { checkCRC32: false, createFolders: false });
      let inspectedBytes = 0;
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || !/\.(?:xml|rels)$/i.test(entry.name)) continue;
        const declared = parsed.entries.find((item) => item.name === entry.name)?.uncompressedBytes ?? 0;
        if (declared > limits.maxInspectionXmlBytes || inspectedBytes + declared > limits.maxInspectionXmlBytes) {
          findings.push(finding("archive_total_size_limit", "block", entry.name, "XML inspection budget exceeded"));
          break;
        }
        const xml = await entry.async("text");
        inspectedBytes += Buffer.byteLength(xml);
        findings.push(...inspectXml(entry.name, xml));
      }
    } catch (error) {
      findings.push(finding("malformed_archive", "block", "package", `ZIP parser rejected package: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  const unique = [...new Map(findings.map((item) => [`${item.code}:${item.location}:${item.detail}`, item])).values()];
  const decision = unique.some((item) => item.disposition === "block") ? "block" : unique.length ? "require_approval" : "clean";
  return FileSafetyManifestSchema.parse({ schemaVersion: 1, fileName, mediaType, sha256,
    archive: { entryCount: parsed.entries.length, totalCompressedBytes, totalUncompressedBytes,
      maximumCompressionRatio: Number.isFinite(maximumCompressionRatio) ? maximumCompressionRatio : Number.MAX_VALUE },
    packageEntries, findings: unique, decision });
}
