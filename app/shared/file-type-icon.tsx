import { FileIcon, type FileIconProps } from "react-file-icon";
import { FILE_TYPE_COLORS } from "@/lib/files/file-type-colors";

// react-file-icon:页角折叠 + 彩色标签带。品牌色(color/labelColor)统一取自 lib/files/file-type-colors
// (与预览强调色共用一份);标签字/字形色恒为白,type 是 react-file-icon 的类别。
const FILE_ICON_TYPE: Record<string, FileIconProps["type"]> = {
  xls: "spreadsheet", xlsx: "spreadsheet", csv: "spreadsheet",
  doc: "document", docx: "document",
  pdf: "acrobat", ppt: "presentation", pptx: "presentation",
  md: "document", txt: "document", json: "code", zip: "compressed",
};
const fileStyles: Record<string, FileIconProps> = Object.fromEntries(
  Object.entries(FILE_TYPE_COLORS).map(([ext, c]) => [
    ext,
    { color: c.color, labelColor: c.labelColor, labelTextColor: "#fff", glyphColor: "#fff", type: FILE_ICON_TYPE[ext] },
  ]),
);

/** 从文件名扩展名 + mimeType 兜底解析出扩展名(小写)。 */
function resolveExt(name: string, mimeType: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext) return ext;
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "xlsx";
  if (mimeType === "text/csv") return "csv";
  if (mimeType.includes("word")) return "docx";
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "pptx";
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("zip") || mimeType.includes("compressed")) return "zip";
  if (mimeType.startsWith("text/")) return "txt";
  return "";
}

/** 彩色文件类型图标(react-file-icon)。width 控制视觉宽度(图标为竖版,高约 width×1.2)。 */
export function FileTypeIcon({ name = "", mimeType = "", width = 16 }: { name?: string; mimeType?: string; width?: number }) {
  const ext = resolveExt(name, mimeType);
  const style = fileStyles[ext] ?? {};
  return (
    <span style={{ display: "inline-flex", width, flexShrink: 0 }} aria-hidden="true">
      <FileIcon extension={ext || undefined} {...style} />
    </span>
  );
}
