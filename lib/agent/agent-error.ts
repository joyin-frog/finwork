// 把 Agent 调用抛出的原始错误(可能含 401 / stack / 英文 SDK 文案)映射成
// 非技术财务用户看得懂的一句人话,并给出对应的恢复动作。
// - "config":配置类问题(Key/模型/鉴权),应去配置中心检查
// - "retry":瞬时问题(网络/超时/服务无响应),稍后重试即可

export type AgentErrorAction = "config" | "retry" | "continue";

export type HumanAgentError = {
  message: string;
  action: AgentErrorAction;
};

export function humanizeAgentError(raw: string | undefined | null): HumanAgentError {
  const text = (raw ?? "").toLowerCase();

  // 步数超限:不是出错,是任务一次没跑完(SDK "Reached maximum number of turns")。
  // 给「继续」动作而非「重试」——重试是从头再跑,继续是接着把剩下的做完。
  if (text.includes("maximum number of turns") || text.includes("max turns") || text.includes("number of turns")) {
    return { message: "这次任务步骤较多,没能一次跑完。可以让我接着完成剩下的部分,或把任务拆小一点再说。", action: "continue" };
  }

  // 鉴权 / Key 问题
  if (
    /\b401\b|\b403\b/.test(text) ||
    text.includes("unauthorized") ||
    text.includes("authentication") ||
    text.includes("invalid api key") ||
    text.includes("api key") ||
    text.includes("permission")
  ) {
    return { message: "API Key 鉴权没通过。请到 设置 → 模型 检查 API Key 是否填对、有没有过期。", action: "config" };
  }

  // 模型 ID / 网关地址配置问题
  if (
    /\b404\b/.test(text) ||
    text.includes("model") ||
    text.includes("not found") ||
    text.includes("base_url") ||
    text.includes("baseurl")
  ) {
    return { message: "模型或网关地址可能没配对。请到 设置 → 模型 核对模型 ID 和 API URL。", action: "config" };
  }

  // 限流
  if (/\b429\b/.test(text) || text.includes("rate limit") || text.includes("too many requests")) {
    return { message: "请求太频繁,被网关限流了。请稍等片刻再试。", action: "retry" };
  }

  // 连接中途断开:EOF / 连接重置 / 流被切断 —— 多半是网关/代理超时切断了较长的响应(或上游丢流),
  // 不是用户本地网络坏了,所以提示侧重「重试 + 调网关超时」,与下面泛化的网络分支区分开。
  if (
    text.includes("eof") ||                  // "unexpected EOF":响应流没读完就断了(最常见)
    text.includes("econnreset") ||
    text.includes("premature close") ||
    text.includes("socket hang up") ||
    text.includes("connection closed") ||
    text.includes("stream closed") ||
    text.includes("stream error")
  ) {
    return { message: "与模型网关的连接中途断开了(常见是网关/代理超时切断了较长的响应)。直接重试通常就好;若反复出现,把网关的流式/读超时调大,或换个更快的模型。", action: "retry" };
  }

  // 网络 / 超时 / 服务异常
  if (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("超时") ||
    text.includes("network") ||
    text.includes("fetch failed") ||
    text.includes("econnrefused") ||
    text.includes("econnreset") ||
    text.includes("socket") ||
    /\b50[0-9]\b/.test(text)
  ) {
    return { message: "网络不稳定或模型服务没响应。请检查网络后重试。", action: "retry" };
  }

  return { message: "处理时出了点问题,请重试;如果反复出现,到 设置 → 模型 检查配置。", action: "retry" };
}
