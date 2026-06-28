// Remark plugin: replaces file name occurrences in text nodes with finance-file:// links.
// Because this runs on the mdast (markdown AST), text inside `code` and `inlineCode`
// nodes is never visited — those node types have no children to recurse into.

export type FileRef = {
  name: string;
  storagePath: string;
};

type TextNode = { type: "text"; value: string };
type LinkNode = { type: "link"; url: string; title: null; children: TextNode[] };
type AstNode = { type: string; value?: string; children?: AstNode[] };

export function remarkFinanceFileLinks(files: FileRef[]) {
  const linkable = files
    .filter((f) => f.storagePath && f.name)
    .sort((a, b) => b.name.length - a.name.length);

  if (!linkable.length) return () => {};

  return (tree: AstNode) => {
    walkParents(tree, (child, parent, index) => {
      if (child.type === "link") return "skip";
      if (child.type !== "text" || typeof child.value !== "string") return;
      const segments = splitByFiles(child.value, linkable);
      if (segments.length === 1 && typeof segments[0] === "string") return;

      const nodes = segments.map((seg): AstNode =>
        typeof seg === "string"
          ? ({ type: "text", value: seg } as TextNode)
          : ({
              type: "link",
              url: `finance-file://${encodeURIComponent(seg.storagePath)}`,
              title: null,
              children: [{ type: "text", value: seg.name }],
            } as LinkNode)
      );

      parent.children!.splice(index, 1, ...nodes);
      return nodes.length - 1; // index offset for the splice
    });
  };
}

// Walk the tree, calling fn for every child. fn may return an index offset (for splice).
function walkParents(
  node: AstNode,
  fn: (child: AstNode, parent: AstNode, index: number) => number | "skip" | void
) {
  if (!node.children) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const offset = fn(child, node, i);
    if (typeof offset === "number") {
      i += offset;
    } else if (offset === "skip") {
      continue;
    } else if (child.children) {
      walkParents(child, fn);
    }
  }
}

type Segment = string | FileRef;

function splitByFiles(text: string, files: FileRef[]): Segment[] {
  let segments: Segment[] = [text];

  for (const file of files) {
    const next: Segment[] = [];
    for (const seg of segments) {
      if (typeof seg !== "string") {
        next.push(seg);
        continue;
      }
      const parts = seg.split(file.name);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) next.push(parts[i]);
        if (i < parts.length - 1) next.push(file);
      }
    }
    segments = next;
  }

  return segments;
}
