/**
 * 单据文件夹自动分组:一组 = 一张凭证的全部材料。
 *
 * 规则(两种组织都支持,可混用):
 * - 一级子文件夹 → 各成一组(组内含嵌套的全部文件);适合手机拍散图,一笔一个子文件夹
 * - 根目录散文件 → 各自一组;多页 PDF(报销单+发票+回单扫一起)天然一个 PDF=一笔
 *
 * 分组由物理结构表达,不靠 AI 猜关联(金额相近的发票/回单一猜就错)。
 */

const SLIP_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".xlsx", ".xls", ".docx"]);

function isSlipFile(relPath: string): boolean {
  const base = relPath.split(/[/\\]/).pop() ?? "";
  if (!base || base.startsWith(".")) return false; // 隐藏/系统文件(.DS_Store 等)
  if (base === "Thumbs.db") return false;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return SLIP_EXTS.has(base.slice(dot).toLowerCase());
}

export type SlipGroup = { group: string; files: string[] };

/** 按物理结构分组:一级子目录各一组,根目录文件各自一组。保持出现顺序。 */
export function groupSlipFiles(relPaths: string[]): SlipGroup[] {
  const order: string[] = [];
  const byGroup = new Map<string, string[]>();
  for (const raw of relPaths) {
    if (!isSlipFile(raw)) continue;
    const parts = raw.split(/[/\\]/);
    // 有子目录 → 组名=一级目录;否则(根目录文件)→ 组名=文件名(自成一组)
    const group = parts.length > 1 ? parts[0] : raw;
    if (!byGroup.has(group)) {
      byGroup.set(group, []);
      order.push(group);
    }
    byGroup.get(group)!.push(raw);
  }
  return order.map((g) => ({ group: g, files: byGroup.get(g)! }));
}
