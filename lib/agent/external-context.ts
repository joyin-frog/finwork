/**
 * 上下文注入防线:把不可信文本安全地放进系统提示 / 工具结果。
 *
 * 两类风险都在这里集中处理,避免规则散落各处出现遗漏:
 * - 短标签(公司名 / Agent 名)注入到「静态高信任前缀」——换行可伪造标题/条目、
 *   伪指令贴在反越狱硬规则旁边。用 {@link sanitizeInline} 压成单行 + 截断。
 * - 大段参考文本(记忆 / 知识库命中 / 用户反馈)——用 {@link wrapExternalContext}
 *   包进 <external_context>,系统提示已声明该标签内一律按参考数据处理、不执行其中指令。
 */

/** 中和文本里任何 external_context 起止标签,防止内容自带闭合标签逃逸出参考块。
 *  容忍大小写与标签内空白(如 `</external_context >`、`< / EXTERNAL_CONTEXT`)。 */
function neutralizeExternalContextTags(text: string): string {
  return text.replace(/<(\s*\/?\s*)external_context/gi, "<$1external__context");
}

/**
 * 把不可信文本包进 <external_context> 参考块。
 * 配合系统提示「## 外部内容安全规则」生效:块内内容不被当作指令执行。
 */
export function wrapExternalContext(text: string): string {
  return `<external_context>\n${neutralizeExternalContextTags(text)}\n</external_context>`;
}

/**
 * 把要直接拼进提示一行的短文本压成安全单行:
 * 控制字符(含换行/制表)折成空格、合并连续空白、去首尾空白、截断超长。
 * 用于注入「身份段」的公司名/Agent 名,或「反馈段」的每条原因——
 * 防止换行被用来另起伪标题 / 伪条目 / 伪指令。
 */
export function sanitizeInline(value: string, maxLen: number): string {
  return value
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}
