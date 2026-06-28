/**
 * 从 xlsx(zip)里移除会让 exceljs 崩的附加部件:表格(tables)+ 批注(comments/threadedComments/vmlDrawing),
 * 连同各 sheet 里的引用(tableParts/legacyDrawing)、对应 rels、[Content_Types] 覆盖。只去附加层,保留单元格数据。
 *
 * 背景:exceljs 读 openpyxl/Excel 生成的某些部件会抛错(数据本身没问题):
 * - 表格:value.tables 混入 undefined,set model 的 reduce 访问 .name 崩;
 * - 批注:t.comments[n.Target].comments 访问 undefined 崩;
 * - 绘图(图片/图表 charts/形状):r.anchors 访问 undefined 崩。
 * 预览只要数据,故首次加载失败时用本函数剥掉这些部件再重试(见 file-preview 的 loadExcelWorkbookResilient)。
 */
export async function sanitizeXlsxForPreview(bytes: Uint8Array): Promise<ArrayBuffer> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);

  const paths: string[] = [];
  zip.forEach((path) => paths.push(path));

  // 命名因生成工具而异(openpyxl 是 xl/comments/comment1.xml + xl/drawings/commentsDrawing1.vml,
  // 标准 Excel 是 xl/commentsN.xml + xl/drawings/vmlDrawingN.vml),故按子串匹配而非固定文件名。
  for (const p of paths) {
    if (
      /^xl\/(?:tables|drawings|charts|media|comments|threadedComments)\//i.test(p) ||
      /comment/i.test(p) ||
      /\.vml$/i.test(p)
    ) {
      zip.remove(p);
    }
  }
  for (const p of paths) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(p)) {
      const xml = await zip.file(p)!.async("string");
      const stripped = xml
        .replace(/<tableParts[\s\S]*?<\/tableParts>/gi, "")
        .replace(/<tableParts[^>]*\/>/gi, "")
        .replace(/<legacyDrawing[^>]*\/>/gi, "") // 批注的 VML 锚点
        .replace(/<drawing\b[^>]*\/>/gi, ""); //    图片/图表 绘图锚点
      if (stripped !== xml) zip.file(p, stripped);
    } else if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/i.test(p)) {
      const xml = await zip.file(p)!.async("string");
      // 删掉 Target 指向 表格 / 批注 / 绘图 / 图表 / media 的 Relationship
      const stripped = xml.replace(
        /<Relationship\b[^>]*Target="[^"]*(?:comment|\.vml|drawing|chart|\/tables?\/|\/media\/)[^"]*"[^>]*\/>/gi,
        "",
      );
      if (stripped !== xml) zip.file(p, stripped);
    }
  }
  const ct = zip.file("[Content_Types].xml");
  if (ct) {
    const xml = await ct.async("string");
    const stripped = xml
      .replace(/<Override\b[^>]*PartName="[^"]*(?:comment|drawing|chart)[^"]*"[^>]*\/>/gi, "")
      .replace(/<Override\b[^>]*PartName="[^"]*\/xl\/(?:tables|media)\/[^"]*"[^>]*\/>/gi, "")
      .replace(/<Default\b[^>]*Extension="vml"[^>]*\/>/gi, "");
    if (stripped !== xml) zip.file("[Content_Types].xml", stripped);
  }
  return zip.generateAsync({ type: "arraybuffer" });
}
