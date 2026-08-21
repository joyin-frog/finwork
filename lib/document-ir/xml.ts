const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? `&${entity};`;
  });
}

export function textFromXml(xml: string): string {
  return decodeXml(
    xml
      .replace(/<w:tab\b[^>]*\/?\s*>/gi, "\t")
      .replace(/<w:br\b[^>]*\/?\s*>/gi, "\n")
      .replace(/<a:br\b[^>]*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/\s+/g, " ").trim();
}

export function tagBlocks(xml: string, qualifiedTag: string): string[] {
  const escaped = qualifiedTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...xml.matchAll(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi"))].map(
    (match) => match[0],
  );
}

export function attributeValue(tag: string, qualifiedName: string): string | undefined {
  const escaped = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? decodeXml(match[1] ?? "") : undefined;
}

export function encodeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Replace the text carried by an OOXML block while retaining its run/style
 * structure. The first text node receives the replacement and later text
 * nodes are emptied; callers must select the exact paragraph/shape first.
 */
export function replaceOoxmlText(block: string, qualifiedTextTag: "w:t" | "a:t", value: string): string {
  const escapedTag = qualifiedTextTag.replace(":", "\\:");
  const expression = new RegExp(`(<${escapedTag}\\b[^>]*>)([\\s\\S]*?)(<\\/${escapedTag}>)`, "gi");
  let textNodeCount = 0;
  const replaced = block.replace(expression, (_match, opening: string, _content: string, closing: string) => {
    textNodeCount += 1;
    if (textNodeCount > 1) return `${opening}${closing}`;
    const preserveSpace = /^\s|\s$/.test(value) && !/\bxml:space\s*=/.test(opening)
      ? opening.replace(/>$/, ' xml:space="preserve">')
      : opening;
    return `${preserveSpace}${encodeXmlText(value)}${closing}`;
  });
  if (textNodeCount === 0) throw new Error(`document_operation_unsupported:no_${qualifiedTextTag}_node`);
  return replaced;
}
