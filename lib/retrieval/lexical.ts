const WORD_PATTERN = /[\p{L}\p{N}_-]+/gu;
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;

export function normalizeRetrievalText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function lexicalTerms(value: string): string[] {
  const normalized = normalizeRetrievalText(value);
  if (!normalized) return [];
  const terms: string[] = [];
  for (const match of normalized.matchAll(WORD_PATTERN)) {
    const token = match[0];
    if (!CJK_PATTERN.test(token)) {
      if (token.length > 1 || /^\d+$/.test(token)) terms.push(token);
      continue;
    }
    const chars = Array.from(token);
    terms.push(...chars);
    for (let index = 0; index < chars.length - 1; index += 1) {
      terms.push(chars[index] + chars[index + 1]);
    }
  }
  return terms;
}

export function lexicalTermFrequency(value: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of lexicalTerms(value)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return frequencies;
}

export function lexicalOverlapScore(queryTerms: readonly string[], text: string): number {
  if (queryTerms.length === 0) return 0;
  const textTerms = new Set(lexicalTerms(text));
  const uniqueQuery = new Set(queryTerms);
  let matched = 0;
  for (const term of uniqueQuery) if (textTerms.has(term)) matched += 1;
  return matched / uniqueQuery.size;
}
