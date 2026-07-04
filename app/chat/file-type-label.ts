/**
 * getFileTypeLabel — 文件卡副行文字。
 * 格式：「<类型中文> · <扩展名大写> · <大小>」
 *
 * 类型映射：
 *   xlsx/xls/xlsm/csv     → 电子表格
 *   pdf                   → PDF
 *   docx/doc/odt          → 文档
 *   pptx/ppt              → 演示文稿
 *   image/*               → 图片
 *   其余                  → 扩展名大写（无中文标签前缀）
 *
 * 不依赖 React,可在 Node.js 环境直接导入测试。
 */

/** 字节数 → 人类可读大小（B / KB / MB）。与 chat-file-browser.tsx 的同名函数行为一致。 */
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 从文件名提取扩展名，返回大写，不含点；无扩展名时返回空串。 */
function extUpper(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toUpperCase();
}

/** 根据 mimeType + 文件名返回中文类型标签；无匹配时返回空串。 */
function typeLabel(mimeType: string, name: string): string {
  const m = mimeType.toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";

  if (
    m.includes("spreadsheet") ||
    m.includes("excel") ||
    m === "text/csv" ||
    ["xlsx", "xls", "xlsm", "xlsb", "csv"].includes(ext)
  ) {
    return "电子表格";
  }
  if (m === "application/pdf" || ext === "pdf") return "PDF";
  if (
    m.includes("wordprocessingml") ||
    m.includes("msword") ||
    m === "application/vnd.oasis.opendocument.text" ||
    ["docx", "doc", "odt"].includes(ext)
  ) {
    return "文档";
  }
  if (
    m.includes("presentationml") ||
    m.includes("powerpoint") ||
    ["pptx", "ppt"].includes(ext)
  ) {
    return "演示文稿";
  }
  if (m.startsWith("image/")) return "图片";
  return "";
}

export function getFileTypeLabel(mimeType: string, name: string, sizeBytes: number): string {
  const label = typeLabel(mimeType, name);
  const ext = extUpper(name);
  const size = formatBytes(sizeBytes);

  const parts: string[] = [];
  if (label) parts.push(label);
  if (ext) parts.push(ext);
  parts.push(size);
  return parts.join(" · ");
}
