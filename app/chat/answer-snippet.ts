/**
 * extractAnswerSnippet — 从 ask_user_answered 的 answer 字段提取摘要文字。
 *
 * - 空串 / 空白 → null
 * - JSON 对象（多问）→ 各答案值以「·」连接，截断到 40 字
 * - 普通字符串 → 直接截断到 40 字
 *
 * 不依赖 React,可在 Node.js 环境直接导入测试。
 */
export function extractAnswerSnippet(answer: string): string | null {
  if (!answer || !answer.trim()) return null;

  const MAX_LEN = 40;

  // 尝试解析为 JSON 对象（多问格式）
  const t = answer.trim();
  if (t.startsWith("{")) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const values = Object.values(obj)
          .filter((v) => typeof v === "string" && (v as string).trim())
          .map((v) => (v as string).trim());
        if (values.length > 0) {
          const joined = values.join(" · ");
          return joined.length > MAX_LEN ? joined.slice(0, MAX_LEN) + "…" : joined;
        }
      }
    } catch {
      // 解析失败,降级为普通字符串
    }
  }

  // 普通字符串：直接截断
  const plain = answer.trim();
  return plain.length > MAX_LEN ? plain.slice(0, MAX_LEN) + "…" : plain;
}
