// 文件类型品牌识别色(Office 家族:Excel 绿 / Word 蓝 / PDF 红 / PPT 橙 / 文本灰)。
// 单一源:文件图标(file-type-icon.tsx)与预览强调色(file-preview-page.tsx)共用,
// 此前两处各维护一份、改一处易忘另一处走偏。
// 注:这是品牌识别色,不是语义 tone —— 故意不并入 tone 系统(用户靠 Office 色认文件类型)。

export type FileTypeColor = { color: string; labelColor: string };

export const FILE_TYPE_COLORS: Record<string, FileTypeColor> = {
  xls:  { color: "#43AE74", labelColor: "#329060" },
  xlsx: { color: "#43AE74", labelColor: "#329060" },
  csv:  { color: "#43AE74", labelColor: "#329060" },
  doc:  { color: "#5193DC", labelColor: "#3E7BBF" },
  docx: { color: "#5193DC", labelColor: "#3E7BBF" },
  pdf:  { color: "#F06A66", labelColor: "#DD524E" },
  ppt:  { color: "#EC7A4D", labelColor: "#D5663A" },
  pptx: { color: "#EC7A4D", labelColor: "#D5663A" },
  md:   { color: "#728195", labelColor: "#5C6A7E" },
  txt:  { color: "#828FA3", labelColor: "#69768B" },
  json: { color: "#828FA3", labelColor: "#69768B" },
  zip:  { color: "#BFA259", labelColor: "#A38845" },
};

/** 按扩展名取文件类型强调色(选中/激活/跳转高亮用);未知类型回落主色。 */
export function fileAccentColorByExt(ext: string): string {
  return FILE_TYPE_COLORS[ext]?.color ?? "var(--primary)";
}
