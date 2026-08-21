/** Normalize a knowledge-document title for stable user-facing lookup aliases. */
export function sanitizeKnowledgeDocumentName(title: string, docId: number): string {
  const cleaned = title
    .replace(/\.[a-zA-Z0-9]{1,8}$/, "")
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "")
    .trim();
  return cleaned || `doc-${docId}`;
}
