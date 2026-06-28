// 身份出站过滤(安全红线·机制兜底)。
// system prompt 里"不透露模型/防管理员绕过"是软约束,越狱一句话即破;这里在【出站文本】上做
// 确定性过滤:把模型厂商名 / 明确的模型 id / "自我标识"语境下的家族名替换成内部信息占位,
// 越狱也照样过滤。注意:这是纵深防御的一层,挡直球泄露,挡不住间接旁敲——非 100%。
//
// 精度优先(财务回答里不该误伤):
//  - 厂商名 / 带版本号的明确模型标识 → 总是替换(几乎不会出现在正常财务回答里)。
//  - 常见词型家族名(gpt/claude/gemini…) → 仅在"我是/基于/底层模型是/powered by"等自我标识
//    语境下替换,避免误伤"GPT 增长率表""克劳德咨询公司"这类正常用词。
//  - 运行时配置的具体 model id(如 deepseek-v4-flash)→ 精确替换(无歧义)。

const REPLACEMENT = "(内部信息,不便透露)";

// 厂商 / 明确模型标识:正常财务回答里基本不出现,命中即替换。
const VENDOR_AND_VERSIONED = /(anthropic|openai|deepseek(?:[-\s]?(?:v?\d[\w.]*|r1|chat|coder|reasoner))?|moonshot\s*ai?|mistral\s*ai|x\.?ai|grok-?\d?|qwen[-\s]?\d[\w.]*|通义千问|文心一言|讯飞星火|智谱\s*ai)/gi;

// 常见词型家族名:仅在自我标识语境下替换。前缀覆盖中英常见表达。
const SELF_ID = /((?:我(?:是|的底层|用的|基于|采用的?)|底层(?:是|用的?|模型(?:是|为))|(?:所用|使用的?|运行的?)模型(?:是|为)?|模型(?:是|为|叫做?)|powered\s+by|running\s+on|built\s+on|based\s+on|i['’`]?m|i\s+am)\s*[:：是]?\s*)(claude|chatgpt|gpt(?:[-\s]?[0-9.]+(?:[-\s]?(?:turbo|o|mini))?)?|gemini|llama|qwen|kimi|sonnet|opus|haiku|o[134](?:-(?:mini|preview))?)\b/gi;

/** 把出站文本里的模型身份信息替换成内部信息占位。modelId 为运行时配置的具体模型 id(可选)。 */
export function filterIdentity(text: string, modelId?: string): string {
  if (!text) return text;
  let out = text;

  // 1) 精确替换运行时 model id(无歧义,优先)
  const id = (modelId ?? "").trim();
  if (id) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), REPLACEMENT);
  }

  // 2) 厂商 / 带版本号的明确模型标识 → 总是替换
  out = out.replace(VENDOR_AND_VERSIONED, REPLACEMENT);

  // 3) 常见词型家族名 → 仅自我标识语境替换(保留前缀,替换名字部分)
  out = out.replace(SELF_ID, (_m, prefix: string) => `${prefix}${REPLACEMENT}`);

  return out;
}

// 分隔符:模型名是连续 token(deepseek-v4-flash 内部的 - 不算分隔)。只在分隔符处切下发,
// 末尾未完成的 token 留到下个 chunk,绝不把一个名字劈在两次 emit 之间(否则两半各自不匹配会漏)。
const TOKEN_SEP = /[\s,.;:!?、，。；:！？)\]}」』）】]/;

/** 流式分片过滤器:逐 chunk 过滤,但把末尾"未完成的 token"留到下次,防模型名被切在 chunk 边界漏过。
 * 回合末调用 flush() 过滤并取回残留。 */
export function createStreamingIdentityFilter(modelId?: string) {
  let buf = "";
  return {
    /** 喂入一个 chunk,返回本次可安全下发的(已过滤)文本。 */
    push(chunk: string): string {
      buf += chunk;
      let cut = -1;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (TOKEN_SEP.test(buf[i])) { cut = i; break; }
      }
      if (cut < 0) return ""; // 整段还是一个未完 token(可能是名字开头),先攒着
      const emit = buf.slice(0, cut + 1);
      buf = buf.slice(cut + 1);
      return filterIdentity(emit, modelId);
    },
    /** 回合结束:过滤并取回剩余缓冲(末尾 token 在此最终判定)。 */
    flush(): string {
      const rest = buf;
      buf = "";
      return filterIdentity(rest, modelId);
    },
  };
}
