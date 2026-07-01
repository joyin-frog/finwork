import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SDKUserMessage, SDKMessage, SDKAssistantMessage, SDKPartialAssistantMessage, SDKResultSuccess, SDKCompactBoundaryMessage, ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { isEnabled } from "@/lib/runtime/flags";
import { readClaudeSettings } from "@/lib/settings/claude-settings";
import { getProjectRoot, getPythonBinDir, getPythonVenvRoot, getBundledClaudeCliPath } from "@/lib/runtime/paths";
import { buildFinanceMcpServers } from "./mcp-tools";
import { ALLOWED_TOOLS, BUILTIN_TOOLS } from "./tools/registry";
import { getSkillPluginConfig } from "./skill-plugin";
import { runBeforeHooks, runAfterHooks } from "./hooks/chain";
import {
  createAskUserQuestionHook,
  createPathSafetyHook,
  createReadGuardHook,
  createRiskConfirmHook,
  createStuckGuardHook,
  createTimingHook,
  createUnwiredToolHook,
} from "./hooks/built-in";
import { buildSystemPromptParts } from "./system-prompt";
import { isMockAgentEnabled, runMockAgent } from "./mock-agent";
import { createToolEventTracker, extractUserToolResults, type TrackedToolResult } from "./tool-event-tracker";
import { readMemoryMarkdown } from "@/lib/memory/file-store";
import { ensureConventionsMigrated } from "@/lib/memory/migrate-conventions";
import { readCompanyProfile } from "@/lib/profile/file-store";
import { writeSpan } from "@/lib/observability/spans";
import { listRecentNegativeReasons } from "@/lib/db/sqlite";

export type AgentMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentAttachment = {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  text?: string;
  storagePath?: string;
};

export type AgentQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string; preview?: string }>;
};

export type AgentRunEvent =
  | { type: "system"; subtype?: string; message: string; data?: unknown }
  | { type: "tool_use"; id?: string; name: string; input?: unknown }
  | { type: "tool_result"; toolUseId?: string; name?: string; content?: string; isError?: boolean; durationMs?: number; structured?: unknown };

export type ClaudeAgentRunOptions = {
  claudeSessionId?: string | null;
  resumeSession?: boolean;
  requestId?: string;
  attachments?: AgentAttachment[];
  outputDir?: string;
  onChunk?: (text: string) => void;
  onThinking?: (text: string) => void;
  onAgentEvent?: (event: AgentRunEvent) => void;
  resolveUserQuestion?: (question: AgentQuestion) => Promise<string>;
  signal?: AbortSignal;
  /** 路由器的模型分层结果:简单任务用更轻的模型;缺省走设置里的主模型 */
  modelOverride?: string;
  traceId?: string;
};

/**
 * 续接(resume)失败时是否值得用新 session 重试一次。
 * 仅对"疑似 session 失效"的错误、续接早期(5s 内)、且尚未重试过时重试。
 * ⚠️ 用户主动中止 / 超时(aborted)绝不重试——否则点「停止」会被当成 session 错误重跑,停不下来。
 */
export function shouldRetryStaleSession(opts: {
  errorMessage: string;
  resumeSession: boolean;
  alreadyRetried: boolean;
  elapsedMs: number;
  aborted: boolean;
}): boolean {
  if (opts.aborted) return false; // 用户主动中止 / 超时:绝不重试(否则点「停止」会被当 session 错误重跑,停不下来)
  if (!opts.resumeSession) return false;
  if (opts.alreadyRetried) return false;
  if (opts.elapsedMs > 5000) return false;
  return /abort|session|not.?found/i.test(opts.errorMessage);
}

/**
 * 决定发给 SDK 的消息列表。
 * - resume 且未重试：仅最后一条 user 消息（节省 token / 利用缓存）
 * - 重试 or 非 resume：全量历史
 */
export function pickPromptMessages(
  messages: AgentMessage[],
  opts: { resumeSession: boolean; retried: boolean }
): AgentMessage[] {
  if (opts.resumeSession && !opts.retried) {
    // 只发最后一条 user 消息；若最后一条不是 user，回退到全量
    const last = [...messages].reverse().find((m) => m.role === "user");
    return last ? [last] : messages;
  }
  return messages;
}

export async function runClaudeAgent(messages: AgentMessage[], runOptions: ClaudeAgentRunOptions = {}) {
  const requestId = runOptions.requestId ?? "unknown";
  const settings = await readClaudeSettings();
  const startedAt = Date.now();

  console.info("[claude-agent] start", {
    requestId,
    messageCount: messages.length,
    attachmentCount: runOptions.attachments?.length ?? 0,
    hasApiKey: Boolean(settings.apiKey.trim()),
    model: settings.mainModel || settings.model || "(default)",
    claudeSessionId: runOptions.claudeSessionId ?? null,
    resumeSession: Boolean(runOptions.resumeSession),
  });

  // 确定性模拟 Agent(e2e 用):置 FINANCE_AGENT_MOCK_AGENT=1 即接管,优先于真 key,
  // 让 agent 类 journey 不依赖网络/密钥也能在 CI 跑绿。见 lib/agent/mock-agent.ts。
  if (isMockAgentEnabled()) {
    return runMockAgent(messages, runOptions);
  }

  if (!settings.apiKey.trim()) {
    return {
      mode: "mock" as const,
      claudeSessionId: runOptions.claudeSessionId ?? null,
      content: "API Key 未配置，当前使用本地模拟 Agent。请在配置中心填写 API URL、API Key 和模型。",
    };
  }

  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  // skill 经 Bash 跑的 `python`/`markitdown` 默认从 PATH 解析,而 run_python 钉死用 getPythonPath();
  // 把解释器目录前置进 PATH(真 venv 再设 VIRTUAL_ENV),令二者共用同一解释器+依赖(打包态也稳)。
  const pythonVenvRoot = getPythonVenvRoot();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${getPythonBinDir()}${path.delimiter}${process.env.PATH ?? ""}`,
    ...(pythonVenvRoot ? { VIRTUAL_ENV: pythonVenvRoot } : {}),
    ANTHROPIC_BASE_URL: settings.apiUrl,
    ANTHROPIC_API_KEY: settings.apiKey,
    ANTHROPIC_MODEL: settings.mainModel || settings.model,
    CLAUDE_AGENT_SDK_CLIENT_APP: "finance-agent/0.1.0",
  };

  const chunks: string[] = [];
  const stderrLines: string[] = [];
  // resume 续接到已失效 session(SDK 报「No conversation found」)是良性的——会自动用新 session 重试。
  // 用此标记把该良性场景的日志降到 warn,避免误报为 error;真失败仍在 [claude-agent] failed 落 error。
  let staleSessionStderrSeen = false;
  // includePartialMessages 下,文本既走 stream_event 增量、又在最终 assistant 消息里整块重复出现;
  // 标记已流式过的内容,避免在 assistant 块里二次 emit(否则前端流式渲染会重复一遍)。
  let streamedText = false;
  let result = "";
  let claudeSessionId = runOptions.claudeSessionId ?? null;
  let modelUsage: Record<string, ModelUsage> | undefined;
  let totalCostUsd: number | undefined;
  let numTurns: number | undefined;
  let resultError: string | undefined;

  const abortController = new AbortController();
  if (runOptions.signal) {
    runOptions.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    if (runOptions.signal.aborted) abortController.abort();
  }
  // 慢网关上多步/多工具财务任务常 >5min,原 5min 硬超时会把复杂任务掐成空响应(golden 认证实测 complex 多条空串)。
  // 放宽到 10min:财务任务宁可慢、不可半途空手而归。简单/cheap 路径本就秒级,不受影响。
  const timeout = setTimeout(() => {
    console.error("[claude-agent] timeout", { requestId, claudeSessionId });
    abortController.abort();
  }, 600_000);

  const outputDir = runOptions.outputDir ?? path.join(tmpdir(), `finance-agent-output-${requestId}`);
  mkdirSync(outputDir, { recursive: true });

  const mcpServers = await buildFinanceMcpServers(sdk, outputDir);
  // 静态工具全集(含 Bash/Write 供 skill 脚本);不再按 skill 收敛,高风险工具经确认门兜底。
  const allowedTools = ALLOWED_TOOLS;
  const skillPlugin = await getSkillPluginConfig();

  const memoryStartedAt = Date.now();
  await ensureConventionsMigrated().catch((e) => console.warn("[claude-adapter] migration warn:", e));
  const memoryMarkdown = await readMemoryMarkdown();
  const companyProfile = await readCompanyProfile().catch(() => ({}));
  writeSpan({
    traceId: requestId,
    spanType: "memory",
    name: "memory.md",
    startedAt: memoryStartedAt,
    durationMs: Date.now() - memoryStartedAt,
    tokens: Math.round(memoryMarkdown.length / 3),
  });

  // 工具事件按 tool_use_id 配对(计时/去重统一在 tracker 内)
  const toolTracker = createToolEventTracker();

  const hookChain = [
    createUnwiredToolHook(),
    createReadGuardHook(),
    createStuckGuardHook(),
    createAskUserQuestionHook(),
    createPathSafetyHook(),
    createRiskConfirmHook(),
    createTimingHook((name, durationMs, isError) => {
      console.info("[claude-agent] tool done", { name, durationMs, isError });
    }),
  ];

  const canUseTool = async (toolName: string, input: unknown) => {
    // Always allow internal SDK meta-tools
    if (toolName === "ToolSearch" || toolName === "ExitPlanMode") {
      return { behavior: "allow" as const, updatedInput: input };
    }

    return runBeforeHooks(hookChain, {
      toolName,
      input,
      outputDir,
      resolveUserQuestion: runOptions.resolveUserQuestion,
    });
  };

  const recentNegativeFeedback = (() => {
    try { return listRecentNegativeReasons(7, 5); }
    catch { return [] as string[]; }
  })();

  const systemPromptParts = buildSystemPromptParts({
    identity: { companyName: settings.companyName, agentName: settings.agentName },
    memoryMarkdown,
    roleMode: settings.roleMode,
    recentNegativeFeedback: recentNegativeFeedback.length > 0 ? recentNegativeFeedback : undefined,
    outputDir,
    companyProfile: Object.keys(companyProfile).length > 0 ? companyProfile as Record<string, unknown> : undefined,
  });
  const systemPrompt = isEnabled("PROMPT_CACHE_ENABLED") ? systemPromptParts : systemPromptParts.join("\n");

  const claudeCliPath = getBundledClaudeCliPath();
  const options: Record<string, unknown> = {
    abortController,
    cwd: getProjectRoot(),
    env,
    // 只加载 agent 用得到的内置工具(+Skill 入口),不再发 claude_code 全预设的冗余工具定义 —— 省每回合输入 token。
    tools: [...BUILTIN_TOOLS, "Skill"],
    mcpServers,
    allowedTools,
    plugins: skillPlugin.plugins,
    skills: skillPlugin.skills,
    settingSources: skillPlugin.settingSources,
    systemPrompt,
    canUseTool,
    includePartialMessages: true,
    maxTurns: 30,
    permissionMode: "acceptEdits",
    persistSession: true,
    // SDK 子进程 stderr:汇聚后单条落 span,使路由/鉴权/网关类故障在 trace 可见
    stderr: (data: string) => {
      const text = data.trim();
      if (!text) return;
      stderrLines.push(text);
      // resume 续接到失效 session:良性,下面会自动用新 session 重试 → 降 warn;
      // 其余 stderr(路由/鉴权/网关等真问题)仍按 error。
      if (runOptions.resumeSession && /no conversation found/i.test(text)) {
        staleSessionStderrSeen = true;
        console.warn("[claude-agent] stderr(会话已过期,将用新会话重试)", { requestId, data: text.slice(0, 300) });
      } else {
        console.error("[claude-agent] stderr", { requestId, data: text.slice(0, 300) });
      }
    },
    ...(runOptions.modelOverride || settings.mainModel || settings.model
      ? { model: runOptions.modelOverride || settings.mainModel || settings.model }
      : {}),
    ...(runOptions.claudeSessionId && runOptions.resumeSession
      ? { resume: runOptions.claudeSessionId }
      : {}),
    ...(runOptions.claudeSessionId && !runOptions.resumeSession
      ? { sessionId: runOptions.claudeSessionId }
      : {}),
    // 打包态显式指向内置的原生 CLI 二进制(prepare-tauri 拷入 bin/);否则 standalone 没带平台包,
    // SDK 会报 "Native CLI binary for <plat> not found"。开发态为 null → 不传,SDK 自行解析平台包。
    ...(claudeCliPath ? { pathToClaudeCodeExecutable: claudeCliPath } : {}),
  };

  const pickedMessages = pickPromptMessages(messages, { resumeSession: Boolean(runOptions.resumeSession), retried: false });
  const promptInput = buildPromptInput(pickedMessages, runOptions.attachments ?? []);
  const queryOpts: Record<string, unknown> = options;
  const sdkQueryStartedAt = Date.now();
  let sessionRetried = false;

  async function* queryWithRetry(): AsyncGenerator<SDKMessage> {
    const typedOpts = queryOpts as Parameters<typeof sdk.query>[0]["options"];
    try {
      yield* sdk.query({ prompt: promptInput, options: typedOpts });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!shouldRetryStaleSession({
        errorMessage: msg,
        resumeSession: Boolean(runOptions.resumeSession),
        alreadyRetried: sessionRetried,
        elapsedMs: Date.now() - sdkQueryStartedAt,
        aborted: abortController.signal.aborted,
      })) {
        throw error;
      }
      console.warn("[claude-agent] session resume failed, retrying", { requestId, claudeSessionId, error: msg });
      sessionRetried = true;
      // 生成新 sessionId 避免复用失效 id
      const newSessionId = randomUUID();
      claudeSessionId = newSessionId;
      delete queryOpts.resume;
      queryOpts.sessionId = newSessionId;
      // 重试使用全量历史，确保上下文完整
      const retryPromptInput = buildPromptInput(
        pickPromptMessages(messages, { resumeSession: true, retried: true }),
        runOptions.attachments ?? []
      );
      writeSpan({
        traceId: requestId,
        spanType: "hook",
        name: "session rebuilt",
        startedAt: Date.now(),
        durationMs: 0,
        outputSummary: `new sessionId=${newSessionId}`,
      });
      yield* sdk.query({ prompt: retryPromptInput, options: typedOpts });
    }
  }

  // 两条结果通道(MCP 块 / user 消息块)共用的下游分发:span、事件、after-hooks
  const emitToolResult = (resolved: TrackedToolResult) => {
    writeSpan({
      traceId: requestId,
      spanType: "tool_call",
      name: resolved.name,
      startedAt: Date.now() - resolved.durationMs,
      durationMs: resolved.durationMs,
      inputSummary: safeJsonStringify(resolved.input),
      outputSummary: resolved.content,
      error: resolved.isError ? resolved.content : undefined,
    });

    runOptions.onAgentEvent?.({
      type: "tool_result",
      toolUseId: resolved.toolUseId,
      name: resolved.name,
      content: resolved.content,
      isError: resolved.isError,
      durationMs: resolved.durationMs,
      ...(resolved.structured !== undefined ? { structured: resolved.structured } : {}),
    });

    runAfterHooks(hookChain, {
      toolName: resolved.name,
      input: resolved.input,
      outputDir,
      result: resolved.content ?? "",
      isError: resolved.isError,
      durationMs: resolved.durationMs,
    }).catch(console.error);
  };

  const llmStartedAt = Date.now();
  try {
    for await (const message of queryWithRetry()) {
      // Session id tracking
      if ("session_id" in message && message.session_id) {
        claudeSessionId = message.session_id;
      }
      if (message.type === "result") {
        if (message.subtype === "success") {
          const success = message as SDKResultSuccess;
          result = success.result;
          modelUsage = success.modelUsage;
          totalCostUsd = success.total_cost_usd;
          numTurns = success.num_turns;
        } else {
          // 失败结果(SDK 产出失败而非抛异常):照样记账 + 留痕,别静默丢成空回答
          const errRes = message as unknown as {
            subtype: string; total_cost_usd?: number; modelUsage?: Record<string, ModelUsage>; num_turns?: number;
          };
          modelUsage = errRes.modelUsage ?? modelUsage;
          totalCostUsd = errRes.total_cost_usd ?? totalCostUsd;
          numTurns = errRes.num_turns ?? numTurns;
          resultError = `Claude 回合以「${errRes.subtype}」结束(未正常完成)`;
          // 若由 resume 失效引发(stderr 已识别):良性、会重试 → warn;其余结果失败按 error。
          if (staleSessionStderrSeen) {
            console.warn("[claude-agent] result(会话过期,将重试)", { requestId, subtype: errRes.subtype });
          } else {
            console.error("[claude-agent] result error", { requestId, subtype: errRes.subtype });
          }
        }
      }

      // System messages (init, etc.)
      if (message.type === "system") {
        if (message.subtype === "compact_boundary") {
          const meta = (message as SDKCompactBoundaryMessage).compact_metadata;
          writeSpan({
            traceId: requestId,
            spanType: "compact",
            name: `compact:${meta.trigger}`,
            startedAt: Date.now() - (meta.duration_ms ?? 0),
            durationMs: meta.duration_ms ?? 0,
            inputSummary: `pre=${meta.pre_tokens}`,
            outputSummary: meta.post_tokens != null ? `post=${meta.post_tokens}` : undefined,
            tokens: meta.pre_tokens,
          });
        }
        // 网关(尤其 GPT 兼容代理)会按思考 token 增量狂吐 system/thinking_tokens 等非标事件——
        // 单会话实测可达数千条。若无差别转发,会污染时间线、撑爆 SSE,并把 chat_agent_events 灌成
        // 几千行垃圾(DB 膨胀)。只放行对用户/审计有意义的 system 子类型,其余在源头直接丢弃。
        if (isMeaningfulSystemEvent(message.subtype)) {
          runOptions.onAgentEvent?.({
            type: "system",
            subtype: message.subtype,
            message: buildSystemEventMessage(message),
            data: message,
          });
        }
      }

      // Streaming text deltas
      if (message.type === "stream_event") {
        const evt = message.event;
        if (evt.type === "content_block_delta") {
          const delta = evt.delta;
          if (delta.type === "text_delta" && delta.text) {
            streamedText = true;
            chunks.push(delta.text);
            runOptions.onChunk?.(delta.text);
          }
          // thinking 增量不收不推:不向前端展示;模型思考能力不变
        }
      }

      // Full assistant message with content blocks
      if (message.type === "assistant") {
        const assistantMsg = message as SDKAssistantMessage;
        if (assistantMsg.error) {
          // 模型回合自带错误码(authentication_failed / billing_error / rate_limit / max_output_tokens 等)
          resultError = `模型返回错误:${assistantMsg.error}`;
          console.error("[claude-agent] assistant error", { requestId, error: assistantMsg.error });
        }
        for (const block of assistantMsg.message.content) {
          if (block.type === "text" && "text" in block && block.text && !streamedText) {
            chunks.push(block.text);
            runOptions.onChunk?.(block.text);
          }
          // thinking 块:整块上报(不收 stream_event 的 thinking_delta 增量,避免重复 + 跨片模型名漏过滤)。
          // 是否对外展示/如何脱敏由上层(route)按安全红线处理;此处只负责把完整思考文本透出。
          if (block.type === "thinking" && "thinking" in block) {
            const thinkingText = (block as { thinking?: unknown }).thinking;
            if (typeof thinkingText === "string" && thinkingText.trim()) {
              runOptions.onThinking?.(thinkingText);
            }
          }
          if (block.type === "tool_use" && "name" in block) {
            const toolUseBlock = block as { id?: string; name: string; input?: unknown };
            toolTracker.trackToolUse(toolUseBlock);
            runOptions.onAgentEvent?.({ type: "tool_use", id: toolUseBlock.id, name: toolUseBlock.name, input: toolUseBlock.input });
          }
          if (block.type === "mcp_tool_result" && "tool_use_id" in block) {
            // MCP tool result blocks from the Beta API
            const toolResultBlock = block as { tool_use_id: string; content?: unknown; is_error?: boolean; structuredContent?: unknown };
            const resolved = toolTracker.resolveToolResult(toolResultBlock);
            if (resolved) emitToolResult(resolved);
          }
        }
      }

      // 内置工具(Read/Bash/Grep/Write…)的结果以 user 消息的 tool_result 块返回
      if (message.type === "user") {
        const userMessage = message as SDKUserMessage;
        const resultBlocks = extractUserToolResults(userMessage);
        for (const resultBlock of resultBlocks) {
          // tool_use_result 顶层字段承载 MCP structuredContent;多块时归属不明,只在单块时透传
          const toolUseResult = resultBlocks.length === 1 ? userMessage.tool_use_result : undefined;
          const resolved = toolTracker.resolveToolResult(resultBlock, toolUseResult);
          if (resolved) emitToolResult(resolved);
        }
      }
    }
  } catch (error) {
    console.error("[claude-agent] failed", {
      requestId, durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  writeSpan({
    traceId: requestId,
    spanType: "llm_call",
    name: "Claude query",
    startedAt: llmStartedAt,
    durationMs: Date.now() - llmStartedAt,
    tokens: modelUsage ? Object.values(modelUsage).reduce((sum, m) => sum + m.inputTokens, 0) : undefined,
    metadata: modelUsage ? { models: Object.keys(modelUsage) } : undefined,
  });

  if (stderrLines.length) {
    writeSpan({
      traceId: requestId,
      spanType: "hook",
      name: "sdk stderr",
      startedAt: llmStartedAt,
      durationMs: Date.now() - llmStartedAt,
      error: stderrLines.join("\n").slice(-500),
    });
  }

  const content = result || chunks.join("\n").trim() || resultError || "Claude Agent 已执行，但没有返回文本结果。";
  console.info("[claude-agent] done", {
    requestId,
    durationMs: Date.now() - startedAt,
    claudeSessionId,
    contentLength: content.length,
  });

  return {
    mode: "claude" as const,
    claudeSessionId,
    content,
    modelUsage,
    totalCostUsd,
    numTurns,
    roleMode: settings.roleMode,
  };
}

/** 值得展示/落库的 system 子类型白名单。其余(thinking_tokens / status / 未知)一律在源头丢弃。 */
const MEANINGFUL_SYSTEM_SUBTYPES = new Set(["init", "compact_boundary"]);

export function isMeaningfulSystemEvent(subtype: string | undefined): boolean {
  return MEANINGFUL_SYSTEM_SUBTYPES.has(subtype ?? "");
}

function buildSystemEventMessage(raw: {
  subtype?: string;
  mcp_servers?: Array<{ name?: string; status?: string }>;
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
}) {
  if (raw.subtype === "init" && Array.isArray(raw.mcp_servers)) {
    const connected = raw.mcp_servers.filter((s) => s.status === "connected").length;
    return `环境初始化完成，MCP ${connected}/${raw.mcp_servers.length} 已连接`;
  }
  if (raw.subtype === "compact_boundary" && raw.compact_metadata) {
    const m = raw.compact_metadata;
    return `上下文已压缩（${m.trigger}）：${m.pre_tokens ?? "?"} → ${m.post_tokens ?? "?"} tokens`;
  }
  return raw.subtype ? `系统事件：${raw.subtype}` : "系统事件";
}

function safeJsonStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function buildPromptInput(messages: AgentMessage[], attachments: AgentAttachment[]): string | AsyncIterable<SDKUserMessage> {
  const attachmentBlocks = buildAttachmentBlocks(attachments);
  const lastContent = messages[messages.length - 1]?.content ?? "";
  const lastPromptText = buildPromptText(lastContent, attachments);

  if (messages.length <= 1 && !attachmentBlocks.length) {
    return lastPromptText;
  }

  return yieldMessages(messages, attachmentBlocks, lastPromptText);
}

async function* yieldMessages(
  messages: AgentMessage[],
  attachmentBlocks: Array<Record<string, unknown>>,
  lastPromptText: string
): AsyncIterable<SDKUserMessage> {
  // SDK 的 prompt 流只接受 user 角色;历史里的 assistant 轮若按原角色发出会被拒
  // ("Expected message role 'user', got 'assistant'")。这里把历史(含 assistant)
  // 压成一段 user 角色的「对话回顾」,拼到当前消息前——既合法又保住上下文。
  const history = messages.slice(0, -1);
  const recap = history.length
    ? `<对话回顾>\n${history
        .map((m) => `${m.role === "user" ? "用户" : "助手"}:${m.content}`)
        .join("\n")}\n</对话回顾>\n\n当前请求:\n`
    : "";
  const text = `${recap}${lastPromptText}`;

  if (!attachmentBlocks.length) {
    yield {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    return;
  }

  yield {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text" as const, text },
        ...attachmentBlocks,
      ] as unknown as SDKUserMessage["message"]["content"],
    },
    parent_tool_use_id: null,
  };
}

function buildPromptText(prompt: string, attachments: AgentAttachment[]) {
  if (!attachments.length) return prompt;

  const localFiles = attachments.filter((a) => a.storagePath);
  const remoteFiles = attachments.filter((a) => !a.storagePath);
  const parts: string[] = [prompt];

  if (localFiles.length) {
    const list = localFiles
      .map((f) => `- ${f.name} (${f.mimeType}, ${formatBytes(f.size)})\n  路径: ${f.storagePath}`)
      .join("\n");
    parts.push("用户上传了以下文件，已保存到本地磁盘。请使用 Read 工具直接读取文件内容，必要时使用 run_python 进行解析：\n" + list);
  }

  if (remoteFiles.length) {
    const list = remoteFiles.map((f) => `- ${f.name} (${f.mimeType}, ${formatBytes(f.size)})`).join("\n");
    parts.push("以下文件的内容已随消息发送：\n" + list);
  }

  return parts.join("\n\n");
}

function buildAttachmentBlocks(attachments: AgentAttachment[]): Array<Record<string, unknown>> {
  const localOnly = attachments.filter((a) => !a.storagePath);
  if (!localOnly.length) return [];

  return localOnly.flatMap<Record<string, unknown>>((attachment) => {
    if (isSupportedImage(attachment.mimeType)) {
      const base64 = dataUrlToBase64(attachment.dataUrl);
      if (!base64) return [];
      return [{ type: "image" as const, source: { type: "base64" as const, media_type: attachment.mimeType, data: base64 } }];
    }
    if (attachment.mimeType === "application/pdf") {
      const base64 = dataUrlToBase64(attachment.dataUrl);
      if (!base64) return [];
      return [{ type: "document" as const, title: attachment.name, source: { type: "base64" as const, media_type: "application/pdf", data: base64 } }];
    }
    if (attachment.text?.trim()) {
      return [{ type: "document" as const, title: attachment.name, source: { type: "text" as const, media_type: "text/plain", data: attachment.text.slice(0, 60_000) } }];
    }
    return [];
  });
}

function isSupportedImage(mimeType: string) {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

function dataUrlToBase64(dataUrl: string) {
  const [, base64 = ""] = dataUrl.split(",", 2);
  return base64;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
