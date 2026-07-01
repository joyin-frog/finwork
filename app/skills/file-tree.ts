/** /skills 编辑器的纯逻辑:扁平文件列表 → 折叠文件树,以及技能搜索过滤。无 DOM 依赖,便于单测。 */

export type FlatEntry = { path: string; isDir: boolean };

export type FileTreeNode = {
  /** 该层段名(如 "scripts"、"run.py") */
  name: string;
  /** 完整相对路径(如 "scripts/run.py") */
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
};

/**
 * 把后端返回的扁平条目(含目录与文件)建成嵌套树:
 * - 按 "/" 分段;沿途的中间段一律视为目录(即使扁平列表里没显式列出)。
 * - 显式目录条目与作为前缀的隐式目录自动去重。
 * - 每层排序:目录在前、文件在后,同类按名字字母序。
 */
export function buildFileTree(entries: FlatEntry[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const byPath = new Map<string, FileTreeNode>();

  const ensure = (path: string, isDir: boolean): FileTreeNode => {
    const existing = byPath.get(path);
    if (existing) {
      // 已存在:若本次确认它是目录,补正(隐式目录先建、后遇显式目录条目)。
      if (isDir) existing.isDir = true;
      return existing;
    }
    const segments = path.split("/");
    const name = segments[segments.length - 1];
    const node: FileTreeNode = { name, path, isDir, children: [] };
    byPath.set(path, node);
    if (segments.length === 1) {
      roots.push(node);
    } else {
      const parentPath = segments.slice(0, -1).join("/");
      const parent = ensure(parentPath, true); // 中间段必为目录
      parent.children.push(node);
    }
    return node;
  };

  for (const e of entries) ensure(e.path, e.isDir);

  const sortRec = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** 扩展名 → highlight.js 语言名;用于把代码文件(.py 等)按代码块渲染。未知扩展名返回 null。 */
const EXT_LANG: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", jsx: "jsx", json: "json",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini",
  xml: "xml", html: "xml", xsd: "xml",
  css: "css", sql: "sql", rb: "ruby", go: "go", rs: "rust",
  java: "java", c: "c", h: "c", cpp: "cpp", md: "markdown",
};

export function fileLang(path: string): string | null {
  const i = path.lastIndexOf(".");
  if (i < 0) return null;
  return EXT_LANG[path.slice(i + 1).toLowerCase()] ?? null;
}

/** 按名字或描述过滤技能(忽略大小写);空查询返回全部。 */
export function filterSkills<T extends { name: string; description: string }>(skills: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
}
