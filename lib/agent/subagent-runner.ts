import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { readClaudeSettings } from "@/lib/settings/claude-settings";
import { getProjectRoot, getClaudeConfigDir } from "@/lib/runtime/paths";
import { buildFinanceMcpServers } from "./mcp-tools";
import { getSkillPluginConfig } from "./skill-plugin";
import { runBeforeHooks, runAfterHooks } from "./hooks/chain";
import { createUnwiredToolHook, createPathSafetyHook, createTimingHook, createRiskConfirmHook, createSubagentBoundaryHook } from "./hooks/built-in";
import { createSdkPreToolUseHook } from "./hooks/sdk-pre-tool-use";
import { Semaphore } from "@/lib/utils/semaphore";
import { getRoleDefinition, resolveRoleAllowedTools, type RoleDefinition } from "./roles/registry";
import { BUILTIN_TOOLS, getToolRiskLevel } from "./tools/registry";
import * as _dispatchStore from "@/lib/db/dispatch-store";
import { getRoleMemoryForPrompt } from "@/lib/db/role-memory-store";
import type { AgentRuntimeEvent } from "./runtime-events";
import { getToolSummary } from "./tools/renderers";

export type SubagentTask = {
  roleId: string;
  instructions: string;
  files?: string[];
  label: string;
  /** 任务模板 id（来自 TASK_TEMPLATES）——有值时透传给 dispatch 台账 */
  taskTemplateId?: string;
  /** 业务对象标签（来自模板 objectLabel）——有值时透传给 dispatch 台账 */
  businessObject?: string;
  /** 期间，格式 YYYY-MM——有值时透传给 dispatch 台账 */
  period?: string;
  /**
   * D3·刀8: 已存在的 dispatch 行 id（status='queued' 转 running）。
   * 有值时直接复用该 id 作为 dispatchId，跳过内部二次 INSERT，
   * 防止「start 端点 CAS + runSubagent 内部落行」产生双台账行。
   */
  existingDispatchId?: number;
};

export type SubagentResult = {
  label: string;
  content: string;
  success: boolean;
  durationMs: number;
};

// 财务纪律段:派发子代理与专员会话共用(单一来源,防两份漂移)。
const FINANCE_DISCIPLINE_SECTION = `【财务纪律】
- 金额、税率、比率一律经工具计算，禁止心算；金额以分或 Decimal 处理。
- 查不到的数据明确说「没有查到」，禁止用近似值填空。
- 输出的每个关键数字带三样：来源（文件/表/发票号）、口径或期间、
  结算状态（草稿/已确认）。
- 身份证号、银行卡号不写入结果正文；需要引用时用掩码。`;

// A 段共享基座(spec-role-registry §3);技能正文不手注,经 SDK 原生 skills 白名单按需加载。
const SUBAGENT_BASE_PROMPT = `你是财务工作台的角色子代理，由主 Agent 派发执行单一任务。

【执行纪律】
- 你没有与用户对话的通道：不要提问、不要等待确认，基于给定信息尽力完成；
  信息不足时在结果中列出「缺什么、为什么需要」。
- 只做角色职责内的任务。任务超出角色边界时不要尝试完成，直接返回一行：
  out_of_scope: <一句话说明该由哪个域处理>。
- 执行域内专业作业时，先用 Skill 工具加载对应技能并遵循其流程。
- 部分高风险工具会被系统拒绝，这是设计而非故障：把已完成的准备工作
  与「待人确认的下一步」写进结果返回。

${FINANCE_DISCIPLINE_SECTION}

【交付契约】
- 回复第一段固定为【结果摘要】：关键数字 + 结论 + 异常计数。
- 异常与疑点按风险从高到低排列，每条给出定位与建议动作。
- 产出文件用 finalize_deliverable 声明。`;

// 每角色独立记忆（IA · C 刀）：把该角色沉淀的口径/约定拼进系统提示，遵守它们。
// 注：content 为用户手动输入（单用户单机产品，自输入可信）；若将来演进多租户，
// 此处需对记忆内容做提示注入防护（分隔/转义）。
function roleMemorySection(memories: string[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${m}`).join("\n");
  return `\n\n【你的记忆（该角色专属口径与约定，执行时遵守）】\n${lines}`;
}

export function buildSubagentSystemPrompt(role: RoleDefinition, memories: string[] = []): string {
  return `${SUBAGENT_BASE_PROMPT}\n\n${role.rolePrompt}${roleMemorySection(memories)}`;
}

/**
 * 专员会话系统提示（E 刀）：与派发共用 B 段 rolePrompt 与记忆段，A 段换成交互式纪律——
 * 专员可直接向用户提问、走确认卡（补上子代理不能提问的缺口），但不越职责边界、不派发。
 */
export function buildSpecialistChatSystemPrompt(role: RoleDefinition, memories: string[] = [], outputDir?: string): string {
  // 边界段：从 role.boundaries 生成提示，指引使用 propose_transfer 发转交卡
  const boundariesSection = role.boundaries.length > 0
    ? `\n\n【职责边界与转交】\n以下事项超出你的职责或数据权限，收到此类请求时说明原因，并调用 propose_transfer 工具发一张转交卡（不要硬拒，也不要尝试代做）：\n${role.boundaries.map((b) => `- ${b.cannot}（建议转交 targetRoleId="${b.transferTo}"）`).join("\n")}`
    : "";
  const base = `你是财务工作台的「${role.name}」专员（${role.domain}），正在与用户直接对话（专员会话）。

【会话纪律】
- 这是交互式会话：口径拿不准、信息缺失时直接向用户提问（多方案选择用 AskUserQuestion）；
  高风险动作系统会弹确认卡，用户拍板后才执行，不要自行跳过。
- 只做本角色职责与数据权限内的事。职责外的请求不硬拒：说明这超出你的职责/数据边界，
  调用 propose_transfer 发转交卡（系统会提示应转哪位专员），用户一键即可转交；
  无明确转交对象时建议回主管会话。
- 本会话没有派发能力：不要尝试调用其他角色或替其他域作答。
- 用户确认或纠正的、需长期遵守的本角色口径（计算规则/名单例外/流程偏好），
  静默调用 remember_role_convention 记住（roleId 固定填 "${role.id}"），回复里一句话告知即可；
  一次性拍板、数值结果不记。
- 执行域内专业作业时，先用 Skill 工具加载对应技能并遵循其流程。

${FINANCE_DISCIPLINE_SECTION}${boundariesSection}`;
  const outputSection = outputDir
    ? `\n\n【输出目录】\n生成或另存的文件保存到：${outputDir}（run_python 里用 output_dir 变量）。`
    : "";
  return `${base}\n\n${role.rolePrompt}${roleMemorySection(memories)}${outputSection}`;
}

export async function runSubagent(
  task: SubagentTask,
  opts: { parentOutputDir: string; signal?: AbortSignal; conversationId?: string; traceId?: string; onEvent?: (event: AgentRuntimeEvent, instanceId: string) => void }
): Promise<SubagentResult> {
  const startedAt = Date.now();
  const instanceId = randomUUID(); // AR2a: per-subagent-run 实例标识，随所有里程碑事件透传
  const safeLabel = task.label.replace(/[^a-zA-Z0-9_-]/g, "_") + "_" + Date.now();
  const outputDir = path.join(opts.parentOutputDir, "subagents", safeLabel);
  mkdirSync(outputDir, { recursive: true });

  // 本次任务途中被高风险工具确认门拒绝的工具名集合
  const blockedTools = new Set<string>();
  // 调度记录行 id(仅已知 roleId 时写入)
  let dispatchId: number | null = null;

  try {
    // roleId 校验必须先于 API key 检查:未知角色要报"未知角色",不能被 key 早返回吞掉
    const role = getRoleDefinition(task.roleId);
    if (!role) {
      return {
        label: task.label,
        content: `未知角色 "${task.roleId}"：请从 spawn_subagent 的 role 枚举中选择。`,
        success: false,
        durationMs: Date.now() - startedAt,
      };
    }

    // 可派发性检查：紧贴未知角色校验之后、dispatch 落行之前
    // ① 注册表预留(available:false,作业未落地)——spawn 层枚举已挡,这里独立兜底,
    //   防止未来新增的内部派发入口(如巡检)绕过 spawn 层直接调 runSubagent
    // ② 用户手动停用(app_settings)
    // 两者均不落 dispatch 台账行(编制外/未启用的活不进台账)
    if (!role.available) {
      return {
        label: task.label,
        content: `角色 "${task.roleId}"（${role.name}）尚未启用，无法执行任务。`,
        success: false,
        durationMs: Date.now() - startedAt,
      };
    }
    {
      const { getDisabledRoleIds } = await import("@/lib/agent/roles/availability");
      const disabledIds = getDisabledRoleIds();
      if (disabledIds.includes(task.roleId)) {
        return {
          label: task.label,
          content: `角色 "${task.roleId}"（${role.name}）已停用，无法执行任务。如需使用请在「智能体」页面重新启用。`,
          success: false,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    // 角色已解析 → 落调度起始行(roleId 未知时不落行)
    // existingDispatchId: D3·刀8 start 端点已 CAS queued→running，行已存在，直接复用，禁止二次 INSERT。
    if (task.existingDispatchId != null) {
      dispatchId = task.existingDispatchId;
    } else {
      try {
        dispatchId = _dispatchStore.recordDispatchStart({
          roleId: task.roleId,
          label: task.label,
          conversationId: opts.conversationId,
          traceId: opts.traceId,
          taskTemplateId: task.taskTemplateId,
          businessObject: task.businessObject,
          period: task.period,
          files: task.files,
        });
      } catch (e) {
        console.warn("[dispatch] dispatch-start 失败(不影响任务):", e);
      }
    }

    // emit start 里程碑（旁路，不影响主流程）
    opts.onEvent?.({ type: "run_started", label: task.label, roleId: task.roleId }, instanceId);

    const settings = await readClaudeSettings();

    if (!settings.apiKey.trim()) {
      const result: SubagentResult = {
        label: task.label,
        content: "Claude API Key 未配置。",
        success: false,
        durationMs: Date.now() - startedAt,
      };
      if (dispatchId != null) {
        try {
          _dispatchStore.recordDispatchEnd(dispatchId, {
            status: "failed",
            summary: result.content.slice(0, 200),
            blockedReasons: [],
          });
        } catch (e) {
          console.warn("[dispatch] dispatch-end 失败(不影响任务):", e);
        }
      }
      return result;
    }

    const allowedTools = resolveRoleAllowedTools(task.roleId);
    const skillPlugin = await getSkillPluginConfig();

    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_BASE_URL: settings.apiUrl,
      ANTHROPIC_API_KEY: settings.apiKey,
      ANTHROPIC_MODEL: settings.subagentModel || settings.model,
      CLAUDE_AGENT_SDK_CLIENT_APP: "finance-agent/0.1.0",
      // 子代理 persistSession:false 不写 transcript,但 CLI 仍会在 CLAUDE_CONFIG_DIR 写
      // .claude.json/backups 等杂项——与主 Agent 一致重定向,别漏进用户 ~/.claude。
      CLAUDE_CONFIG_DIR: getClaudeConfigDir(),
    };

    const abortController = new AbortController();
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      if (opts.signal.aborted) abortController.abort();
    }
    const timeout = setTimeout(() => abortController.abort(), 180_000);

    const mcpServers = await buildFinanceMcpServers(sdk, outputDir);

    const pendingToolCalls = new Map<string, { startTime: number; input: unknown }[]>();

    const hookChain = [
      createUnwiredToolHook(),
      createPathSafetyHook(),
      // M2·刀8: 子代理不能发起转交（没有前端渲染上下文），显式 deny。
      createSubagentBoundaryHook(),
      // 子 Agent 现在拿到的是工具全集(含算薪/金蝶等高风险),但它无人工确认通道
      // (resolveUserQuestion 为 undefined)。挂上确认门:高风险工具 → confirm → 无 resolver → deny,
      // 即高风险财务动作绝不在自主子 Agent 里静默执行(留给主 Agent 经人确认)。
      createRiskConfirmHook(),
      createTimingHook((name, durationMs, isError) => {
        console.info("[subagent] tool done", { label: task.label, name, durationMs, isError });
      }),
    ];
    const sdkPreToolUseHook = createSdkPreToolUseHook(outputDir);

    const canUseTool = async (toolName: string, input: unknown) => {
      if (toolName === "ToolSearch" || toolName === "ExitPlanMode") {
        return { behavior: "allow" as const, updatedInput: input };
      }
      const stack = pendingToolCalls.get(toolName) ?? [];
      stack.push({ startTime: Date.now(), input });
      pendingToolCalls.set(toolName, stack);
      const hookResult = await runBeforeHooks(hookChain, {
        toolName,
        input,
        outputDir,
        resolveUserQuestion: undefined,
      });
      // 捕获高风险工具被 deny 的情况 → 累入 blockedTools
      if (hookResult.behavior === "deny" && getToolRiskLevel(toolName) === "high") {
        blockedTools.add(toolName);
        // emit blocked 里程碑（旁路，不影响主流程）
        opts.onEvent?.({ type: "run_blocked", toolName, label: task.label, roleId: task.roleId, summary: "高风险动作已拦截，待主对话人工确认" }, instanceId);
      }
      return hookResult;
    };

    // 记忆加载失败（DB 锁/表缺失等）不应拖垮派发——降级为无记忆继续。
    let roleMemories: string[] = [];
    try {
      roleMemories = getRoleMemoryForPrompt(task.roleId);
    } catch (err) {
      console.warn("[subagent] 角色记忆加载失败，跳过注入：", err);
    }
    const systemPrompt = buildSubagentSystemPrompt(role, roleMemories);

    let prompt = task.instructions;
    if (task.files && task.files.length > 0) {
      prompt += `\n\n以下文件供参考：\n${task.files.map((f) => `- ${f}`).join("\n")}`;
    }

    const options: Record<string, unknown> = {
      abortController,
      cwd: getProjectRoot(),
      env,
      tools: [...BUILTIN_TOOLS, "Skill"],
      mcpServers,
      allowedTools,
      plugins: skillPlugin.plugins,
      skills: role.skills,
      settingSources: skillPlugin.settingSources,
      systemPrompt,
      canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [sdkPreToolUseHook] }],
      },
      includePartialMessages: true,
      maxTurns: 15,
      permissionMode: "acceptEdits",
      persistSession: false,
      ...(settings.subagentModel || settings.model ? { model: settings.subagentModel || settings.model } : {}),
    };

    const chunks: string[] = [];
    let result = "";
    // MCP 工具结果块只带 tool_use_id（无 name），用 tool_use 块建 id→name 映射来配对（P2 修复）
    const toolUseNamesById = new Map<string, string>();

    try {
      for await (const message of sdk.query({
        prompt,
        options: options as Parameters<typeof sdk.query>[0]["options"],
      })) {
        const raw = message as unknown as {
          type?: string;
          result?: string;
          message?: {
            content?: Array<{
              type?: string;
              text?: string;
              name?: string;
              id?: string;
              tool_use_id?: string;
              input?: unknown;
              content?: unknown;
              is_error?: boolean;
              isError?: boolean;
            }>;
          };
          event?: { type?: string; delta?: { type?: string; text?: string } };
        };

        if (raw.result) result = raw.result;

        if (raw.type === "stream_event" && raw.event) {
          const evt = raw.event;
          if (evt.delta?.type === "text_delta" && evt.delta.text) {
            chunks.push(evt.delta.text);
          }
        }

        for (const block of raw.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            chunks.push(block.text);
            continue;
          }
          if (block.type === "tool_use" && block.name && block.id) {
            toolUseNamesById.set(block.id, block.name);
            continue;
          }
          // 工具结果两种块：内置工具→tool_result（带 name）；MCP 工具→mcp_tool_result（只带 tool_use_id）。
          // 子代理主要调 MCP 工具（薪税/报销/知识等），两者都要收——否则这些步骤既不进 F1 轨道也不跑 after-hook（P2 修复）。
          let name: string | null = null;
          if (block.type === "tool_result") name = block.name ?? "";
          else if (block.type === "mcp_tool_result") name = (block.tool_use_id && toolUseNamesById.get(block.tool_use_id)) || null;
          if (name === null) continue;
          const isError = Boolean(block.is_error ?? block.isError);
          const stack = pendingToolCalls.get(name) ?? [];
          const pending = stack.shift();
          if (stack.length === 0) pendingToolCalls.delete(name);
          else pendingToolCalls.set(name, stack);
          const durationMs = pending ? Date.now() - pending.startTime : 0;
          const content =
            typeof block.content === "string"
              ? block.content
              : block.content != null
              ? JSON.stringify(block.content)
              : "";
          // emit tool 里程碑（旁路）：pending 是刚 shift() 出的局部变量，input 只喂 getToolSummary，不进事件对象
          // B3 修复：补传 label/roleId，contractToLegacyEvents 据此分组，不再回退为随机 instanceId UUID
          opts.onEvent?.({ type: "tool_completed", toolName: name, durationMs, isError, summary: getToolSummary(name, pending?.input), label: task.label, roleId: task.roleId }, instanceId);
          runAfterHooks(hookChain, {
            toolName: name,
            input: pending?.input,
            outputDir,
            result: content,
            isError,
            durationMs,
          }).catch(console.error);
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    const content = result || chunks.join("\n").trim() || "子 Agent 已执行，但没有返回文本结果。";
    const successDurationMs = Date.now() - startedAt;
    // emit done 里程碑（旁路，不夹带子代理正文）
    opts.onEvent?.({ type: "run_ended", kind: "complete", label: task.label, roleId: task.roleId, success: true, durationMs: successDurationMs }, instanceId);
    const subagentResult: SubagentResult = {
      label: task.label,
      content,
      success: true,
      durationMs: successDurationMs,
    };
    if (dispatchId != null) {
      try {
        _dispatchStore.recordDispatchEnd(dispatchId, {
          status: "success",
          summary: content.slice(0, 200),
          blockedReasons: [...blockedTools],
        });
      } catch (e) {
        console.warn("[dispatch] dispatch-end 失败(不影响任务):", e);
      }
    }
    return subagentResult;
  } catch (error) {
    const content = error instanceof Error ? error.message : String(error);
    const failDurationMs = Date.now() - startedAt;
    // emit done 里程碑（失败，旁路，不夹带子代理正文）
    opts.onEvent?.({ type: "run_ended", kind: "incomplete", label: task.label, roleId: task.roleId, success: false, durationMs: failDurationMs }, instanceId);
    const subagentResult: SubagentResult = {
      label: task.label,
      content,
      success: false,
      durationMs: failDurationMs,
    };
    if (dispatchId != null) {
      try {
        _dispatchStore.recordDispatchEnd(dispatchId, {
          status: "failed",
          summary: content.slice(0, 200),
          blockedReasons: [...blockedTools],
        });
      } catch (e) {
        console.warn("[dispatch] dispatch-end 失败(不影响任务):", e);
      }
    }
    return subagentResult;
  }
}

export async function runSubagentsParallel(
  tasks: SubagentTask[],
  opts: { parentOutputDir: string; concurrency?: number; signal?: AbortSignal; conversationId?: string; traceId?: string; onEvent?: (event: AgentRuntimeEvent, instanceId: string) => void }
): Promise<SubagentResult[]> {
  const concurrency = opts.concurrency ?? 5;
  const semaphore = new Semaphore(concurrency);

  const promises = tasks.map(async (task) => {
    const release = await semaphore.acquire();
    try {
      return await runSubagent(task, {
        parentOutputDir: opts.parentOutputDir,
        signal: opts.signal,
        conversationId: opts.conversationId,
        traceId: opts.traceId,
        onEvent: opts.onEvent,
      });
    } finally {
      release();
    }
  });

  const settled = await Promise.allSettled(promises);
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      label: tasks[i].label,
      content: r.reason instanceof Error ? r.reason.message : String(r.reason),
      success: false,
      durationMs: 0,
    };
  });
}
