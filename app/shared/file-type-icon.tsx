import { FileIcon, type FileIconProps } from "react-file-icon";

// Folio 文件类型配色(react-file-icon):页角折叠 + 彩色标签带;按扩展名取色。
// 配色映射来自设计系统 guidelines/brand-file-icons.html 的 fileStyles。
// 配色:在品牌色基础上提亮、降饱和,小尺寸下更清爽不发闷(body 浅一档、label 带稍深做两色)。
const fileStyles: Record<string, FileIconProps> = {
  xls:  { color: "#43AE74", labelColor: "#329060", labelTextColor: "#fff", glyphColor: "#fff", type: "spreadsheet" },
  xlsx: { color: "#43AE74", labelColor: "#329060", labelTextColor: "#fff", glyphColor: "#fff", type: "spreadsheet" },
  csv:  { color: "#43AE74", labelColor: "#329060", labelTextColor: "#fff", glyphColor: "#fff", type: "spreadsheet" },
  doc:  { color: "#5193DC", labelColor: "#3E7BBF", labelTextColor: "#fff", glyphColor: "#fff", type: "document" },
  docx: { color: "#5193DC", labelColor: "#3E7BBF", labelTextColor: "#fff", glyphColor: "#fff", type: "document" },
  pdf:  { color: "#F06A66", labelColor: "#DD524E", labelTextColor: "#fff", glyphColor: "#fff", type: "acrobat" },
  ppt:  { color: "#EC7A4D", labelColor: "#D5663A", labelTextColor: "#fff", glyphColor: "#fff", type: "presentation" },
  pptx: { color: "#EC7A4D", labelColor: "#D5663A", labelTextColor: "#fff", glyphColor: "#fff", type: "presentation" },
  md:   { color: "#728195", labelColor: "#5C6A7E", labelTextColor: "#fff", glyphColor: "#fff", type: "document" },
  txt:  { color: "#828FA3", labelColor: "#69768B", labelTextColor: "#fff", glyphColor: "#fff", type: "document" },
  json: { color: "#828FA3", labelColor: "#69768B", labelTextColor: "#fff", glyphColor: "#fff", type: "code" },
  zip:  { color: "#BFA259", labelColor: "#A38845", labelTextColor: "#fff", glyphColor: "#fff", type: "compressed" },
};

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
