import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import { getModelConfigReadiness } from "@/lib/settings/model-config";
import { buildMessagesUrl } from "@/lib/agent/router";
import { runPiAgent } from "@/lib/agent/pi/agent-service";
import type { AgentMessage } from "@/lib/agent/contracts";
import { HISTORICAL_FINANCE_CASES, type HistoricalFinanceCase } from "./cases";

const SKIP_LLM = process.env.SKIP_LLM === "true";
const CASE_IDS = new Set((process.env.HISTORY_CASE_ID || "").split(",").map((s) => s.trim()).filter(Boolean));
const CASES = CASE_IDS.size === 0 ? HISTORICAL_FINANCE_CASES : HISTORICAL_FINANCE_CASES.filter((c) => CASE_IDS.has(c.id));
const FIXTURE_ROOT = path.resolve(process.env.HISTORY_FIXTURE_ROOT ?? "tests/history-eval/real-fixtures");
const USE_REAL_FIXTURES = process.env.HISTORY_REAL_FIXTURES !== "false";
const TIMEOUT_MS = Number(process.env.HISTORY_TIMEOUT_MS ?? 1_800_000);
const MAX_REPAIR_ROUNDS = Math.max(0, Math.min(5, Number(process.env.HISTORY_MAX_REPAIR_ROUNDS ?? 5)));

function mimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ({ ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pdf": "application/pdf", ".png": "image/png" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

function attachmentsFor(gc: HistoricalFinanceCase) {
  if (!USE_REAL_FIXTURES || !gc.fixtureFiles?.length) return [];
  return gc.fixtureFiles.flatMap((relative) => {
    const storagePath = path.join(FIXTURE_ROOT, relative);
    if (!existsSync(storagePath)) return [];
    return [{ name: path.basename(relative), mimeType: mimeType(relative), size: statSync(storagePath).size, dataUrl: "", storagePath }];
  });
}

function containsAny(toolCalls: string[], alternatives: string): boolean {
  return alternatives.split("|").some((name) => toolCalls.some((call) => call.includes(name)));
}

function scoreCase(gc: HistoricalFinanceCase, response: string, toolCalls: string[]) {
  const expected = gc.expectedToolCalls ?? [];
  const expectedHit = expected.length === 0 ? 1 : expected.filter((name) => containsAny(toolCalls, name)).length / expected.length;
  const forbiddenHit = (gc.mustNotCall ?? []).some((name) => toolCalls.some((call) => call.includes(name))) ? 0 : 1;
  const keywordHit = gc.mustContainKeywords.length === 0
    ? 1
    : gc.mustContainKeywords.filter((keyword) => response.includes(keyword)).length / gc.mustContainKeywords.length;
  const staticScore = expectedHit * 0.35 + forbiddenHit * 0.15 + keywordHit * 0.5;
  const toolReduction = 1 - toolCalls.length / gc.historicalToolCalls;
  return { staticScore, toolReduction, expectedHit, forbiddenHit, keywordHit };
}

async function judgeCase(gc: HistoricalFinanceCase, response: string, toolCalls: string[], settings: Awaited<ReturnType<typeof readAgentSettings>>): Promise<number | null> {
  if (SKIP_LLM || !settings.apiKey.trim()) return null;
  const prompt = [
    "你是财务工作流质量裁判，只输出 JSON: {\"score\":0到1之间的小数,\"reason\":\"一句话\"}。",
    `任务：${gc.input}`,
    `质量标准：${gc.judgeRubric}`,
    `工具调用：${toolCalls.join(", ") || "(none)"}`,
    `回答：${response.slice(0, 5000)}`,
    "重点检查是否真正完成用户目标，不要因为回答很长或工具很少而加分。",
  ].join("\n\n");
  try {
    const res = await fetch(buildMessagesUrl(settings.apiUrl), {
      method: "POST",
      headers: { "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: settings.routerModel || settings.mainModel, max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const match = text.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { score?: unknown };
    return typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : null;
  } catch {
    return null;
  }
}

async function main() {
  const settings = await readAgentSettings();
  if (!SKIP_LLM) {
    if (!settings.apiKey.trim() || !getModelConfigReadiness(settings).modelConfigReady) {
      throw new Error("历史财务评测需要完整真实模型配置；如只做结构与工具断言，请设置 SKIP_LLM=true");
    }
  }
  if (CASES.length === 0) throw new Error("没有匹配的 HISTORY_CASE_ID");

  const results = await Promise.all(CASES.map(async (gc) => {
    const toolCalls: string[] = [];
    const started = Date.now();
    const attachments = attachmentsFor(gc);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response = "";
    let error: string | undefined;
    let numTurns: number | undefined;
    let terminationReason: string | undefined;
    let repairRounds: number | undefined;
    let verificationStatus: string | undefined;
    try {
      const result = await runPiAgent({
        messages: [{ role: "user", content: attachments.length ? (gc.realInput ?? gc.input) : gc.input }] as AgentMessage[],
        requestId: randomUUID(),
        attachments,
        outputDir: path.resolve("tests/history-eval/real-reports", gc.id),
        signal: controller.signal,
        emit: (event) => {
          if (event.type === "tool_started") toolCalls.push(event.toolName);
        },
      }, { hardTimeoutMs: TIMEOUT_MS, maxRepairRounds: MAX_REPAIR_ROUNDS });
      response = result.content;
      numTurns = result.numTurns;
      terminationReason = result.terminationReason;
      repairRounds = result.repairRounds;
      verificationStatus = result.verificationStatus;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      const meta = caught as Error & {
        __repairRounds?: number;
        __verificationStatus?: string;
        __terminationReason?: string;
      };
      repairRounds = meta.__repairRounds;
      verificationStatus = meta.__verificationStatus;
      terminationReason = meta.__terminationReason;
    } finally {
      clearTimeout(timeout);
    }
    const score = scoreCase(gc, response, toolCalls);
    const judgeScore = error ? null : await judgeCase(gc, response, toolCalls, settings);
    const qualityScore = error ? 0 : judgeScore == null ? score.staticScore : score.staticScore * 0.4 + judgeScore * 0.6;
    const toolCounts = Object.fromEntries([...new Set(toolCalls)].map((tool) => [tool, toolCalls.filter((call) => call === tool).length]));
    const result = {
      id: gc.id,
      title: gc.title,
      historicalToolCalls: gc.historicalToolCalls,
      currentToolCalls: toolCalls.length,
      ...score,
      judgeScore,
      qualityScore,
      error,
      numTurns,
      terminationReason,
      repairRounds,
      verificationStatus,
      toolCounts,
      hasBash: toolCalls.includes("bash"),
      hasWrite: toolCalls.includes("write"),
      hasEdit: toolCalls.includes("edit"),
      hasFinalize: toolCalls.includes("finalize_deliverable"),
      durationMs: Date.now() - started,
    };
    console.log(`${gc.id} ${qualityScore >= 0.75 ? "PASS" : "FAIL"} quality=${qualityScore.toFixed(2)} tools=${toolCalls.length}/${gc.historicalToolCalls} reduction=${(score.toolReduction * 100).toFixed(0)}%`);
    return result;
  }));

  const qualityPass = results.filter((r) => r.qualityScore >= 0.75).length;
  const avgQuality = results.reduce((sum, r) => sum + r.qualityScore, 0) / results.length;
  const avgReduction = results.reduce((sum, r) => sum + r.toolReduction, 0) / results.length;
  console.log(JSON.stringify({
    summary: {
      total: results.length,
      qualityPass,
      avgQuality,
      avgToolReduction: avgReduction,
      skipLLM: SKIP_LLM,
      parallel: true,
      timeoutMs: TIMEOUT_MS,
      maxRepairRounds: MAX_REPAIR_ROUNDS,
      casesWithBash: results.filter((r) => r.hasBash).length,
      casesWithWrite: results.filter((r) => r.hasWrite).length,
      casesWithEdit: results.filter((r) => r.hasEdit).length,
      casesWithFinalize: results.filter((r) => r.hasFinalize).length,
      casesWithVerificationPass: results.filter((r) => r.verificationStatus === "passed").length,
    },
    results,
  }, null, 2));
  process.exit(qualityPass === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
