import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { readClaudeSettings } from "@/lib/settings/claude-settings";
import { getProjectRoot } from "@/lib/runtime/paths";
import { buildFinanceMcpServers } from "./mcp-tools";
import { ALLOWED_TOOLS } from "./tools/registry";
import { getSkillPluginConfig } from "./skill-plugin";
import { runBeforeHooks, runAfterHooks } from "./hooks/chain";
import { createUnwiredToolHook, createPathSafetyHook, createTimingHook, createRiskConfirmHook } from "./hooks/built-in";
import { Semaphore } from "@/lib/utils/semaphore";

export type SubagentTask = {
  skill: string;
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

function buildSubagentSystemPrompt(skillId: string): string {
  // skill 正文不再手注;子 Agent 经 SDK 原生 skills:[skillId] 按需加载对应 skill。
  return [
    `你是一个专注于 ${skillId} 任务的子 Agent。`,
    `遇到该任务时,用 Skill 工具加载并遵循 ${skillId} 技能的指令。`,
    "主 Agent 已完成前置确认，你只需执行分配的任务并返回结构化结果。",
    "不要询问用户任何问题，根据现有信息尽力完成任务。",
    "任务完成后，在回复开头用【结果摘要】标记关键数字和结论。",
  ].join("\n\n");
}

export async function runSubagent(
  task: SubagentTask,
  opts: { parentOutputDir: string; signal?: AbortSignal }
): Promise<SubagentResult> {
  const startedAt = Date.now();
  const safeLabel = task.label.replace(/[^a-zA-Z0-9_-]/g, "_") + "_" + Date.now();
  const outputDir = path.join(opts.parentOutputDir, "subagents", safeLabel);
  mkdirSync(outputDir, { recursive: true });

  try {
    const settings = await readClaudeSettings();

    if (!settings.apiKey.trim()) {
      return {
        label: task.label,
        content: "Claude API Key 未配置。",
        success: false,
        durationMs: Date.now() - startedAt,
      };
    }

    const allowedTools = ALLOWED_TOOLS;
    const skillPlugin = getSkillPluginConfig();

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
      return runBeforeHooks(hookChain, {
        toolName,
        input,
        outputDir,
        resolveUserQuestion: undefined,
      });
    };

    const systemPrompt = buildSubagentSystemPrompt(task.skill);

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
      skills: [task.skill],
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
    return {
      label: task.label,
      content,
      success: true,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      label: task.label,
      content: error instanceof Error ? error.message : String(error),
      success: false,
      durationMs: Date.now() - startedAt,
    };
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
