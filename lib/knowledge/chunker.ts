/**
 * WP12: 文本切块——段落边界优先，约 400 字窗口 / 80 字重叠。
 * 纯函数，无 I/O，便于单测。
 */

const WINDOW = 400; // 目标 chunk 字符数
const OVERLAP = 80; // 相邻 chunk 重叠字符数

/**
 * 将文本切成若干 chunk。
 * - 优先按段落边界（连续换行）切；每个段落组不超过 WINDOW 字符。
 * - 段落本身超过 WINDOW 字符时按 WINDOW 强制截断（不细分句子）。
 * - 相邻 chunk 末尾 OVERLAP 字符进入下一 chunk 开头（语义连贯性）。
 * - 空文本返回 []；全文不足 WINDOW 字符返回单个 chunk。
 */
export function chunkText(text: string): string[] {
  if (!text.trim()) return [];

  // 按段落（≥1 个空行）分段
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    // 段落本身就超长：先存已攒的，再按 WINDOW 切段落
    if (para.length > WINDOW) {
      if (current.trim()) {
        pushChunks(chunks, current);
        current = "";
      }
      // 强制按 WINDOW 切
      let pos = 0;
      while (pos < para.length) {
        const slice = para.slice(pos, pos + WINDOW);
        pushChunks(chunks, slice);
        pos += WINDOW - OVERLAP;
      }
      // 把最后一块末 OVERLAP 字符作为下个 chunk 的开头（重叠衔接）
      const last = para.slice(Math.max(0, para.length - OVERLAP));
      current = last;
      continue;
    }

    // 追加段落后不超限
    const candidate = current ? current + "\n\n" + para : para;
    if (candidate.length <= WINDOW) {
      current = candidate;
    } else {
      // 超限：先存 current，再把 current 末 OVERLAP 字符 + 新段落重新攒
      if (current.trim()) {
        pushChunks(chunks, current);
        const tail = current.slice(Math.max(0, current.length - OVERLAP));
        current = tail + "\n\n" + para;
      } else {
        current = para;
      }
    }
  }

  if (current.trim()) {
    pushChunks(chunks, current);
  }

  return chunks;
}

function pushChunks(chunks: string[], text: string): void {
  const t = text.trim();
  if (t) chunks.push(t);
}
