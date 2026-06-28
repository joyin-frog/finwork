import { readClaudeSettings } from "@/lib/settings/claude-settings";
import { buildMessagesUrl } from "@/lib/agent/router";

const TITLE_TIMEOUT_MS = 10_000;

/**
 * 净化 LLM 返回的原始标题:去 markdown、去引号标点、折叠空白、截断到 ≤12 中文字符。
 * 纯函数,可单独单测。
 */
export function sanitizeTitle(raw: string): string | null {
  let s = raw
    // 去 markdown 标题标记
    .replace(/^#{1,6}\s*/gm, "")
    // 去加粗/斜体/行内代码
    .replace(/[*_`]/g, "")
    // 去各种引号(中英文全半角)
    .replace(/["""''《》「」『』【】【】〈〉]/g, "")
    // 去首尾常见标点及符号
    .replace(/^[\s,.。,、;；:：!！?？\-—–()\[\]{}#@]+|[\s,.。,、;；:：!！?？\-—–()\[\]{}#@]+$/g, "")
    // 折叠内部多余空白
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return null;

  // 截断:按 Unicode 码点数(对中文每字 = 1 点),保留 ≤12 个码点
  const points = [...s];
  if (points.length > 12) {
    s = points.slice(0, 12).join("");
  }

  return s || null;
}

/**
 * 调便宜档模型异步生成 ≤12 字对话总结标题。
 * - SKIP_LLM 环境变量为真时立即返回 null(CI/测试无网)。
 * - 无 API Key、网络错误、模型空输出 → 返回 null(红线 4:不编造)。
 */
export async function generateConversationTitle(
  firstUserMsg: string,
  firstAnswer: string,
): Promise<string | null> {
  // CI / 单测跳过
  if (process.env.SKIP_LLM) return null;

  let settings: Awaited<ReturnType<typeof readClaudeSettings>>;
  try {
    settings = await readClaudeSettings();
  } catch {
    return null;
  }

  if (!settings.apiKey.trim()) return null;

  // 与 router.ts 保持同一 cheap 档模型与网关
  const model = settings.routerModel || "claude-haiku-4-5-20251001";
  const url = buildMessagesUrl(settings.apiUrl);

  const systemPrompt =
    "你是对话标题生成器。只输出一行标题,不要任何标点、引号、前后缀,不要换行。";
  const userPrompt = [
    "为下面这段财务对话起一个不超过 12 个字的中文总结标题。",
    "只输出标题本身,不要任何标点、引号、前后缀。",
    "",
    `用户: ${firstUserMsg.slice(0, 300)}`,
    "",
    `助手: ${firstAnswer.slice(0, 500)}`,
  ].join("\n");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const text = data.content?.find((b) => b.type === "text")?.text ?? "";
    return sanitizeTitle(text);
  } catch {
    return null;
  }
}
