import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { readClaudeSettings } from "@/lib/settings/claude-settings";
import { getProjectRoot } from "@/lib/runtime/paths";
import { buildFinanceMcpServers } from "./mcp-tools";
import { getSkillPluginConfig } from "./skill-plugin";
import { runBeforeHooks, runAfterHooks } from "./hooks/chain";
import { createUnwiredToolHook, createPathSafetyHook, createTimingHook, createRiskConfirmHook } from "./hooks/built-in";
import { Semaphore } from "@/lib/utils/semaphore";
import { getRoleDefinition, resolveRoleAllowedTools, type RoleDefinition } from "./roles/registry";
import { getToolRiskLevel } from "./tools/registry";
import { recordDispatchStart, recordDispatchEnd } from "@/lib/db/dispatch-store";

export type SubagentTask = {
  roleId: string;
  instructions: string;
  files?: string[];
  label: string;
};

export type SubagentResult = {
  label: string;
  content: string;
  success: boolean;
  durationMs: number;
};

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

【财务纪律】
- 金额、税率、比率一律经工具计算，禁止心算；金额以分或 Decimal 处理。
- 查不到的数据明确说「没有查到」，禁止用近似值填空。
- 输出的每个关键数字带三样：来源（文件/表/发票号）、口径或期间、
  结算状态（草稿/已确认）。
- 身份证号、银行卡号不写入结果正文；需要引用时用掩码。

【交付契约】
- 回复第一段固定为【结果摘要】：关键数字 + 结论 + 异常计数。
- 异常与疑点按风险从高到低排列，每条给出定位与建议动作。
- 产出文件用 finalize_deliverable 声明。`;

export function buildSubagentSystemPrompt(role: RoleDefinition): string {
  return `${SUBAGENT_BASE_PROMPT}\n\n${role.rolePrompt}`;
}

export async function runSubagent(
  task: SubagentTask,
  opts: { parentOutputDir: string; signal?: AbortSignal }
): Promise<SubagentResult> {
  const startedAt = Date.now();
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

    // 角色已解析 → 落调度起始行(roleId 未知时不落行)
    try {
      dispatchId = recordDispatchStart({
        roleId: task.roleId,
        label: task.label,
      });
    } catch (e) {
      console.warn("[dispatch] recordDispatchStart 失败(不影响任务):", e);
    }

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
          recordDispatchEnd(dispatchId, {
            status: "failed",
            summary: result.content.slice(0, 200),
            blockedReasons: [],
          });
        } catch (e) {
          console.warn("[dispatch] recordDispatchEnd 失败(不影响任务):", e);
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
      // 子 Agent 现在拿到的是工具全集(含算薪/金蝶等高风险),但它无人工确认通道
      // (resolveUserQuestion 为 undefined)。挂上确认门:高风险工具 → confirm → 无 resolver → deny,
      // 即高风险财务动作绝不在自主子 Agent 里静默执行(留给主 Agent 经人确认)。
      createRiskConfirmHook(),
      createTimingHook((name, durationMs, isError) => {
        console.info("[subagent] tool done", { label: task.label, name, durationMs, isError });
      }),
    ];

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
      }
      return hookResult;
    };

    const systemPrompt = buildSubagentSystemPrompt(role);

    let prompt = task.instructions;
    if (task.files && task.files.length > 0) {
      prompt += `\n\n以下文件供参考：\n${task.files.map((f) => `- ${f}`).join("\n")}`;
    }

    const options: Record<string, unknown> = {
      abortController,
      cwd: getProjectRoot(),
      env,
      tools: { type: "preset", preset: "claude_code" },
      mcpServers,
      allowedTools,
      plugins: skillPlugin.plugins,
      skills: role.skills,
      settingSources: skillPlugin.settingSources,
      systemPrompt,
      canUseTool,
      includePartialMessages: true,
      maxTurns: 15,
      permissionMode: "acceptEdits",
      persistSession: false,
      ...(settings.subagentModel || settings.model ? { model: settings.subagentModel || settings.model } : {}),
    };

    const chunks: string[] = [];
    let result = "";

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
          }
          if (block.type === "tool_result") {
            const name = block.name ?? "";
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
      }
    } finally {
      clearTimeout(timeout);
    }

    const content = result || chunks.join("\n").trim() || "子 Agent 已执行，但没有返回文本结果。";
    const subagentResult: SubagentResult = {
      label: task.label,
      content,
      success: true,
      durationMs: Date.now() - startedAt,
    };
    if (dispatchId != null) {
      try {
        recordDispatchEnd(dispatchId, {
          status: "success",
          summary: content.slice(0, 200),
          blockedReasons: [...blockedTools],
        });
      } catch (e) {
        console.warn("[dispatch] recordDispatchEnd 失败(不影响任务):", e);
      }
    }
    return subagentResult;
  } catch (error) {
    const content = error instanceof Error ? error.message : String(error);
    const subagentResult: SubagentResult = {
      label: task.label,
      content,
      success: false,
      durationMs: Date.now() - startedAt,
    };
    if (dispatchId != null) {
      try {
        recordDispatchEnd(dispatchId, {
          status: "failed",
          summary: content.slice(0, 200),
          blockedReasons: [...blockedTools],
        });
      } catch (e) {
        console.warn("[dispatch] recordDispatchEnd 失败(不影响任务):", e);
      }
    }
    return subagentResult;
  }
}

export async function runSubagentsParallel(
  tasks: SubagentTask[],
  opts: { parentOutputDir: string; concurrency?: number; signal?: AbortSignal }
): Promise<SubagentResult[]> {
  const concurrency = opts.concurrency ?? 5;
  const semaphore = new Semaphore(concurrency);

  const promises = tasks.map(async (task) => {
    const release = await semaphore.acquire();
    try {
      return await runSubagent(task, { parentOutputDir: opts.parentOutputDir, signal: opts.signal });
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
