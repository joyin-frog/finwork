import { readClaudeSettings } from "@/lib/settings/claude-settings";
import { isMockAgentEnabled } from "./mock-agent";
import type { AgentMessage } from "./claude-adapter";
import { getDb } from "@/lib/db/sqlite";
import { redact } from "@/lib/safety/pii";

export type RouterDecision = {
  intent: "greeting" | "trivial_qa" | "rag_qa" | "tool_task" | "complex_workflow";
  directAnswer?: string;
  needsRag: boolean;
  ragQueries?: string[];
  mainModelTier: "main" | "subagent";
  reasoning: string;
};

type RouterResult = {
  decision: RouterDecision;
  path: "cheap" | "main" | "fallback";
  latencyMs: number;
};

// 网关分类调用恒带 thinking 块、实测 3–8s 且有 >8s 离群(thinking 无法被网关关闭)。
// 8s 阈值会偶发超时→退回最贵主路径(complex+RAG),把本该 cheap 直答的消息打成 30–48s。
// 放宽到覆盖 p99,显著降低"假超时退贵路径"的高频损耗。
const ROUTER_TIMEOUT_MS = 15_000;
const HISTORY_MESSAGE_LIMIT = 4;
const HISTORY_CONTENT_LIMIT = 500;

// ── Local prefilter: trivial messages that need no LLM ──────────────────────

const TRIVIAL_CANNED: Record<"greeting" | "thanks" | "farewell", string> = {
  greeting: "你好,有什么财务上的事都可以交给我。",
  thanks: "不客气,还有需要随时说。",
  farewell: "好的,有需要再找我。",
};

// 确认类:必须放行给带历史的 LLM router,不能拦截
const CONFIRM_EXACT = new Set([
  "好", "好的", "行", "可以", "是", "对", "嗯", "收到", "明白", "知道了", "确认",
  "ok", "okay",
]);

const TRIVIAL_PATTERNS: Array<{ re: RegExp; category: "greeting" | "thanks" | "farewell" }> = [
  {
    // greeting: 核心词 + 可选语气尾巴(啊/呀/哦/呢/嘛,重复)
    re: /^(?:你好|您好|哈喽|哈啰|嗨|在吗|在不在|有人吗|hi|hello|hey)[啊呀哦呢嘛~]*$/,
    category: "greeting",
  },
  {
    re: /^(?:谢谢|谢了|多谢|感谢|辛苦了|thanks|thank\s*you|thx)[啊呀哦呢嘛~了啦]*$/,
    category: "thanks",
  },
  {
    re: /^(?:再见|拜拜|bye|goodbye|先这样)[啊呀哦呢嘛~了啦]*$/,
    category: "farewell",
  },
];

/** 归一化:trim → 剥首尾标点/emoji/空白 → ASCII 转小写 */
function normalizeTrivial(message: string): string {
  // 剥掉首尾的 emoji、中英文标点、波浪号、感叹号、问号、逗号、句号等
  return message
    .trim()
    .replace(/^[\s\p{P}\p{S}！？。，~️]+|[\s\p{P}\p{S}！？。，~️]+$/gu, "")
    .toLowerCase();
}

/**
 * 本地零成本预筛:纯寒暄直接返回 RouterDecision,否则返回 null。
 * 高精度优先:宁可漏判(交给 LLM router),绝不误判(拦截真实任务/确认语)。
 */
export function matchTrivialMessage(message: string): RouterDecision | null {
  const norm = normalizeTrivial(message);

  // 空串直接跳过
  if (!norm) return null;

  // 长度上限:超过 12 字符肯定不是纯寒暄
  if (norm.length > 12) return null;

  // 确认类:显式放行,不能拦
  if (CONFIRM_EXACT.has(norm)) return null;

  for (const { re, category } of TRIVIAL_PATTERNS) {
    if (re.test(norm)) {
      return {
        intent: "greeting",
        directAnswer: TRIVIAL_CANNED[category],
        needsRag: false,
        mainModelTier: "main",
        reasoning: `local prefilter: ${category}`,
      };
    }
  }

  return null;
}

/**
 * 用 Messages API 直连做一次意图分类(JSON 文本输出,单次 HTTP)。
 * 任何失败(超时/网络/解析)都回退到"main 路径全 skills",不阻塞主流程。
 */
export async function runRouter(
  message: string,
  history: AgentMessage[],
  traceId?: string
): Promise<RouterResult> {
  const startedAt = Date.now();

  const trivial = matchTrivialMessage(message);
  if (trivial) {
    const latencyMs = Date.now() - startedAt;
    logRouterDecision(message, trivial, "cheap", latencyMs, traceId);
    return { decision: trivial, path: "cheap", latencyMs };
  }

  const fallbackDecision: RouterDecision = {
    intent: "complex_workflow",
    needsRag: true,
    mainModelTier: "main",
    reasoning: "router fallback (error or timeout)",
  };

  try {
    const settings = await readClaudeSettings();
    // mock 模式:不打真网关(确定性 / 离线 / 不耗 key),直接回退到主路径,交给模拟 Agent。
    // 问候等 trivial 短路在上面已处理,体验与真实一致。
    if (isMockAgentEnabled() || !settings.apiKey.trim()) {
      const latencyMs = Date.now() - startedAt;
      const why = isMockAgentEnabled() ? "mock agent" : "missing api key";
      logRouterDecision(message, fallbackDecision, "fallback", latencyMs, traceId, why);
      return { decision: fallbackDecision, path: "fallback", latencyMs };
    }

    // skill 选择已交给 SDK 原生 Skill 工具(模型按 listing 自行加载),
    // router 只负责意图分类 / RAG 判断 / 模型分级。
    const systemPrompt = [
      "你是一个查询路由器。分析用户最后一条消息(结合上文)并输出结构化路由决策。",
      "意图分类规则:",
      "- greeting: 打招呼、问候、无关财务的闲聊(你好、谢谢、再见)",
      "- trivial_qa: 简单事实问答,无需工具或知识库即可回答(今天日期、你是谁)",
      "- rag_qa: 需要查询知识库/政策/规定的财务问题",
      "- tool_task: 单步、直接就能完成的工具操作(查一次报销、算一次税、读取一个文件),或表达要长期遵守的规矩/偏好(需调 remember_convention 记忆)",
      "- complex_workflow: 需要多步骤 / 多工具协调,或要先分析再产出结果的任务——重设报表公式、银行对账、经营分析、多张表差异比对并产出结果表、批量算薪、改造整张 Excel 等,都归这里",
      "",
      "规则:",
      "- greeting 和 trivial_qa 必须提供 direct_answer(直接回答用户)",
      "- 表达长期遵守的规矩/偏好(如「以后报销超2000提醒我」「发薪日是10号」「报表都要带环比」)必须归 tool_task,不要当 trivial_qa/greeting——否则会被直接回答、记不进记忆",
      "- 追问/省略主语的消息按上文语境归类,不要当 greeting",
      "- rag_qa 设置 needs_rag=true 并提供 rag_queries(0-3条改写后的检索词)",
      "- 难度边界:能一两步搞定的归 tool_task;要多步/多工具来回、或先读懂再大改的归 complex_workflow(系统会自动为它升用更强的推理模型)",
      "",
      '只输出一个 JSON 对象,不要任何解释、前后缀或 markdown 代码块。字段:',
      '{"intent":"greeting|trivial_qa|rag_qa|tool_task|complex_workflow",',
      ' "direct_answer":"仅 greeting/trivial_qa 时填,直接回答用户",',
      ' "needs_rag":false,"rag_queries":[],"reasoning":"一句话"}',
    ].join("\n");

    const routerModel = settings.routerModel || "claude-haiku-4-5-20251001";
    const response = await fetch(buildMessagesUrl(settings.apiUrl), {
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: routerModel,
        max_tokens: 600,
        system: systemPrompt,
        messages: buildRouterMessages(history, message),
      }),
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`router HTTP ${response.status}`);
    }

    const decision = parseRouterResponse(await response.json());
    if (!decision) {
      throw new Error("router response missing or invalid JSON decision");
    }

    const latencyMs = Date.now() - startedAt;
    const path = decision.intent === "greeting" || decision.intent === "trivial_qa" ? "cheap" : "main";
    logRouterDecision(message, decision, path, latencyMs, traceId);
    return { decision, path, latencyMs };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn("[router] failed, falling back to main path", { error: errorMessage });
    const latencyMs = Date.now() - startedAt;
    logRouterDecision(message, fallbackDecision, "fallback", latencyMs, traceId, errorMessage);
    return { decision: fallbackDecision, path: "fallback", latencyMs };
  }
}

/** apiUrl 可能带或不带 /v1(用户用网关代理),统一拼出 /v1/messages。 */
export function buildMessagesUrl(apiUrl: string): string {
  const base = apiUrl.trim().replace(/\/+$/, "");
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

/**
 * 构造路由请求的对话片段:取最近几条、单条截断、合并连续同角色、确保首条是 user
 * (Messages API 要求 user 开头且严格交替)。
 */
export function buildRouterMessages(
  history: AgentMessage[],
  current: string
): Array<{ role: "user" | "assistant"; content: string }> {
  // 调用方传入的 history 末尾通常就是 current 本身,只去掉这一条;
  // 更早的同文本消息是合法上下文(用户可能重复追问),保留。
  const trimmedHistory = [...history];
  const lastEntry = trimmedHistory[trimmedHistory.length - 1];
  if (lastEntry?.role === "user" && lastEntry.content.trim() === current.trim()) {
    trimmedHistory.pop();
  }
  const recent = trimmedHistory
    .filter((m) => m.content.trim())
    .slice(-HISTORY_MESSAGE_LIMIT)
    .map((m) => ({ role: m.role, content: truncate(redact(m.content)) }));

  const merged: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of [...recent, { role: "user" as const, content: truncate(redact(current)) }]) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  return merged;
}

/** 解析 Messages API 响应中的 JSON 文本路由决策;缺失或字段非法返回 null(走 fallback)。 */
export function parseRouterResponse(payload: unknown): RouterDecision | null {
  if (!payload || typeof payload !== "object") return null;
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  // 拼接所有 text 块
  const rawText = content
    .filter((b): b is { type: "text"; text: string } => (
      b !== null && typeof b === "object" &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
    ))
    .map((b) => b.text)
    .join("");

  // 剥掉 markdown 围栏
  const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  // 容错:取第一个 { 到最后一个 }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonStr = stripped.slice(start, end + 1);

  let input: {
    intent?: string;
    direct_answer?: string;
    needs_rag?: unknown;
    rag_queries?: unknown;
    main_model_tier?: string;
    reasoning?: string;
  };
  try {
    input = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const intents = ["greeting", "trivial_qa", "rag_qa", "tool_task", "complex_workflow"];
  if (!input.intent || !intents.includes(input.intent)) return null;

  return {
    intent: input.intent as RouterDecision["intent"],
    directAnswer: typeof input.direct_answer === "string" ? input.direct_answer : undefined,
    needsRag: input.needs_rag === true,
    ragQueries: Array.isArray(input.rag_queries)
      ? input.rag_queries.filter((q): q is string => typeof q === "string")
      : undefined,
    mainModelTier: input.main_model_tier === "subagent" ? "subagent" : "main",
    reasoning: input.reasoning ?? "no reasoning provided",
  };
}

/** 按任务难度(router 的 intent)选模型,对齐配置页三档「快速/主/推理」:
 * - complex_workflow(多步/多工具/先分析再产出的复杂活)→ 升到「推理模型」(subagentModel)跑主 agent;
 *   router 失败兜底时 intent 也是 complex_workflow → 同样上推理模型(拿不准从严上强模型)。
 * - 其余(tool_task / rag_qa 等普通活)→ 不 override,adapter 用默认「主模型」(settings.model)。
 * - 未配推理模型则不 override。(旧实现按 main/subagent tier 选,导致简单活用强模型、复杂活用弱模型,已弃。) */
export function pickAgentModel(
  decision: { intent?: string },
  settings: { subagentModel?: string }
): string | undefined {
  return decision?.intent === "complex_workflow" && settings.subagentModel?.trim()
    ? settings.subagentModel.trim()
    : undefined;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= HISTORY_CONTENT_LIMIT ? trimmed : `${trimmed.slice(0, HISTORY_CONTENT_LIMIT)}…`;
}

function logRouterDecision(
  userMessage: string,
  decision: RouterDecision,
  path: "cheap" | "main" | "fallback",
  latencyMs: number,
  traceId?: string,
  error?: string
) {
  try {
    const db = getDb();
    // error 走 decision_json,避免改 schema;观测层可据此区分"主动 fallback"与"故障 fallback"
    const decisionJson = JSON.stringify(error ? { ...decision, _error: error } : decision);
    db.prepare(
      `INSERT INTO model_routing_log (trace_id, user_message, decision_json, path, router_latency_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).run(traceId ?? null, redact(userMessage).slice(0, 500), decisionJson, path, latencyMs);
  } catch {
    // best-effort logging
  }
}
